import re
import uuid
from datetime import datetime, timezone

from app.db import connection
from app.ingest import chunk_by_headings

MAX_LIMIT = 5


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def add_spec(text: str, session_id: str | None = None) -> dict:
    chunks = chunk_by_headings(text)
    if not chunks:
        raise ValueError("В примере нет текста")
    spec_id = uuid.uuid4().hex
    now = _now()
    stored = []
    with connection() as conn:
        for chunk in chunks:
            block_id = uuid.uuid4().hex
            heading = chunk["heading"].strip() or "Раздел"
            body = chunk["body"].strip()[:8000]
            conn.execute(
                """
                INSERT INTO rag_blocks (id, spec_id, heading, body, session_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (block_id, spec_id, heading, body, session_id, now),
            )
            conn.execute(
                "INSERT INTO rag_fts (heading, body, block_id) VALUES (?, ?, ?)",
                (heading, body, block_id),
            )
            stored.append({"id": block_id, "spec_id": spec_id, "heading": heading, "body": body})
    return {"spec_id": spec_id, "blocks": stored}


def add_sections(sections: list[dict], session_id: str | None = None) -> dict:
    lines = []
    for section in sections:
        lines.append(f"# {section['title']}")
        for block in section.get("blocks", []):
            lines.append(block.get("text", ""))
        lines.append("")
    return add_spec("\n".join(lines), session_id=session_id)


def _fts_query(text: str) -> str:
    words = re.findall(r"\w{3,}", text, flags=re.UNICODE)
    words = words[:12]
    if not words:
        return ""
    return " OR ".join(f'"{word}"' for word in words)


def _rows_to_blocks(rows) -> list[dict]:
    blocks = []
    for row in rows:
        blocks.append(
            {
                "id": row["block_id"],
                "heading": row["heading"],
                "body": row["body"],
                "spec_id": row["spec_id"],
            }
        )
    return blocks


def search(query: str, limit: int = 3, heading: str | None = None) -> list[dict]:
    limit = max(1, min(int(limit), MAX_LIMIT))
    match = _fts_query(heading or query)
    body_match = _fts_query(query)
    if not match and not body_match:
        return []
    with connection() as conn:
        rows = []
        if match:
            heading_match = " OR ".join(
                f'heading : "{word}"' for word in re.findall(r"\w{3,}", heading or query, flags=re.UNICODE)[:12]
            )
            rows = conn.execute(
                """
                SELECT rag_fts.block_id AS block_id, rag_blocks.heading AS heading,
                       rag_blocks.body AS body, rag_blocks.spec_id AS spec_id
                FROM rag_fts
                JOIN rag_blocks ON rag_blocks.id = rag_fts.block_id
                WHERE rag_fts MATCH ?
                LIMIT ?
                """,
                (heading_match, limit),
            ).fetchall()
        if len(rows) < limit and body_match:
            seen = {row["block_id"] for row in rows}
            extra = conn.execute(
                """
                SELECT rag_fts.block_id AS block_id, rag_blocks.heading AS heading,
                       rag_blocks.body AS body, rag_blocks.spec_id AS spec_id
                FROM rag_fts
                JOIN rag_blocks ON rag_blocks.id = rag_fts.block_id
                WHERE rag_fts MATCH ?
                LIMIT ?
                """,
                (body_match, limit),
            ).fetchall()
            for row in extra:
                if row["block_id"] in seen:
                    continue
                rows.append(row)
                seen.add(row["block_id"])
                if len(rows) >= limit:
                    break
    return _rows_to_blocks(rows[:limit])


def headings_by_spec(query: str, limit_specs: int = 2) -> list[dict]:
    blocks = search(query, limit=MAX_LIMIT)
    grouped: dict[str, list[str]] = {}
    for block in blocks:
        grouped.setdefault(block["spec_id"], [])
        if block["heading"] not in grouped[block["spec_id"]]:
            grouped[block["spec_id"]].append(block["heading"])
    specs = []
    for spec_id, headings in grouped.items():
        specs.append({"spec_id": spec_id, "headings": headings})
        if len(specs) >= limit_specs:
            break
    return specs
