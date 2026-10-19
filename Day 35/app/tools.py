import os
from pathlib import Path

from app import llm, profile as profiles, retrieve, session
from app.ingest import AUDIO_EXTENSIONS, IngestError, extract_file
from app.llm import NeedsKey

SHORT_SECTIONS = [
    {"id": "goal", "title": "Цель"},
    {"id": "scope", "title": "Что делаем"},
    {"id": "acceptance", "title": "Критерии приёмки"},
]

STANDARD_SECTIONS = [
    {"id": "goal", "title": "Цель"},
    {"id": "scope", "title": "Объём"},
    {"id": "requirements", "title": "Требования"},
    {"id": "architecture", "title": "Архитектура"},
    {"id": "acceptance", "title": "Критерии приёмки"},
    {"id": "out_of_scope", "title": "Вне объёма"},
]

TOOL_SPECS = [
    {
        "name": "extract_from_pdf",
        "description": "Извлечь текст и заголовки из файла этой сессии: pdf, docx, doc, txt или md.",
        "parameters": {
            "type": "object",
            "properties": {"file_id": {"type": "string"}},
            "required": ["file_id"],
        },
    },
    {
        "name": "search_similar_specs",
        "description": "Найти похожие фрагменты технических заданий в общем RAG.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "limit": {"type": "integer"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "suggest_skeleton",
        "description": "Вернуть кандидатов каркаса: шаблон профиля, похожие ТЗ и короткий каркас.",
        "parameters": {
            "type": "object",
            "properties": {"feature_description": {"type": "string"}},
            "required": ["feature_description"],
        },
    },
    {
        "name": "get_project_context",
        "description": "Прочитать подключённый репозиторий. Ничего не записывает.",
        "parameters": {"type": "object", "properties": {}},
    },
    {
        "name": "compress_requirements",
        "description": "Сжать уже извлечённые требования в выжимку по разделам текущего каркаса.",
        "parameters": {"type": "object", "properties": {}},
    },
]


def short_skeleton() -> dict:
    return {"id": "short", "title": "Короткое ТЗ", "sections": SHORT_SECTIONS}


def standard_skeleton() -> dict:
    return {"id": "standard", "title": "Полный каркас", "sections": STANDARD_SECTIONS}


async def execute(session_id: str, name: str, arguments: dict) -> dict:
    if name == "extract_from_pdf":
        return extract_from_pdf(session_id, str(arguments.get("file_id") or ""))
    if name == "search_similar_specs":
        limit = arguments.get("limit") or 3
        try:
            limit = int(limit)
        except (TypeError, ValueError):
            limit = 3
        return {"blocks": retrieve.search(str(arguments.get("query") or ""), limit)}
    if name == "suggest_skeleton":
        text = str(arguments.get("feature_description") or "")
        return suggest_skeleton(session_id, text)
    if name == "get_project_context":
        return get_project_context(session_id)
    if name == "compress_requirements":
        return await compress_requirements(session_id)
    return {"error": f"Неизвестный инструмент {name}"}


def extract_from_pdf(session_id: str, file_id: str) -> dict:
    record = session.get_file(file_id)
    if record is None or record["session_id"] != session_id:
        return {"error": "Файл не принадлежит этой сессии"}
    suffix = Path(record["filename"]).suffix.lower()
    if record["purpose"] == "audio" or suffix in AUDIO_EXTENSIONS:
        return {
            "needs_transcript": True,
            "message": "Ключа распознавания речи нет. Вставьте транскрипт текстом.",
        }
    if record.get("extracted_text"):
        return {
            "file_id": file_id,
            "filename": record["filename"],
            "headings": record["headings"],
            "text": record["extracted_text"][:8000],
        }
    try:
        extracted = extract_file(record["path"])
    except IngestError as exc:
        return {"error": exc.message}
    if extracted.get("needs_transcript"):
        return {
            "needs_transcript": True,
            "message": extracted["message"],
        }
    session.store_extraction(file_id, extracted["text"], extracted["headings"])
    return {
        "file_id": file_id,
        "filename": record["filename"],
        "headings": extracted["headings"],
        "text": extracted["text"][:8000],
    }


def file_skeletons(session_id: str) -> list[dict]:
    found = []
    for item in session.list_files(session_id, "skeleton"):
        headings = [heading for heading in item.get("headings") or [] if heading]
        if not headings:
            continue
        found.append(
            {
                "id": item["id"][:8],
                "title": item["filename"],
                "source": "file",
                "sections": [
                    {"id": f"s{index + 1}", "title": heading} for index, heading in enumerate(headings)
                ],
            }
        )
    return found


