import os
import re
import time

from app import flow, generate, llm, memory, profile as profiles, session, tools
from app.llm import NeedsKey, Stopped

MAX_ROUNDS = int(os.environ.get("MAX_TOOL_ROUNDS", "8"))
SHORT_RE = re.compile(
    r"(коротк\w*(?:\s+\S+){0,3}\s+тз|на\s+1\s+страниц|на\s+одну\s+страниц|в\s+одну\s+страниц|one[\s-]?page)",
    re.IGNORECASE,
)

FINISH_TOOL = {
    "name": "finish_turn",
    "description": (
        "Завершить ход: спросить автора, предложить каркас или адаптацию похожего ТЗ, "
        "сгенерировать черновик, пересобрать один раздел или задать один вопрос по разделу."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": [
                    "ask",
                    "propose_skeleton",
                    "propose_adaptation",
                    "generate_draft",
                    "rebuild_section",
                    "ask_section",
                ],
            },
            "message": {"type": "string"},
            "reason": {"type": "string"},
            "skeleton_id": {"type": "string"},
            "section_id": {"type": "string"},
            "spec_id": {"type": "string"},
        },
        "required": ["action", "message"],
    },
}

SYSTEM_PROMPT = """
Ты ведёшь одну спецификацию. Сам решаешь следующий ход и вызываешь только объявленные инструменты.
Сервер исполняет инструменты и проверяет форму ответа. Писать в git нельзя.

Правила:
- Простая локальная фича без внешних интеграций: не задавай вопросы, в reason объясни почему, и переходи к generate_draft, если каркас уже выбран.
- Если автор просит задать вопросы, задай их, даже если фича кажется простой.
- Если search_similar_specs нашёл близкое ТЗ, finish_turn action propose_adaptation и дождись автора. Не подменяй документ сам.
- Каркас предлагай через finish_turn action propose_skeleton. Если в сообщении уже есть кандидаты, не вызывай suggest_skeleton: возьми skeleton_id оттуда и message вида «для этой фичи лучше подойдёт каркас X, потому что…».
- Если каркас уже выбран, не предлагай новый без просьбы автора.
- Сжатие длинных требований сервер делает сам перед черновиком. Не вызывай compress_requirements.
- extract_from_pdf вызывай только если у файла ещё нет извлечённого текста. Чужие file_id не выдумывай.
- get_project_context только читает. Если репозиторий не подключён, спроси автора, подключать ли его.
- Просьба прислать файлы — это finish_turn action ask, не инструмент.
- После появления черновика не переписывай документ целиком. Замечание по разделу — rebuild_section с section_id этого раздела, либо один ask_section.
- Не вызывай finish_turn в одном ответе вместе с другими инструментами.
""".strip()


def wants_short(text: str) -> bool:
    return bool(SHORT_RE.search(text or ""))


def _trim(value, limit: int = 2500):
    raw = value if isinstance(value, str) else str(value)
    if len(raw) <= limit:
        return raw
    return raw[:limit] + "…"


def build_messages(session_id: str) -> list[dict]:
    record = session.get_session(session_id)
    profile = profiles.get_profile(record["profile_id"]) if record else None
    preamble, dialog = memory.prompt_parts(session_id, profile, record)
    if record and "skeleton" not in memory.working_items(session_id):
        suggested = tools.suggest_skeleton(session_id, record["feature"])
        preamble += (
            "\nКандидаты каркаса уже посчитаны. Не вызывай suggest_skeleton. "
            + _trim(suggested, 2500)
        )
    if memory.working_items(session_id).get("outline"):
        preamble += "\nДальше меняй только тот раздел, о котором говорит автор."
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": preamble},
    ]
    for item in dialog:
        messages.append({"role": item["role"], "content": item["text"]})
    return messages


