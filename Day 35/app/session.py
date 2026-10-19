import json
import uuid
from datetime import datetime, timezone

from app.db import connection
from app import memory, profile as profiles


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_turn() -> str:
    return uuid.uuid4().hex


def _snapshot(row) -> dict:
    data = dict(row)
    data["payload"] = json.loads(data["payload"])
    data["undone"] = bool(data["undone"])
    return data


def _job(row) -> dict | None:
    if row is None:
        return None
    data = dict(row)
    data["tool_trace"] = json.loads(data["tool_trace"])
    data["rag_block_ids"] = json.loads(data["rag_block_ids"])
    return data


def create_session(profile_id: str, feature: str, project: str = "") -> dict:
    feature = feature.strip()
    if not feature:
        raise ValueError("Опишите фичу")
    if profiles.get_profile(profile_id) is None:
        raise KeyError(profile_id)
    session_id = uuid.uuid4().hex
    turn_id = new_turn()
    now = _now()
    with connection() as conn:
        conn.execute(
            """
            INSERT INTO sessions (id, profile_id, feature, project, phase, stage, repo_path, created_at)
            VALUES (?, ?, ?, ?, 'paused', 'brief', NULL, ?)
            """,
            (session_id, profile_id, feature, project.strip(), now),
        )
        conn.execute(
            """
            INSERT INTO snapshots (session_id, turn_id, kind, payload, undone, created_at)
            VALUES (?, ?, 'feature', ?, 0, ?)
            """,
            (
                session_id,
                turn_id,
                json.dumps({"feature": feature, "project": project.strip()}, ensure_ascii=False),
                now,
            ),
        )
    memory.remember_working(session_id, "feature", feature)
    memory.remember_working(session_id, "project", project.strip())
    return get_session(session_id)


def get_session(session_id: str) -> dict | None:
    with connection() as conn:
        row = conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
    if row is None:
        return None
    return dict(row)


def set_phase(session_id: str, phase: str) -> None:
    with connection() as conn:
        conn.execute("UPDATE sessions SET phase = ? WHERE id = ?", (phase, session_id))


def set_stage(session_id: str, stage: str) -> None:
    with connection() as conn:
        conn.execute("UPDATE sessions SET stage = ? WHERE id = ?", (stage, session_id))


def set_repo(session_id: str, repo_path: str | None) -> None:
    with connection() as conn:
        conn.execute("UPDATE sessions SET repo_path = ? WHERE id = ?", (repo_path, session_id))


def cursor_agents(session_id: str) -> dict[str, str]:
    record = get_session(session_id)
    if record is None:
        return {}
    raw = record.get("cursor_agents") or "{}"
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(key): str(value) for key, value in data.items() if value}


def cursor_agent_id(session_id: str, slot: str) -> str | None:
    return cursor_agents(session_id).get(slot)


def set_cursor_agent(session_id: str, slot: str, agent_id: str) -> None:
    current = cursor_agents(session_id)
    current[slot] = agent_id
    with connection() as conn:
        conn.execute(
            "UPDATE sessions SET cursor_agents = ? WHERE id = ?",
            (json.dumps(current, ensure_ascii=False), session_id),
        )


def clear_cursor_agent(session_id: str, slot: str) -> None:
    current = cursor_agents(session_id)
    current.pop(slot, None)
    with connection() as conn:
        conn.execute(
            "UPDATE sessions SET cursor_agents = ? WHERE id = ?",
            (json.dumps(current, ensure_ascii=False), session_id),
        )


def clear_cursor_agents(session_id: str) -> None:
    with connection() as conn:
        conn.execute("UPDATE sessions SET cursor_agents = '{}' WHERE id = ?", (session_id,))


def add_snapshot(session_id: str, turn_id: str, kind: str, payload: dict) -> dict:
    now = _now()
    with connection() as conn:
        cur = conn.execute(
            """
            INSERT INTO snapshots (session_id, turn_id, kind, payload, undone, created_at)
            VALUES (?, ?, ?, ?, 0, ?)
            """,
            (session_id, turn_id, kind, json.dumps(payload, ensure_ascii=False), now),
        )
        row = conn.execute("SELECT * FROM snapshots WHERE id = ?", (cur.lastrowid,)).fetchone()
    snap = _snapshot(row)
    memory.observe(session_id, kind, snap["payload"])
    return snap


