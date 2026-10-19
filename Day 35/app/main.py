import asyncio
import difflib
import os
import shutil
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app import agent, flow, generate, ingest, llm, memory, profile as profiles, retrieve, session
from app.db import connection, data_dir
from app.ingest import IngestError

class FreshStatic(StaticFiles):
    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-store"
        return response


app = FastAPI(title="Specification agent")
STATIC = Path(__file__).resolve().parent / "static"
app.mount("/static", FreshStatic(directory=STATIC), name="static")


class ProfileIn(BaseModel):
    name: str
    writing_note: str = ""


class NoteIn(BaseModel):
    writing_note: str = ""


class SessionIn(BaseModel):
    profile_id: str
    feature: str
    project: str = ""


class MessageIn(BaseModel):
    text: str
    section_id: str | None = None


class RepoIn(BaseModel):
    path: str


class SkeletonIn(BaseModel):
    action: str
    skeleton: dict | None = None
    text: str = ""


class ChoiceIn(BaseModel):
    which: str
    text: str = ""


class ExampleIn(BaseModel):
    text: str = ""


def _run_async(coro) -> None:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        asyncio.run(coro)
        return
    with ThreadPoolExecutor(max_workers=1) as pool:
        pool.submit(asyncio.run, coro).result()


def _run_inline(job_id: int) -> None:
    _run_async(agent.run_job(job_id))


def _enqueue(session_id: str, background: BackgroundTasks) -> dict:
    if session.job_pending(session_id):
        raise HTTPException(status_code=409, detail="Агент ещё работает")
    job = session.create_job(session_id)
    if os.environ.get("JOBS_INLINE") == "1":
        _run_inline(job["id"])
    else:
        background.add_task(agent.run_job, job["id"])
    return job


def _view(session_id: str) -> dict:
    record = session.get_session(session_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Сессия не найдена")
    files = []
    for item in session.list_files(session_id):
        files.append(
            {
                "id": item["id"],
                "filename": item["filename"],
                "purpose": item["purpose"],
                "headings": item["headings"],
                "extracted": bool(item.get("extracted_text")),
            }
        )
    return {
        "session": record,
        "profile": profiles.get_profile(record["profile_id"]),
        "snapshots": session.list_snapshots(session_id),
        "files": files,
        "sections": session.latest_sections(session_id),
        "proposal": session.open_proposal(session_id),
        "choice": session.open_choice(session_id),
        "skeleton": session.current_skeleton(session_id),
        "job": session.latest_job(session_id),
        "usage": _usage(session.latest_job(session_id), session_id),
    }


def _usage(job: dict | None, session_id: str) -> dict:
    stage = int((job or {}).get("tokens_in") or 0)
    reply = int((job or {}).get("tokens_out") or 0)
    history = int((job or {}).get("history_tokens") or 0)
    if history <= 0:
        history = memory.history_tokens(session_id)
    return {"stage": stage, "history": history, "reply": reply}


def _skeleton_from_text(text: str, skeleton_id: str, title: str) -> dict:
    headings = ingest.headings_from_markdown(text) or ingest.headings_from_plain(text)
    if not headings:
        raise ValueError("В тексте нет заголовков. Начните разделы со строк # Название.")
    return {
        "id": skeleton_id,
        "title": title,
        "sections": [{"id": f"s{index + 1}", "title": heading} for index, heading in enumerate(headings)],
    }


def _accept_skeleton(session_id: str, skeleton: dict, reason: str) -> None:
    record = session.get_session(session_id)
    turn_id = session.new_turn()
    session.add_snapshot(
        session_id,
        turn_id,
        "skeleton_current",
        {"skeleton": skeleton, "immediate": False, "reason": reason},
    )
    profiles.update_skeleton(record["profile_id"], skeleton)
    try:
        flow.transition(session_id, "approved")
    except flow.IllegalTransition:
        pass
    session.set_phase(session_id, "paused")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-store"})


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/profiles")
def get_profiles():
    return {"profiles": profiles.list_profiles()}


@app.post("/api/profiles")
def post_profile(body: ProfileIn):
    try:
        return profiles.create_profile(body.name, body.writing_note)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.patch("/api/profiles/{profile_id}")
def patch_profile(profile_id: str, body: NoteIn):
    try:
        return profiles.update_note(profile_id, body.writing_note)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Профиль не найден") from exc


@app.post("/api/sessions")
def post_session(body: SessionIn, response: Response, background: BackgroundTasks):
    try:
        record = session.create_session(body.profile_id, body.feature, body.project)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Профиль не найден") from exc
    response.set_cookie("session_id", record["id"], samesite="lax")
    _enqueue(record["id"], background)
    return _view(record["id"])


@app.get("/api/sessions/{session_id}")
def get_session_view(session_id: str):
    return _view(session_id)


@app.post("/api/sessions/{session_id}/messages")
def post_message(session_id: str, body: MessageIn, background: BackgroundTasks):
    if session.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="Сессия не найдена")
    if session.job_pending(session_id):
        raise HTTPException(status_code=409, detail="Агент ещё работает")
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Пустое сообщение")
    if text.lower() in {"готово", "готово."}:
        return _finish(session_id)
    if re_reject(text):
        agent.restore_previous_skeleton(session_id)
    turn_id = session.new_turn()
    session.add_snapshot(
        session_id,
        turn_id,
        "author_message",
        {"text": text, "section_id": body.section_id},
    )
    _enqueue(session_id, background)
    return _view(session_id)