def apply_short_skeleton(session_id: str) -> None:
    snapshots = session.list_snapshots(session_id)
    author = [item for item in snapshots if item["kind"] == "author_message"]
    if not author:
        feature = session.get_session(session_id)["feature"]
        if not wants_short(feature):
            return
        anchor_id = None
    else:
        last = author[-1]
        if not wants_short(last["payload"].get("text", "")):
            return
        anchor_id = last["id"]
    for item in snapshots:
        if item["kind"] != "skeleton_current" or not item["payload"].get("immediate"):
            continue
        if anchor_id is None or item["id"] > anchor_id:
            return
    previous = session.current_skeleton(session_id)
    skeleton = tools.short_skeleton()
    turn_id = session.new_turn()
    session.add_snapshot(
        session_id,
        turn_id,
        "decision",
        {"text": "Автор просит короткое ТЗ на одну страницу. Каркас заменён сразу.", "immediate": True},
    )
    session.add_snapshot(
        session_id,
        turn_id,
        "skeleton_current",
        {"skeleton": skeleton, "immediate": True, "previous": previous},
    )
    record = session.get_session(session_id)
    profiles.update_skeleton(record["profile_id"], skeleton)
    try:
        flow.transition(session_id, "approved")
    except flow.IllegalTransition:
        pass


def _candidates(session_id: str) -> list[dict]:
    for snap in reversed(session.list_snapshots(session_id)):
        if snap["kind"] == "tool_result" and snap["payload"].get("name") == "suggest_skeleton":
            return snap["payload"].get("result", {}).get("candidates") or []
    return []


def _pick_candidate(session_id: str, skeleton_id: str | None) -> dict:
    candidates = _candidates(session_id)
    if not candidates:
        fresh = tools.suggest_skeleton(session_id, session.get_session(session_id)["feature"])
        candidates = fresh["candidates"]
    if skeleton_id:
        for candidate in candidates:
            if candidate.get("id") == skeleton_id:
                return candidate
    for preferred in ("profile", "short", "standard"):
        for candidate in candidates:
            if candidate.get("id") == preferred:
                return candidate
    return candidates[0]


