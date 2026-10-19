import json
import os
from datetime import datetime, timezone

from app.db import connection

TAIL_DEFAULT = 8


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def tail_size() -> int:
    try:
        size = int(os.environ.get("CONTEXT_TAIL", str(TAIL_DEFAULT)))
    except ValueError:
        size = TAIL_DEFAULT
    return max(1, size)


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    return max(1, len(text) // 4)


def remember_dialog(session_id: str, role: str, text: str) -> None:
    cleaned = (text or "").strip()
    if not cleaned:
        return
    with connection() as conn:
        conn.execute(
            """
            INSERT INTO dialog_messages (session_id, role, text, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (session_id, role, cleaned, _now()),
        )


def list_dialog(session_id: str) -> list[dict]:
    with connection() as conn:
        rows = conn.execute(
            "SELECT id, role, text FROM dialog_messages WHERE session_id = ? ORDER BY id",
            (session_id,),
        ).fetchall()
    return [{"id": row["id"], "role": row["role"], "text": row["text"]} for row in rows]


def history_tokens(session_id: str) -> int:
    return sum(estimate_tokens(item["text"]) for item in list_dialog(session_id))


def remember_working(session_id: str, key: str, content: str) -> None:
    with connection() as conn:
        conn.execute(
            """
            INSERT INTO working_memory (session_id, key, content, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(session_id, key) DO UPDATE SET
                content = excluded.content,
                updated_at = excluded.updated_at
            """,
            (session_id, key, content, _now()),
        )


def working_items(session_id: str) -> dict[str, str]:
    with connection() as conn:
        rows = conn.execute(
            "SELECT key, content FROM working_memory WHERE session_id = ?",
            (session_id,),
        ).fetchall()
    return {row["key"]: row["content"] for row in rows}


def remember_profile(profile_id: str, kind: str, content: str, replace: bool = False) -> None:
    cleaned = (content or "").strip()
    if not profile_id:
        return
    if not cleaned and not replace:
        return
    with connection() as conn:
        if replace:
            conn.execute(
                "DELETE FROM profile_memory WHERE profile_id = ? AND kind = ?",
                (profile_id, kind),
            )
        if not cleaned:
            return
        conn.execute(
            """
            INSERT INTO profile_memory (profile_id, kind, content, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (profile_id, kind, cleaned, _now()),
        )


def profile_items(profile_id: str) -> list[dict]:
    with connection() as conn:
        rows = conn.execute(
            """
            SELECT id, kind, content FROM profile_memory
            WHERE profile_id = ? ORDER BY id
            """,
            (profile_id,),
        ).fetchall()
    return [{"id": row["id"], "kind": row["kind"], "content": row["content"]} for row in rows]


def forget_session(conn, session_id: str) -> None:
    conn.execute("DELETE FROM dialog_messages WHERE session_id = ?", (session_id,))
    conn.execute("DELETE FROM dialog_summaries WHERE session_id = ?", (session_id,))
    conn.execute("DELETE FROM working_memory WHERE session_id = ?", (session_id,))


def _profile_id(session_id: str) -> str | None:
    with connection() as conn:
        row = conn.execute("SELECT profile_id FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if row is None:
        return None
    return row["profile_id"]


def _put_json(session_id: str, key: str, payload) -> None:
    remember_working(session_id, key, json.dumps(payload, ensure_ascii=False))


def refresh_files(session_id: str) -> None:
    with connection() as conn:
        rows = conn.execute(
            "SELECT id, filename, purpose, extracted_text FROM files WHERE session_id = ? ORDER BY created_at",
            (session_id,),
        ).fetchall()
    _put_json(
        session_id,
        "files",
        [
            {
                "id": row["id"],
                "filename": row["filename"],
                "purpose": row["purpose"],
                "extracted": bool(row["extracted_text"]),
            }
            for row in rows
        ],
    )


def _refresh_outline(session_id: str) -> None:
    with connection() as conn:
        rows = conn.execute(
            """
            SELECT payload FROM snapshots
            WHERE session_id = ? AND kind = 'section_version' AND undone = 0
            ORDER BY id
            """,
            (session_id,),
        ).fetchall()
    order: list[str] = []
    titles: dict[str, str] = {}
    for row in rows:
        payload = json.loads(row["payload"])
        section = payload.get("section") or {}
        section_id = section.get("id")
        if not section_id:
            continue
        if section_id not in titles:
            order.append(section_id)
        titles[section_id] = section.get("title") or section_id
    _put_json(session_id, "outline", [{"id": item, "title": titles[item]} for item in order])


def observe(session_id: str, kind: str, payload: dict) -> None:
    if kind == "author_message":
        text = payload.get("text") or ""
        if payload.get("section_id"):
            text = f"Раздел {payload['section_id']}. {text}"
        remember_dialog(session_id, "user", text)
        return
    if kind == "agent_message":
        remember_dialog(session_id, "assistant", payload.get("text") or "")
        return
    if kind == "decision":
        text = payload.get("text") or ""
        remember_dialog(session_id, "assistant", text)
        profile_id = _profile_id(session_id)
        if profile_id:
            remember_profile(profile_id, "decision", text)
        return
    if kind == "skeleton_current":
        skeleton = payload.get("skeleton")
        if skeleton:
            _put_json(session_id, "skeleton", skeleton)
            profile_id = _profile_id(session_id)
            if profile_id:
                remember_profile(profile_id, "skeleton", json.dumps(skeleton, ensure_ascii=False), replace=True)
        return
    if kind == "digest":
        _put_json(session_id, "digest", payload)
        return
    if kind == "section_version":
        _refresh_outline(session_id)
        return
    if kind == "file":
        refresh_files(session_id)
        return
    if kind == "example_saved":
        profile_id = _profile_id(session_id)
        spec_id = payload.get("spec_id") or ""
        if profile_id and spec_id:
            remember_profile(profile_id, "knowledge", spec_id)


def _summary(session_id: str) -> dict | None:
    with connection() as conn:
        row = conn.execute(
            "SELECT text, covered_id FROM dialog_summaries WHERE session_id = ?",
            (session_id,),
        ).fetchone()
    if row is None:
        return None
    return {"text": row["text"], "covered_id": row["covered_id"]}


def _save_summary(session_id: str, text: str, covered_id: int) -> None:
    with connection() as conn:
        conn.execute(
            """
            INSERT INTO dialog_summaries (session_id, text, covered_id, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                text = excluded.text,
                covered_id = excluded.covered_id,
                updated_at = excluded.updated_at
            """,
            (session_id, text, covered_id, _now()),
        )


async def _summarize(previous: str, batch: list[dict]) -> str:
    lines = []
    if previous:
        lines.append("Уже свёрнуто:\n" + previous)
    for item in batch:
        lines.append(f"{item['role']}: {item['text']}")
    source = "\n".join(lines).strip()
    from app import llm

    if not llm.configured("cheap"):
        return source[:2000]
    messages = [
        {
            "role": "system",
            "content": (
                "Сожми ранний диалог в короткий пересказ. "
                "Верни JSON {\"summary\": \"...\"}. Не добавляй фактов."
            ),
        },
        {"role": "user", "content": source[:12000]},
    ]
    try:
        result = await llm.chat("cheap", messages)
        data = llm.parse_json(result.text)
    except (ValueError, Exception):
        return source[:2000]
    summary = data.get("summary") if isinstance(data, dict) else None
    if not isinstance(summary, str) or not summary.strip():
        return source[:2000]
    return summary.strip()


async def refresh_summary(session_id: str) -> None:
    while True:
        rows = list_dialog(session_id)
        size = tail_size()
        if len(rows) <= size:
            return
        head = rows[:-size]
        current = _summary(session_id)
        covered = current["covered_id"] if current else 0
        pending = [item for item in head if item["id"] > covered]
        if len(pending) < size:
            return
        batch = pending[:size]
        text = await _summarize(current["text"] if current else "", batch)
        _save_summary(session_id, text, batch[-1]["id"])


def prompt_parts(session_id: str, profile: dict | None, record: dict | None = None) -> tuple[str, list[dict]]:
    working = working_items(session_id)
    record = record or {}
    lines = [
        f"Фича: {working.get('feature') or record.get('feature') or '—'}",
        f"Проект: {working.get('project') or record.get('project') or '—'}",
    ]
    long_term = _long_term_lines(profile)
    if long_term:
        lines.append("Долговременная память:\n" + "\n".join(long_term))
    task = _working_lines(working)
    if task:
        lines.append("Рабочая память:\n" + "\n".join(task))
    dialog = _window(session_id)
    return "\n".join(lines), dialog


def _long_term_lines(profile: dict | None) -> list[str]:
    if not profile:
        return []
    items = profile_items(profile["id"])
    lines = []
    note = next((item["content"] for item in reversed(items) if item["kind"] == "note"), "")
    if not note:
        note = profile.get("writing_note") or ""
    if note:
        lines.append("Заметка: " + note[:1000])
    skeleton = next((item["content"] for item in reversed(items) if item["kind"] == "skeleton"), "")
    if skeleton:
        lines.append("Каркас профиля: " + skeleton[:1500])
    decisions = [item["content"] for item in items if item["kind"] == "decision"][-6:]
    for text in decisions:
        lines.append("Решение: " + text[:500])
    knowledge = [item["content"] for item in items if item["kind"] == "knowledge"][-6:]
    if knowledge:
        lines.append("Примеры: " + ", ".join(knowledge))
    return lines


def _working_lines(working: dict[str, str]) -> list[str]:
    lines = []
    if working.get("skeleton"):
        lines.append("Каркас: " + working["skeleton"][:2000])
    if working.get("digest"):
        lines.append("Выжимка требований: " + working["digest"][:3000])
    if working.get("outline"):
        lines.append("Оглавление черновика: " + working["outline"][:2000])
    if working.get("files"):
        lines.append("Файлы: " + working["files"][:2000])
        try:
            files = json.loads(working["files"])
        except json.JSONDecodeError:
            files = []
        if files and all(item.get("extracted") or item.get("purpose") == "audio" for item in files):
            lines.append("Текст документов уже извлечён. extract_from_pdf не вызывай.")
    return lines


def _window(session_id: str) -> list[dict]:
    rows = list_dialog(session_id)
    size = tail_size()
    if len(rows) <= size:
        return [{"role": item["role"], "text": item["text"]} for item in rows]
    head = rows[:-size]
    tail = rows[-size:]
    current = _summary(session_id)
    covered = current["covered_id"] if current else 0
    pending = [item for item in head if item["id"] > covered]
    window = []
    if current and current["text"]:
        window.append({"role": "user", "text": "Краткое содержание раннего диалога:\n" + current["text"]})
    window.extend({"role": item["role"], "text": item["text"]} for item in pending)
    window.extend({"role": item["role"], "text": item["text"]} for item in tail)
    return window