def re_reject(text: str) -> bool:
    lowered = text.lower()
    return "верни прежний каркас" in lowered or "отмени короткий каркас" in lowered


@app.post("/api/sessions/{session_id}/files")
async def post_file(
    session_id: str,
    background: BackgroundTasks,
    purpose: str = Form(...),
    file: UploadFile = File(...),
):
    if session.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="Сессия не найдена")
    if session.job_pending(session_id):
        raise HTTPException(status_code=409, detail="Агент ещё работает")
    if purpose not in {"requirements", "skeleton", "example", "audio"}:
        raise HTTPException(status_code=400, detail="Неизвестное назначение файла")
    filename = Path(file.filename or "file").name
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Пустой файл")
    folder = data_dir() / "files" / session_id
    folder.mkdir(parents=True, exist_ok=True)
    stored = session.add_file(session_id, purpose, filename, str(folder / "pending"))
    path = folder / f"{stored['id']}_{filename}"
    path.write_bytes(raw)
    with connection() as conn:
        conn.execute("UPDATE files SET path = ? WHERE id = ?", (str(path), stored["id"]))
    turn_id = session.new_turn()
    session.add_snapshot(
        session_id,
        turn_id,
        "file",
        {"file_id": stored["id"], "filename": filename, "purpose": purpose},
    )
    if purpose in {"skeleton", "example", "requirements"}:
        try:
            extracted = ingest.extract_file(str(path))
        except IngestError as exc:
            raise HTTPException(status_code=400, detail=exc.message) from exc
        if extracted.get("needs_transcript"):
            raise HTTPException(status_code=400, detail=extracted["message"])
        session.store_extraction(stored["id"], extracted["text"], extracted["headings"])
        if purpose == "example":
            saved = retrieve.add_spec(extracted["text"], session_id=session_id)
            session.add_snapshot(
                session_id,
                turn_id,
                "example_saved",
                {"spec_id": saved["spec_id"], "filename": filename},
            )
            return _view(session_id)
    if purpose == "skeleton":
        skeleton_files = session.list_files(session_id, "skeleton")
        if len(skeleton_files) >= 2:
            options = []
            for index, item in enumerate(skeleton_files, start=1):
                text = item.get("extracted_text") or ""
                if not text and item["id"] != stored["id"]:
                    try:
                        parsed = ingest.extract_file(item["path"])
                    except IngestError as exc:
                        raise HTTPException(status_code=400, detail=exc.message) from exc
                    session.store_extraction(item["id"], parsed["text"], parsed["headings"])
                    text = parsed["text"]
                try:
                    skeleton = _skeleton_from_text(text, item["id"][:8], item["filename"])
                except ValueError as exc:
                    raise HTTPException(status_code=400, detail=str(exc)) from exc
                options.append(
                    {
                        "which": str(index),
                        "file_id": item["id"],
                        "filename": item["filename"],
                        "skeleton": skeleton,
                    }
                )
            session.add_snapshot(session_id, turn_id, "skeleton_choice", {"options": options})
            session.set_phase(session_id, "paused")
            return _view(session_id)
    _enqueue(session_id, background)
    return _view(session_id)