async def apply_finish(session_id: str, arguments: dict, turn_id: str, usage: dict) -> str:
    action = arguments.get("action") or "ask"
    message = (arguments.get("message") or "").strip() or "Нужно уточнение."
    reason = (arguments.get("reason") or "").strip()
    if action == "propose_skeleton":
        if not flow.can(flow.stage_of(session_id), "plan"):
            session.add_snapshot(
                session_id,
                turn_id,
                "agent_message",
                {"text": "Каркас уже утверждён. Новый этап сам не открою.", "action": "ask"},
            )
            session.set_phase(session_id, "paused")
            return "paused"
        flow.transition(session_id, "plan")
        chosen = _pick_candidate(session_id, arguments.get("skeleton_id"))
        session.add_snapshot(
            session_id,
            turn_id,
            "skeleton_proposal",
            {
                "message": message,
                "reason": reason,
                "chosen_id": chosen.get("id"),
                "skeleton": chosen,
                "candidates": _candidates(session_id) or [chosen],
            },
        )
        session.set_phase(session_id, "paused")
        return "paused"
    if action == "propose_adaptation":
        session.add_snapshot(
            session_id,
            turn_id,
            "agent_message",
            {
                "text": message,
                "action": "propose_adaptation",
                "reason": reason,
                "spec_id": arguments.get("spec_id") or "",
            },
        )
        session.set_phase(session_id, "paused")
        return "paused"
    if action == "generate_draft":
        if not flow.can(flow.stage_of(session_id), "draft"):
            if session.current_skeleton(session_id) is None:
                uploaded = tools.file_skeletons(session_id)
                if len(uploaded) == 1 and flow.can(flow.stage_of(session_id), "plan"):
                    chosen = uploaded[0]
                    flow.transition(session_id, "plan")
                    session.add_snapshot(
                        session_id,
                        turn_id,
                        "skeleton_proposal",
                        {
                            "message": message or f"Каркас из файла {chosen['title']}. Примите его или поправьте.",
                            "reason": reason,
                            "chosen_id": chosen["id"],
                            "skeleton": chosen,
                            "candidates": uploaded,
                        },
                    )
                    session.set_phase(session_id, "paused")
                    return "paused"
            session.add_snapshot(
                session_id,
                turn_id,
                "agent_message",
                {"text": flow.DRAFT_BLOCKED, "action": "ask"},
            )
            session.set_phase(session_id, "paused")
            return "paused"
        if session.current_skeleton(session_id) is None:
            session.add_snapshot(
                session_id,
                turn_id,
                "agent_message",
                {"text": "Сначала нужен каркас. Примите предложенный или пришлите свой.", "action": "ask"},
            )
            session.set_phase(session_id, "paused")
            return "paused"
        if reason:
            session.add_snapshot(session_id, turn_id, "decision", {"text": reason})
        await _compress_long_requirements(session_id, turn_id, usage)
        produced = await generate.draft_document(session_id, usage)
        for section in produced["document"]["sections"]:
            session.add_snapshot(
                session_id,
                turn_id,
                "section_version",
                {"section": section, "revision": 1, "marks": produced["marks"]},
            )
        session.add_snapshot(
            session_id,
            turn_id,
            "agent_message",
            {"text": message, "action": "generate_draft", "reason": reason},
        )
        flow.transition(session_id, "draft")
        session.set_phase(session_id, "paused")
        return "paused"
    if action in {"rebuild_section", "ask_section"}:
        section_id = arguments.get("section_id") or ""
        if flow.stage_of(session_id) not in {"draft", "validated"}:
            session.add_snapshot(
                session_id,
                turn_id,
                "agent_message",
                {"text": "Сначала нужен черновик.", "action": "ask"},
            )
            session.set_phase(session_id, "paused")
            return "paused"
        if action == "ask_section":
            session.add_snapshot(
                session_id,
                turn_id,
                "agent_message",
                {"text": message, "action": "ask_section", "section_id": section_id, "reason": reason},
            )
            session.set_phase(session_id, "paused")
            return "paused"
        current = next(
            (item for item in session.latest_sections(session_id) if item["id"] == section_id),
            None,
        )
        title = (current or {}).get("title") or section_id or "раздел"
        author = next(
            (item for item in reversed(session.list_snapshots(session_id)) if item["kind"] == "author_message"),
            None,
        )
        filled = None
        if current is not None and author is not None:
            filled = generate.answered_section(current, author["payload"].get("text") or "", str(author["id"]))
        if filled is not None:
            updated, matched = filled
            session.add_snapshot(
                session_id,
                turn_id,
                "section_version",
                {"section": updated, "marks": []},
            )
            session.add_snapshot(
                session_id,
                turn_id,
                "agent_message",
                {
                    "text": f"В разделе «{title}» записаны ответы: {matched}.",
                    "action": "rebuild_section",
                    "section_id": section_id,
                    "section_title": title,
                },
            )
            flow.transition(session_id, "draft")
            session.set_phase(session_id, "paused")
            return "paused"
        try:
            produced = await generate.rebuild_section(session_id, section_id, message, usage)
        except ValueError:
            session.add_snapshot(
                session_id,
                turn_id,
                "agent_message",
                {
                    "text": f"Раздел «{title}» не обновлён: ответ модели не удалось разобрать. Замечание сохранено.",
                    "action": "error",
                    "section_id": section_id,
                    "section_title": title,
                },
            )
            session.set_phase(session_id, "paused")
            return "paused"
        session.add_snapshot(
            session_id,
            turn_id,
            "section_version",
            {"section": produced["section"], "marks": produced["marks"]},
        )
        session.add_snapshot(
            session_id,
            turn_id,
            "agent_message",
            {
                "text": f"Обновлён раздел «{title}».",
                "action": "rebuild_section",
                "section_id": section_id,
                "section_title": title,
            },
        )
        flow.transition(session_id, "draft")
        session.set_phase(session_id, "paused")
        return "paused"
    session.add_snapshot(
        session_id,
        turn_id,
        "agent_message",
        {"text": message, "action": "ask", "reason": reason},
    )
    session.set_phase(session_id, "paused")
    return "paused"


async def _compress_long_requirements(session_id: str, turn_id: str, usage: dict) -> None:
    if session.current_digest(session_id):
        return
    output = await tools.compress_if_long(session_id)
    if not output or "error" in output:
        return
    extra = output.get("usage") or {}
    usage["prompt_chars"] += int(extra.get("prompt_chars") or 0)
    usage["tokens_in"] += int(extra.get("tokens_in") or 0)
    usage["tokens_out"] += int(extra.get("tokens_out") or 0)
    if extra.get("model"):
        usage["model"] = extra["model"]
    session.add_snapshot(session_id, turn_id, "digest", output)


