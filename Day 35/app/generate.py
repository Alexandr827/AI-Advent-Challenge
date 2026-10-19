import json
import re
import time

from app import llm, session
from app.llm import NeedsKey


DRAFT_SCHEMA = """
Верни только JSON:
{
  "sections": [
    {
      "id": "строка",
      "title": "строка",
      "blocks": [
        {
          "kind": "statement",
          "text": "утверждение",
          "sources": [{"type": "requirements|answer|rag", "id": "существующий id"}]
        },
        {"kind": "question", "text": "вопрос, если фактуры нет"}
      ]
    }
  ]
}
Не выдумывай требования. Если фактуры нет, блок имеет kind question и не содержит sources.
""".strip()


def validate_document(data: dict) -> list[str]:
    errors = []
    sections = data.get("sections") if isinstance(data, dict) else None
    if not isinstance(sections, list) or not sections:
        return ["Нужен непустой список sections"]
    seen = set()
    for index, section in enumerate(sections):
        if not isinstance(section, dict):
            errors.append(f"Раздел {index} не объект")
            continue
        section_id = section.get("id")
        if not isinstance(section_id, str) or not section_id.strip():
            errors.append(f"Раздел {index} без id")
        elif section_id in seen:
            errors.append(f"Повтор id {section_id}")
        else:
            seen.add(section_id)
        if not isinstance(section.get("title"), str) or not section["title"].strip():
            errors.append(f"Раздел {index} без title")
        blocks = section.get("blocks")
        if not isinstance(blocks, list) or not blocks:
            errors.append(f"Раздел {section_id or index} без блоков")
            continue
        for block_index, block in enumerate(blocks):
            if not isinstance(block, dict):
                errors.append(f"{section_id} блок {block_index} не объект")
                continue
            kind = block.get("kind")
            if kind not in {"statement", "question"}:
                errors.append(f"{section_id} блок {block_index}: нужен kind statement или question")
            if not isinstance(block.get("text"), str) or not block["text"].strip():
                errors.append(f"{section_id} блок {block_index}: пустой текст")
            if kind == "statement":
                sources = block.get("sources")
                if not isinstance(sources, list):
                    errors.append(f"{section_id} блок {block_index}: нет sources")
                    continue
                for source in sources:
                    if (
                        not isinstance(source, dict)
                        or source.get("type") not in {"requirements", "answer", "rag"}
                        or not source.get("id")
                    ):
                        errors.append(f"{section_id} блок {block_index}: источник без type и id")
    return errors


def known_source_ids(session_id: str) -> set[str]:
    ids = {item["id"] for item in session.list_files(session_id)}
    for snap in session.list_snapshots(session_id):
        if snap["kind"] == "author_message":
            ids.add(str(snap["id"]))
        if snap["kind"] == "tool_result" and snap["payload"].get("name") == "search_similar_specs":
            for block in snap["payload"].get("result", {}).get("blocks", []):
                if block.get("id"):
                    ids.add(block["id"])
    return ids


def cited_texts(session_id: str) -> dict[str, str]:
    texts = {}
    for item in session.list_files(session_id):
        if item.get("extracted_text"):
            texts[item["id"]] = item["extracted_text"][:4000]
    for snap in session.list_snapshots(session_id):
        if snap["kind"] == "author_message":
            texts[str(snap["id"])] = snap["payload"].get("text", "")
        if snap["kind"] == "tool_result" and snap["payload"].get("name") == "search_similar_specs":
            for block in snap["payload"].get("result", {}).get("blocks", []):
                texts[block["id"]] = f"{block.get('heading', '')}\n{block.get('body', '')}"[:4000]
    return texts


def repair_grounding(document: dict, known_ids: set[str]) -> tuple[dict, list[dict]]:
    marks = []
    for section in document["sections"]:
        repaired = []
        for block in section["blocks"]:
            if block.get("kind") != "statement":
                repaired.append({"kind": "question", "text": block["text"].strip()})
                continue
            sources = [
                {"type": source["type"], "id": str(source["id"])}
                for source in block.get("sources", [])
                if isinstance(source, dict) and source.get("id")
            ]
            grounded = bool(sources) and all(source["id"] in known_ids for source in sources)
            if grounded:
                repaired.append(
                    {"kind": "statement", "text": block["text"].strip(), "sources": sources}
                )
                continue
            question = {
                "kind": "question",
                "text": f"Не хватает фактуры, чтобы утверждать: {block['text'].strip()}",
            }
            repaired.append(question)
            marks.append({"section_id": section["id"], "text": block["text"].strip()})
        section["blocks"] = repaired
        section["id"] = section["id"].strip()
        section["title"] = section["title"].strip()
    return document, marks


