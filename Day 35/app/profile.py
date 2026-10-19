import json
import uuid
from datetime import datetime, timezone

from app import memory
from app.db import connection


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row(row) -> dict | None:
    if row is None:
        return None
    data = dict(row)
    raw = data.pop("skeleton_json", None)
    data["skeleton"] = json.loads(raw) if raw else None
    return data


def create_profile(name: str, writing_note: str = "") -> dict:
    cleaned = name.strip()
    if not cleaned:
        raise ValueError("У профиля должно быть имя")
    profile_id = uuid.uuid4().hex
    now = _now()
    with connection() as conn:
        conn.execute(
            """
            INSERT INTO profiles (id, name, writing_note, skeleton_json, created_at, updated_at)
            VALUES (?, ?, ?, NULL, ?, ?)
            """,
            (profile_id, cleaned, writing_note.strip(), now, now),
        )
        row = conn.execute("SELECT * FROM profiles WHERE id = ?", (profile_id,)).fetchone()
    if writing_note.strip():
        memory.remember_profile(profile_id, "note", writing_note.strip(), replace=True)
    return _row(row)


def list_profiles() -> list[dict]:
    with connection() as conn:
        rows = conn.execute("SELECT * FROM profiles ORDER BY updated_at DESC").fetchall()
    return [_row(row) for row in rows]


def get_profile(profile_id: str) -> dict | None:
    with connection() as conn:
        row = conn.execute("SELECT * FROM profiles WHERE id = ?", (profile_id,)).fetchone()
    return _row(row)


def update_note(profile_id: str, writing_note: str) -> dict:
    profile = get_profile(profile_id)
    if profile is None:
        raise KeyError(profile_id)
    now = _now()
    with connection() as conn:
        conn.execute(
            "UPDATE profiles SET writing_note = ?, updated_at = ? WHERE id = ?",
            (writing_note.strip(), now, profile_id),
        )
        row = conn.execute("SELECT * FROM profiles WHERE id = ?", (profile_id,)).fetchone()
    memory.remember_profile(profile_id, "note", writing_note.strip(), replace=True)
    return _row(row)


def update_skeleton(profile_id: str, skeleton: dict) -> dict:
    profile = get_profile(profile_id)
    if profile is None:
        raise KeyError(profile_id)
    now = _now()
    with connection() as conn:
        conn.execute(
            "UPDATE profiles SET skeleton_json = ?, updated_at = ? WHERE id = ?",
            (json.dumps(skeleton, ensure_ascii=False), now, profile_id),
        )
        row = conn.execute("SELECT * FROM profiles WHERE id = ?", (profile_id,)).fetchone()
    memory.remember_profile(profile_id, "skeleton", json.dumps(skeleton, ensure_ascii=False), replace=True)
    return _row(row)