def _record_labeled_requirements(session_id: str, turn_id: str) -> bool:
    author = next(
        (item for item in reversed(session.list_snapshots(session_id)) if item["kind"] == "author_message"),
        None,
    )
    if author is None or author["payload"].get("section_id"):
        return False
    updated = generate.place_labeled_requirements(
        session.latest_sections(session_id),
        author["payload"].get("text") or "",
        str(author["id"]),
    )
    if not updated:
        return False
    titles = []
    for section in updated:
        session.add_snapshot(session_id, turn_id, "section_version", {"section": section, "marks": []})
        titles.append(section["title"])
    session.add_snapshot(
        session_id,
        turn_id,
        "agent_message",
        {
            "text": "Требования записаны в разделы: " + "; ".join(f"«{title}»" for title in titles) + ".",
            "action": "requirements",
            "section_titles": titles,
        },
    )
    return True


def _needs_key_text(slot: str, saved: bool) -> str:
    if slot == "cheap":
        key = "LLM_CHEAP_API_KEY"
        kind = "дешёвой"
    else:
        key = "LLM_STRONG_API_KEY"
        kind = "сильной"
    tail = "Профиль, фича и файлы сохранены." if saved else "Черновик не подменён."
    return f"Нужен ключ {kind} модели ({key}). {tail}"


def _absorb_usage(bucket: dict, result) -> None:
    bucket["prompt_chars"] += result.prompt_chars
    bucket["tokens_in"] += result.tokens_in
    bucket["tokens_out"] += result.tokens_out
    if result.model:
        bucket["model"] = result.model
    bucket["slot"] = result.slot or bucket.get("slot") or "strong"


def _rag_ids(result: dict) -> list[str]:
    blocks = result.get("blocks") if isinstance(result, dict) else None
    if not isinstance(blocks, list):
        return []
    return [block["id"] for block in blocks if isinstance(block, dict) and block.get("id")]


def _note_stop(session_id: str) -> str:
    if session.get_session(session_id) is None:
        return "paused"
    session.add_snapshot(
        session_id,
        session.new_turn(),
        "agent_message",
        {"text": "Остановил ход. Можно продолжить.", "action": "stopped"},
    )
    return session.recompute_phase(session_id)


def _raise_if_stopped(job_id: int) -> None:
    if session.job_is_cancelled(job_id):
        raise Stopped()