def context_bundle(session_id: str) -> dict:
    record = session.get_session(session_id)
    return {
        "feature": record["feature"],
        "project": record["project"],
        "skeleton": session.current_skeleton(session_id),
        "digest": session.current_digest(session_id),
        "files": [
            {
                "id": item["id"],
                "filename": item["filename"],
                "purpose": item["purpose"],
                "text": (item.get("extracted_text") or "")[:3000],
            }
            for item in session.list_files(session_id)
        ],
        "answers": [
            {"id": str(snap["id"]), "text": snap["payload"].get("text", "")}
            for snap in session.list_snapshots(session_id)
            if snap["kind"] == "author_message"
        ],
        "known_ids": sorted(known_source_ids(session_id)),
    }


async def _complete_json(slot: str, messages: list[dict], usage: dict, session_id: str) -> dict:
    result = await llm.chat(slot, messages, tools=None, session_id=session_id)
    usage["prompt_chars"] += result.prompt_chars
    usage["tokens_in"] += result.tokens_in
    usage["tokens_out"] += result.tokens_out
    usage["model"] = result.model or usage.get("model") or ""
    usage["slot"] = slot
    return llm.parse_json(result.text)


async def draft_document(session_id: str, usage: dict) -> dict:
    bundle = context_bundle(session_id)
    skeleton = bundle["skeleton"]
    if not skeleton:
        raise ValueError("Нет выбранного каркаса")
    messages = [
        {
            "role": "system",
            "content": (
                "Собери черновик спецификации по разделам каркаса. "
                "Каждый раздел каркаса должен быть в ответе. " + DRAFT_SCHEMA
            ),
        },
        {"role": "user", "content": json.dumps(bundle, ensure_ascii=False)},
    ]
    try:
        data = await _complete_json("strong", messages, usage, session_id)
    except NeedsKey:
        raise
    except (json.JSONDecodeError, ValueError):
        data = {}
    errors = validate_document(data) if data else ["Ответ не JSON"]
    if errors:
        messages.append({"role": "assistant", "content": json.dumps(data, ensure_ascii=False)})
        messages.append(
            {
                "role": "user",
                "content": "Исправь JSON. Ошибки: " + "; ".join(errors),
            }
        )
        try:
            data = await _complete_json("strong", messages, usage, session_id)
        except (json.JSONDecodeError, ValueError) as exc:
            raise ValueError("Модель не вернула список разделов") from exc
        errors = validate_document(data)
        if errors:
            raise ValueError("Схема черновика не сошлась: " + "; ".join(errors))
    document, marks = repair_grounding(data, set(bundle["known_ids"]))
    return {"document": document, "marks": marks}


_REQUIREMENT_LABELS = (
    ("бизнес-требование", ("проблем",)),
    ("функциональное требование", ("решен",)),
    ("критерий приёмки", ("критер",)),
    ("критерий приемки", ("критер",)),
)


def place_labeled_requirements(sections: list[dict], text: str, source_id: str) -> list[dict]:
    pattern = re.compile(
        r"(бизнес-требование|функциональное требование|критерий при[её]мки)\s*:\s*",
        re.IGNORECASE,
    )
    matches = list(pattern.finditer(text or ""))
    updated = []
    used = set()
    for index, match in enumerate(matches):
        label = match.group(1).lower().replace("ё", "е")
        if label == "критерий приемки":
            label = "критерий приёмки"
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        body = text[match.end() : end].strip(" \n\t.;")
        keywords = next(words for name, words in _REQUIREMENT_LABELS if name == label)
        target = next(
            (
                section
                for section in sections
                if section.get("id") not in used
                and any(word in (section.get("title") or "").lower() for word in keywords)
            ),
            None,
        )
        if target is None or not body:
            continue
        used.add(target["id"])
        copy = dict(target)
        copy["blocks"] = [
            {
                "kind": "statement",
                "text": f"{label[:1].upper()}{label[1:]}: {body}",
                "sources": [{"type": "answer", "id": str(source_id)}],
            }
        ]
        updated.append(copy)
    return updated