def suggest_skeleton(session_id: str, feature_description: str) -> dict:
    record = session.get_session(session_id)
    profile = profiles.get_profile(record["profile_id"])
    query = feature_description.strip() or record["feature"]
    candidates = file_skeletons(session_id)
    if profile and profile.get("skeleton"):
        saved = dict(profile["skeleton"])
        saved["id"] = "profile"
        saved["source"] = "profile"
        candidates.append(saved)
    for spec in retrieve.headings_by_spec(query):
        candidates.append(
            {
                "id": f"spec-{spec['spec_id'][:8]}",
                "spec_id": spec["spec_id"],
                "title": "Похожее ТЗ",
                "source": "rag",
                "sections": [
                    {"id": f"s{index + 1}", "title": heading}
                    for index, heading in enumerate(spec["headings"])
                ],
            }
        )
    short = short_skeleton()
    short["source"] = "short"
    standard = standard_skeleton()
    standard["source"] = "standard"
    candidates.extend([short, standard])
    return {"candidates": candidates}


def get_project_context(session_id: str) -> dict:
    record = session.get_session(session_id)
    repo = record.get("repo_path")
    if not repo:
        return {"connected": False, "message": "Репозиторий не подключён"}
    root = Path(repo).resolve()
    if not root.is_dir():
        return {"connected": False, "message": "Путь репозитория недоступен"}
    names = []
    readme = ""
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [name for name in dirnames if not name.startswith(".") and name != "node_modules"]
        for filename in filenames:
            if filename.startswith(".") or filename.endswith((".png", ".jpg", ".pdf", ".zip")):
                continue
            path = Path(dirpath) / filename
            try:
                relative = path.resolve().relative_to(root)
            except ValueError:
                continue
            names.append(str(relative))
            if not readme and filename.lower() in {"readme.md", "readme.txt"}:
                readme = path.read_text(encoding="utf-8", errors="replace")[:6000]
            if len(names) >= 40:
                break
        if len(names) >= 40:
            break
    return {"connected": True, "files": names, "readme": readme}


DIGEST_MIN_CHARS = 4000


def requirements_text(session_id: str) -> str:
    parts = []
    for item in session.list_files(session_id):
        if item["purpose"] not in {"requirements", "audio"}:
            continue
        if item.get("extracted_text"):
            parts.append(f"Файл {item['filename']} ({item['id']}):\n{item['extracted_text']}")
    for snap in session.list_snapshots(session_id):
        if snap["kind"] == "author_message":
            parts.append(f"Ответ автора {snap['id']}:\n{snap['payload'].get('text', '')}")
    return "\n\n".join(parts).strip()


async def compress_if_long(session_id: str) -> dict | None:
    if len(requirements_text(session_id)) < DIGEST_MIN_CHARS:
        return None
    return await compress_requirements(session_id)


async def compress_requirements(session_id: str) -> dict:
    skeleton = session.current_skeleton(session_id)
    source = requirements_text(session_id)
    if not source:
        return {"error": "Нет извлечённого текста требований. Сначала вызовите extract_from_pdf."}
    if not skeleton:
        return {"error": "Нет каркаса, не к чему привязать выжимку."}
    if not llm.configured("cheap"):
        return {
            "truncated": True,
            "note": "Обрезка, не пересказ. Дешёвая модель не настроена.",
            "text": source[:6000],
        }
    messages = [
        {
            "role": "system",
            "content": (
                "Сожми требования в короткую выжимку по каждому разделу каркаса. "
                "Верни JSON {\"sections\": [{\"id\", \"title\", \"text\"}]}. "
                "Не добавляй фактов, которых нет в тексте."
            ),
        },
        {
            "role": "user",
            "content": json_dumps({"skeleton": skeleton, "requirements": source[:20000]}),
        },
    ]
    try:
        result = await llm.chat("cheap", messages, session_id=session_id)
    except NeedsKey:
        return {
            "truncated": True,
            "note": "Обрезка, не пересказ.",
            "text": source[:6000],
        }
    try:
        data = llm.parse_json(result.text)
    except (ValueError, Exception):
        return {
            "truncated": True,
            "note": "Обрезка, не пересказ. Сжатие не вернуло JSON.",
            "text": source[:6000],
            "usage": _usage(result),
        }
    sections = data.get("sections") if isinstance(data, dict) else None
    if not isinstance(sections, list) or not sections:
        return {
            "truncated": True,
            "note": "Обрезка, не пересказ.",
            "text": source[:6000],
            "usage": _usage(result),
        }
    return {"truncated": False, "sections": sections, "usage": _usage(result)}


def _usage(result) -> dict:
    return {
        "model": result.model,
        "slot": "cheap",
        "prompt_chars": result.prompt_chars,
        "tokens_in": result.tokens_in,
        "tokens_out": result.tokens_out,
    }


def json_dumps(payload: dict) -> str:
    import json

    return json.dumps(payload, ensure_ascii=False)