async def run_job(job_id: int) -> None:
    started = time.monotonic()
    job = session.get_job(job_id)
    if job is None or job["status"] not in {"pending", "cancelled"}:
        return
    session_id = job["session_id"]
    token = llm.bind_job(job_id)
    if job["status"] == "cancelled":
        try:
            _note_stop(session_id)
        finally:
            llm.unbind_job(token)
        return
    turn_id = session.new_turn()
    usage = {"prompt_chars": 0, "tokens_in": 0, "tokens_out": 0, "model": "", "slot": "strong"}
    trace = []
    rag_ids: list[str] = []
    status = "ready"
    detail = ""
    phase = "paused"
    try:
        apply_short_skeleton(session_id)
        if _record_labeled_requirements(session_id, turn_id):
            phase = "draft"
            status = "ready"
            detail = "requirements"
            return
        if not llm.configured("cheap"):
            session.add_snapshot(
                session_id,
                turn_id,
                "agent_message",
                {"text": _needs_key_text("cheap", saved=True), "action": "needs_key"},
            )
            phase = "needs_key"
            status = "needs_key"
            detail = "needs_key"
            return
        rounds = 0
        while True:
            _raise_if_stopped(job_id)
            await memory.refresh_summary(session_id)
            result = await llm.chat(
                "cheap",
                build_messages(session_id),
                tools=tools.TOOL_SPECS + [FINISH_TOOL],
                session_id=session_id,
            )
            _raise_if_stopped(job_id)
            _absorb_usage(usage, result)
            data_calls = [call for call in result.tool_calls if call.name != "finish_turn"]
            finish_calls = [call for call in result.tool_calls if call.name == "finish_turn"]
            if data_calls and rounds >= MAX_ROUNDS:
                session.add_snapshot(
                    session_id,
                    turn_id,
                    "agent_message",
                    {
                        "text": "Лимит инструментов за этот заход. Уточните, что делать дальше, или напишите «собери черновик».",
                        "action": "ask",
                        "reason": "limit",
                    },
                )
                phase = "paused"
                detail = "tool_limit"
                break
            if not data_calls and not finish_calls:
                session.add_snapshot(
                    session_id,
                    turn_id,
                    "agent_message",
                    {"text": result.text or "Нужно уточнение.", "action": "ask"},
                )
                phase = "paused"
                break
            for call in data_calls:
                if rounds >= MAX_ROUNDS:
                    break
                _raise_if_stopped(job_id)
                output = await tools.execute(session_id, call.name, call.arguments)
                trace.append({"name": call.name, "arguments": call.arguments})
                rag_ids.extend(_rag_ids(output))
                if isinstance(output, dict) and output.get("usage"):
                    usage["prompt_chars"] += int(output["usage"].get("prompt_chars") or 0)
                    usage["tokens_in"] += int(output["usage"].get("tokens_in") or 0)
                    usage["tokens_out"] += int(output["usage"].get("tokens_out") or 0)
                session.add_snapshot(
                    session_id,
                    turn_id,
                    "tool_call",
                    {"name": call.name, "arguments": call.arguments},
                )
                session.add_snapshot(
                    session_id,
                    turn_id,
                    "tool_result",
                    {"name": call.name, "result": output},
                )
                if call.name == "compress_requirements" and "error" not in output:
                    session.add_snapshot(session_id, turn_id, "digest", output)
                rounds += 1
            if finish_calls and not data_calls:
                _raise_if_stopped(job_id)
                phase = await apply_finish(session_id, finish_calls[0].arguments, turn_id, usage)
                detail = finish_calls[0].arguments.get("action") or ""
                break
            if not data_calls:
                break
    except Stopped:
        if session.get_session(session_id) is None:
            return
        session.undo_turn(session_id, turn_id)
        phase = _note_stop(session_id)
        status = "cancelled"
        detail = "stopped"
    except NeedsKey as exc:
        session.add_snapshot(
            session_id,
            turn_id,
            "agent_message",
            {"text": _needs_key_text(exc.slot, saved=False), "action": "needs_key"},
        )
        phase = "needs_key"
        status = "needs_key"
        detail = "needs_key"
    except Exception as exc:
        session.add_snapshot(
            session_id,
            turn_id,
            "agent_message",
            {"text": f"Ход остановился: {exc}", "action": "error"},
        )
        phase = "error"
        status = "error"
        detail = str(exc)
    finally:
        if session.get_session(session_id) is not None:
            if phase != "running":
                session.set_phase(session_id, phase)
            session.finish_job(
                job_id,
                status,
                slot=usage.get("slot") or "strong",
                model_name=usage.get("model") or "",
                tool_trace=trace,
                rag_block_ids=list(dict.fromkeys(rag_ids)),
                prompt_chars=usage["prompt_chars"],
                tokens_in=usage["tokens_in"],
                tokens_out=usage["tokens_out"],
                history_tokens=memory.history_tokens(session_id),
                duration_ms=int((time.monotonic() - started) * 1000),
                detail=detail,
            )
        llm.unbind_job(token)


def restore_previous_skeleton(session_id: str) -> bool:
    current = session.latest_of(session_id, "skeleton_current")
    if current is None or not current["payload"].get("immediate"):
        return False
    previous = current["payload"].get("previous")
    if not previous:
        return False
    turn_id = session.new_turn()
    session.add_snapshot(
        session_id,
        turn_id,
        "skeleton_current",
        {"skeleton": previous, "immediate": False, "reason": "Автор отверг короткий каркас"},
    )
    record = session.get_session(session_id)
    profiles.update_skeleton(record["profile_id"], previous)
    return True