def answered_section(section: dict, remark: str, source_id: str) -> tuple[dict, int] | None:
    if not section or not remark.strip() or not source_id:
        return None
    blocks = []
    matched = 0
    for block in section.get("blocks") or []:
        question = (block.get("text") or "").strip()
        answer = ""
        if block.get("kind") == "question" and question:
            for line in remark.splitlines():
                stripped = line.strip()
                if stripped.startswith(question):
                    answer = stripped[len(question) :].strip(" :—-")
                    break
        if answer:
            matched += 1
            blocks.append(
                {
                    "kind": "statement",
                    "text": f"{question} {answer}".strip(),
                    "sources": [{"type": "answer", "id": str(source_id)}],
                }
            )
        else:
            blocks.append(block)
    if matched == 0:
        return None
    updated = dict(section)
    updated["blocks"] = blocks
    return updated, matched


def _section_payload(data: dict, section_id: str) -> dict | None:
    if not isinstance(data, dict):
        return None
    section = data.get("section")
    if isinstance(section, dict):
        return section
    sections = data.get("sections")
    if isinstance(sections, list):
        for item in sections:
            if isinstance(item, dict) and item.get("id") == section_id:
                return item
        if len(sections) == 1 and isinstance(sections[0], dict):
            return sections[0]
    if isinstance(data.get("blocks"), list) and isinstance(data.get("title"), str):
        return data
    return None


async def rebuild_section(session_id: str, section_id: str, remark: str, usage: dict) -> dict:
    current = None
    for section in session.latest_sections(session_id):
        if section["id"] == section_id:
            current = section
            break
    if current is None:
        raise ValueError("Такого раздела нет")
    bundle = context_bundle(session_id)
    messages = [
        {
            "role": "system",
            "content": (
                "Пересобери только один раздел спецификации с учётом замечания автора. "
                "Сохрани тот же id. Верни JSON {\"section\": {id, title, blocks}}. "
                + DRAFT_SCHEMA
            ),
        },
        {
            "role": "user",
            "content": json.dumps(
                {"section": current, "remark": remark, "context": bundle},
                ensure_ascii=False,
            ),
        },
    ]
    try:
        data = await _complete_json("strong", messages, usage, session_id)
    except (json.JSONDecodeError, ValueError) as exc:
        raise ValueError("Модель не вернула раздел") from exc
    section = _section_payload(data, section_id)
    if not isinstance(section, dict):
        raise ValueError("В ответе нет section")
    section["id"] = section_id
    wrapped = {"sections": [section]}
    errors = validate_document(wrapped)
    if errors:
        messages.append({"role": "assistant", "content": json.dumps(data, ensure_ascii=False)})
        messages.append({"role": "user", "content": "Исправь JSON. Ошибки: " + "; ".join(errors)})
        data = await _complete_json("strong", messages, usage, session_id)
        section = _section_payload(data, section_id)
        if not isinstance(section, dict):
            raise ValueError("В ответе нет section")
        section["id"] = section_id
        wrapped = {"sections": [section]}
        errors = validate_document(wrapped)
        if errors:
            raise ValueError("Схема раздела не сошлась: " + "; ".join(errors))
    document, marks = repair_grounding(wrapped, set(bundle["known_ids"]))
    return {"section": document["sections"][0], "marks": marks}


def section_plain(section: dict) -> str:
    lines = [f"## {section['title']}"]
    for block in section["blocks"]:
        if block["kind"] == "question":
            lines.append(f"> {block['text']}")
        else:
            lines.append(block["text"])
    return "\n\n".join(lines)


def document_markdown(record: dict, sections: list[dict]) -> str:
    lines = [f"# {record['feature']}"]
    if record.get("project"):
        lines.append(f"Проект: {record['project']}")
    lines.append("")
    for section in sections:
        lines.append(section_plain(section))
        lines.append("")
    return "\n".join(lines).strip() + "\n"