@app.post("/api/sessions/{session_id}/skeleton-choice")
def post_choice(session_id: str, body: ChoiceIn, background: BackgroundTasks):
    if session.job_pending(session_id):
        raise HTTPException(status_code=409, detail="Агент ещё работает")
    choice = session.open_choice(session_id)
    if choice is None:
        raise HTTPException(status_code=400, detail="Сейчас нет выбора из двух ТЗ")
    if body.which == "own":
        try:
            skeleton = _skeleton_from_text(body.text, "own", "Свой каркас")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    else:
        match = next((item for item in choice["options"] if item["which"] == body.which), None)
        if match is None:
            raise HTTPException(status_code=400, detail="Нет такого варианта")
        skeleton = match["skeleton"]
    _accept_skeleton(session_id, skeleton, "Автор выбрал один каркас из загруженных")
    _enqueue(session_id, background)
    return _view(session_id)


@app.post("/api/sessions/{session_id}/skeleton")
def post_skeleton(session_id: str, body: SkeletonIn, background: BackgroundTasks):
    if session.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="Сессия не найдена")
    if session.job_pending(session_id):
        raise HTTPException(status_code=409, detail="Агент ещё работает")
    if body.action == "accept":
        proposal = session.open_proposal(session_id)
        if proposal is None:
            raise HTTPException(status_code=400, detail="Нет предложения каркаса")
        _accept_skeleton(session_id, proposal["skeleton"], "Автор принял предложенный каркас")
    elif body.action == "edit":
        if not body.skeleton or not body.skeleton.get("sections"):
            raise HTTPException(status_code=400, detail="Нужны разделы каркаса")
        _accept_skeleton(session_id, body.skeleton, "Автор поправил каркас")
    elif body.action == "replace_text":
        try:
            skeleton = _skeleton_from_text(body.text, "replaced", "Свой каркас")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        _accept_skeleton(session_id, skeleton, "Автор заменил каркас своим текстом")
    elif body.action == "reject":
        if not agent.restore_previous_skeleton(session_id):
            raise HTTPException(status_code=400, detail="Короткий каркас не на что заменить")
        return _view(session_id)
    else:
        raise HTTPException(status_code=400, detail="Неизвестное действие")
    _enqueue(session_id, background)
    return _view(session_id)


@app.post("/api/sessions/{session_id}/repo")
def post_repo(session_id: str, body: RepoIn, background: BackgroundTasks):
    if session.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="Сессия не найдена")
    if session.job_pending(session_id):
        raise HTTPException(status_code=409, detail="Агент ещё работает")
    path = Path(body.path).expanduser().resolve()
    if not path.is_dir():
        raise HTTPException(status_code=400, detail="Папка репозитория не найдена")
    session.set_repo(session_id, str(path))
    turn_id = session.new_turn()
    session.add_snapshot(session_id, turn_id, "author_message", {"text": f"Подключил репозиторий {path}"})
    _enqueue(session_id, background)
    return _view(session_id)


@app.post("/api/sessions/{session_id}/examples")
def post_example(session_id: str, body: ExampleIn):
    if session.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="Сессия не найдена")
    if body.text.strip():
        saved = retrieve.add_spec(body.text, session_id=session_id)
    else:
        sections = session.latest_sections(session_id)
        if not sections:
            raise HTTPException(status_code=400, detail="Нет черновика, чтобы сохранить пример")
        saved = retrieve.add_sections(sections, session_id=session_id)
    turn_id = session.new_turn()
    session.add_snapshot(session_id, turn_id, "example_saved", {"spec_id": saved["spec_id"]})
    return _view(session_id)


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str, response: Response):
    record = session.get_session(session_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Сессия не найдена")
    if session.job_pending(session_id):
        session.request_stop(session_id)
        await llm.cancel_session(session_id)
    await llm.archive_session(session_id)
    purged = session.purge_session(session_id)
    if purged is None:
        raise HTTPException(status_code=404, detail="Сессия не найдена")
    for raw in purged["paths"]:
        path = Path(raw)
        if path.is_file():
            path.unlink()
    folder = data_dir() / "files" / session_id
    if folder.is_dir():
        shutil.rmtree(folder, ignore_errors=True)
    target = data_dir() / "out" / f"{session_id}.md"
    if target.is_file():
        target.unlink()
    response.delete_cookie("session_id")
    return {"profile_id": purged["profile_id"]}


@app.post("/api/sessions/{session_id}/stop")
async def post_stop(session_id: str):
    if session.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="Сессия не найдена")
    stopped = session.request_stop(session_id)
    await llm.cancel_session(session_id)
    if stopped is not None:
        session.recompute_phase(session_id)
    return _view(session_id)