def list_snapshots(session_id: str, include_undone: bool = False) -> list[dict]:
    sql = "SELECT * FROM snapshots WHERE session_id = ?"
    if not include_undone:
        sql += " AND undone = 0"
    sql += " ORDER BY id"
    with connection() as conn:
        rows = conn.execute(sql, (session_id,)).fetchall()
    return [_snapshot(row) for row in rows]


def undo_turn(session_id: str, turn_id: str) -> None:
    with connection() as conn:
        conn.execute(
            "UPDATE snapshots SET undone = 1 WHERE session_id = ? AND turn_id = ?",
            (session_id, turn_id),
        )


def cancel_last(session_id: str) -> dict:
    snapshots = list_snapshots(session_id)
    if not snapshots:
        raise ValueError("Нечего отменять")
    latest = snapshots[-1]
    if latest["kind"] in {"feature"}:
        raise ValueError("Нечего отменять")
    turn_id = latest["turn_id"]
    protected = {"feature"}
    turn_snaps = [item for item in snapshots if item["turn_id"] == turn_id]
    if all(item["kind"] in protected for item in turn_snaps):
        raise ValueError("Нечего отменять")
    undo_turn(session_id, turn_id)
    recompute_phase(session_id)
    return {"undone_turn_id": turn_id}


def recompute_phase(session_id: str) -> str:
    set_phase(session_id, "paused")
    return "paused"


def latest_section_notes(session_id: str) -> list[dict]:
    order: list[str] = []
    versions: dict[str, dict] = {}
    for snap in list_snapshots(session_id):
        if snap["kind"] != "section_version":
            continue
        section = snap["payload"]["section"]
        section_id = section["id"]
        if section_id not in versions:
            order.append(section_id)
        versions[section_id] = {"section": section, "marks": snap["payload"].get("marks") or []}
    return [versions[section_id] for section_id in order]


def latest_of(session_id: str, kind: str) -> dict | None:
    found = [item for item in list_snapshots(session_id) if item["kind"] == kind]
    return found[-1] if found else None


def current_skeleton(session_id: str) -> dict | None:
    snap = latest_of(session_id, "skeleton_current")
    if snap is None:
        return None
    return snap["payload"].get("skeleton")


def current_digest(session_id: str) -> dict | None:
    snap = latest_of(session_id, "digest")
    return snap["payload"] if snap else None


def latest_sections(session_id: str) -> list[dict]:
    order: list[str] = []
    versions: dict[str, dict] = {}
    for snap in list_snapshots(session_id):
        if snap["kind"] != "section_version":
            continue
        section = snap["payload"]["section"]
        section_id = section["id"]
        if section_id not in versions:
            order.append(section_id)
        versions[section_id] = section
    return [versions[section_id] for section_id in order]


def section_history(session_id: str) -> dict[str, list[dict]]:
    history: dict[str, list[dict]] = {}
    for snap in list_snapshots(session_id):
        if snap["kind"] != "section_version":
            continue
        section = snap["payload"]["section"]
        history.setdefault(section["id"], []).append(section)
    return history


def open_proposal(session_id: str) -> dict | None:
    proposal = None
    for snap in list_snapshots(session_id):
        if snap["kind"] == "skeleton_proposal":
            proposal = snap
        elif snap["kind"] == "skeleton_current":
            proposal = None
    return proposal["payload"] if proposal else None


def open_choice(session_id: str) -> dict | None:
    choice = None
    for snap in list_snapshots(session_id):
        if snap["kind"] == "skeleton_choice":
            choice = snap
        elif snap["kind"] == "skeleton_current":
            choice = None
    return choice["payload"] if choice else None


def create_job(session_id: str) -> dict:
    now = _now()
    with connection() as conn:
        cur = conn.execute(
            """
            INSERT INTO jobs (
                session_id, status, slot, model_name, tool_trace, rag_block_ids,
                prompt_chars, tokens_in, tokens_out, duration_ms, detail, created_at, finished_at
            ) VALUES (?, 'pending', NULL, NULL, '[]', '[]', 0, 0, 0, 0, '', ?, NULL)
            """,
            (session_id, now),
        )
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (cur.lastrowid,)).fetchone()
    set_phase(session_id, "running")
    return _job(row)


def get_job(job_id: int) -> dict | None:
    with connection() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    return _job(row)