@app.post("/api/sessions/{session_id}/cancel")
def post_cancel(session_id: str):
    if session.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="Сессия не найдена")
    if session.job_pending(session_id):
        raise HTTPException(status_code=409, detail="Дождитесь конца хода")
    try:
        session.cancel_last(session_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _view(session_id)


@app.post("/api/sessions/{session_id}/done")
def post_done(session_id: str):
    return _finish(session_id)


def _finish(session_id: str) -> dict:
    record = session.get_session(session_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Сессия не найдена")
    if flow.stage_of(session_id) != "validated":
        raise HTTPException(status_code=400, detail=flow.DONE_BLOCKED)
    sections = session.latest_sections(session_id)
    if not sections:
        raise HTTPException(status_code=400, detail="Черновика ещё нет")
    flow.transition(session_id, "done")
    text = generate.document_markdown(record, sections)
    target = data_dir() / "out" / f"{session_id}.md"
    target.write_text(text, encoding="utf-8")
    turn_id = session.new_turn()
    session.add_snapshot(session_id, turn_id, "done", {"path": str(target)})
    session.set_phase(session_id, "paused")
    _run_async(llm.archive_session(session_id))
    return _view(session_id)


@app.post("/api/sessions/{session_id}/validate")
def post_validate(session_id: str):
    if session.get_session(session_id) is None:
        raise HTTPException(status_code=404, detail="Сессия не найдена")
    if session.job_pending(session_id):
        raise HTTPException(status_code=409, detail="Агент ещё работает")
    stage = flow.stage_of(session_id)
    if stage != "draft":
        detail = "Проверка уже пройдена." if stage in {"validated", "done"} else "Сначала нужен черновик."
        raise HTTPException(status_code=400, detail=detail)
    if not session.latest_sections(session_id):
        raise HTTPException(status_code=400, detail="Черновика ещё нет")
    problems = flow.validation_problems(session_id)
    turn_id = session.new_turn()
    if problems:
        listed = ", ".join(problems)
        session.add_snapshot(
            session_id,
            turn_id,
            "agent_message",
            {
                "text": f"Проверка не пройдена. В этих разделах остались вопросы или утверждения без опоры: {listed}.",
                "action": "ask",
            },
        )
        return _view(session_id)
    flow.transition(session_id, "validated")
    session.add_snapshot(
        session_id,
        turn_id,
        "agent_message",
        {"text": "Проверка пройдена.", "action": "ask"},
    )
    session.set_phase(session_id, "paused")
    return _view(session_id)


@app.get("/api/sessions/{session_id}/markdown")
def get_markdown(session_id: str):
    record = session.get_session(session_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Сессия не найдена")
    sections = session.latest_sections(session_id)
    if not sections:
        raise HTTPException(status_code=400, detail="Черновика ещё нет")
    text = generate.document_markdown(record, sections)
    target = data_dir() / "out" / f"{session_id}.md"
    target.write_text(text, encoding="utf-8")
    return PlainTextResponse(
        text,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{session_id}.md"'},
    )


@app.get("/api/sessions/{session_id}/diff")
def get_diff(session_id: str):
    record = session.get_session(session_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Сессия не найдена")
    history = session.section_history(session_id)
    sections = []
    first_parts = []
    last_parts = []
    for section_id, versions in history.items():
        first = generate.section_plain(versions[0])
        last = generate.section_plain(versions[-1])
        diff = "".join(
            difflib.unified_diff(
                first.splitlines(keepends=True),
                last.splitlines(keepends=True),
                fromfile=f"{section_id} первая",
                tofile=f"{section_id} последняя",
            )
        )
        sections.append(
            {
                "id": section_id,
                "title": versions[-1]["title"],
                "diff": diff,
                "unchanged": first == last,
            }
        )
        first_parts.append(first)
        last_parts.append(last)
    document_diff = "".join(
        difflib.unified_diff(
            ("\n\n".join(first_parts) + "\n").splitlines(keepends=True),
            ("\n\n".join(last_parts) + "\n").splitlines(keepends=True),
            fromfile="черновик первая",
            tofile="черновик последняя",
        )
    )
    return {"sections": sections, "document_diff": document_diff}