def latest_job(session_id: str) -> dict | None:
    with connection() as conn:
        row = conn.execute(
            "SELECT * FROM jobs WHERE session_id = ? ORDER BY id DESC LIMIT 1",
            (session_id,),
        ).fetchone()
    return _job(row)


def job_pending(session_id: str) -> bool:
    job = latest_job(session_id)
    return bool(job and job["status"] == "pending")


def job_is_cancelled(job_id: int) -> bool:
    job = get_job(job_id)
    return bool(job and job["status"] == "cancelled")


def request_stop(session_id: str) -> int | None:
    job = latest_job(session_id)
    if job is None or job["status"] != "pending":
        return None
    with connection() as conn:
        cur = conn.execute(
            "UPDATE jobs SET status = 'cancelled', detail = 'stopped' WHERE id = ? AND status = 'pending'",
            (job["id"],),
        )
        if cur.rowcount == 0:
            return None
    return job["id"]


def finish_job(job_id: int, status: str, **fields) -> None:
    job = get_job(job_id)
    if job is None:
        return
    if job["status"] == "cancelled":
        status = "cancelled"
    tool_trace = fields.get("tool_trace", job["tool_trace"])
    rag_block_ids = fields.get("rag_block_ids", job["rag_block_ids"])
    now = _now()
    with connection() as conn:
        conn.execute(
            """
            UPDATE jobs SET
                status = ?,
                slot = ?,
                model_name = ?,
                tool_trace = ?,
                rag_block_ids = ?,
                prompt_chars = ?,
                tokens_in = ?,
                tokens_out = ?,
                history_tokens = ?,
                duration_ms = ?,
                detail = ?,
                finished_at = ?
            WHERE id = ?
            """,
            (
                status,
                fields.get("slot", job["slot"]),
                fields.get("model_name", job["model_name"]),
                json.dumps(tool_trace, ensure_ascii=False),
                json.dumps(rag_block_ids, ensure_ascii=False),
                int(fields.get("prompt_chars", job["prompt_chars"])),
                int(fields.get("tokens_in", job["tokens_in"])),
                int(fields.get("tokens_out", job["tokens_out"])),
                int(fields.get("history_tokens", job.get("history_tokens") or 0)),
                int(fields.get("duration_ms", job["duration_ms"])),
                fields.get("detail", job["detail"]),
                now,
                job_id,
            ),
        )


def add_file(session_id: str, purpose: str, filename: str, path: str) -> dict:
    file_id = uuid.uuid4().hex
    now = _now()
    with connection() as conn:
        conn.execute(
            """
            INSERT INTO files (id, session_id, purpose, filename, path, extracted_text, headings_json, created_at)
            VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
            """,
            (file_id, session_id, purpose, filename, path, now),
        )
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
    return _file(row)


def store_extraction(file_id: str, text: str, headings: list[str]) -> None:
    with connection() as conn:
        conn.execute(
            "UPDATE files SET extracted_text = ?, headings_json = ? WHERE id = ?",
            (text, json.dumps(headings, ensure_ascii=False), file_id),
        )
        row = conn.execute("SELECT session_id FROM files WHERE id = ?", (file_id,)).fetchone()
    if row is not None:
        memory.refresh_files(row["session_id"])


def _file(row) -> dict:
    data = dict(row)
    raw = data.get("headings_json")
    data["headings"] = json.loads(raw) if raw else []
    return data


def get_file(file_id: str) -> dict | None:
    with connection() as conn:
        row = conn.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
    return _file(row) if row else None


def purge_session(session_id: str) -> dict | None:
    record = get_session(session_id)
    if record is None:
        return None
    paths = [item["path"] for item in list_files(session_id)]
    with connection() as conn:
        conn.execute("DELETE FROM snapshots WHERE session_id = ?", (session_id,))
        conn.execute("DELETE FROM jobs WHERE session_id = ?", (session_id,))
        conn.execute("DELETE FROM files WHERE session_id = ?", (session_id,))
        memory.forget_session(conn, session_id)
        conn.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
    return {"profile_id": record["profile_id"], "paths": paths}


def list_files(session_id: str, purpose: str | None = None) -> list[dict]:
    sql = "SELECT * FROM files WHERE session_id = ?"
    params: list = [session_id]
    if purpose:
        sql += " AND purpose = ?"
        params.append(purpose)
    sql += " ORDER BY created_at"
    with connection() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [_file(row) for row in rows]
