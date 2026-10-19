import os
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None
_conn_path: str | None = None


def data_dir() -> Path:
    path = Path(os.environ.get("DATA_DIR", "data"))
    path.mkdir(parents=True, exist_ok=True)
    (path / "files").mkdir(exist_ok=True)
    (path / "out").mkdir(exist_ok=True)
    return path


def reset_connection() -> None:
    global _conn, _conn_path
    with _lock:
        if _conn is not None:
            _conn.close()
        _conn = None
        _conn_path = None


def _connect() -> sqlite3.Connection:
    global _conn, _conn_path
    path = str(data_dir() / "app.sqlite")
    if _conn is not None and _conn_path == path:
        return _conn
    if _conn is not None:
        _conn.close()
    conn = sqlite3.connect(path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    _init(conn)
    _conn = conn
    _conn_path = path
    return conn


def _init(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS profiles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            writing_note TEXT NOT NULL DEFAULT '',
            skeleton_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            profile_id TEXT NOT NULL,
            feature TEXT NOT NULL,
            project TEXT NOT NULL DEFAULT '',
            phase TEXT NOT NULL,
            stage TEXT NOT NULL DEFAULT 'brief',
            repo_path TEXT,
            cursor_agents TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            FOREIGN KEY(profile_id) REFERENCES profiles(id)
        );

        CREATE TABLE IF NOT EXISTS snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            payload TEXT NOT NULL,
            undone INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_snapshots_session
            ON snapshots(session_id, id);

        CREATE TABLE IF NOT EXISTS jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            status TEXT NOT NULL,
            slot TEXT,
            model_name TEXT,
            tool_trace TEXT NOT NULL DEFAULT '[]',
            rag_block_ids TEXT NOT NULL DEFAULT '[]',
            prompt_chars INTEGER NOT NULL DEFAULT 0,
            tokens_in INTEGER NOT NULL DEFAULT 0,
            tokens_out INTEGER NOT NULL DEFAULT 0,
            history_tokens INTEGER NOT NULL DEFAULT 0,
            duration_ms INTEGER NOT NULL DEFAULT 0,
            detail TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            finished_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_jobs_session ON jobs(session_id, id);

        CREATE TABLE IF NOT EXISTS files (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            purpose TEXT NOT NULL,
            filename TEXT NOT NULL,
            path TEXT NOT NULL,
            extracted_text TEXT,
            headings_json TEXT,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS rag_blocks (
            id TEXT PRIMARY KEY,
            spec_id TEXT NOT NULL,
            heading TEXT NOT NULL,
            body TEXT NOT NULL,
            session_id TEXT,
            created_at TEXT NOT NULL
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS rag_fts USING fts5(
            heading,
            body,
            block_id UNINDEXED,
            tokenize = 'unicode61'
        );

        CREATE TABLE IF NOT EXISTS dialog_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            role TEXT NOT NULL,
            text TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_dialog_session
            ON dialog_messages(session_id, id);

        CREATE TABLE IF NOT EXISTS dialog_summaries (
            session_id TEXT PRIMARY KEY,
            text TEXT NOT NULL,
            covered_id INTEGER NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS working_memory (
            session_id TEXT NOT NULL,
            key TEXT NOT NULL,
            content TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (session_id, key)
        );

        CREATE TABLE IF NOT EXISTS profile_memory (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            profile_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_profile_memory
            ON profile_memory(profile_id, id);
        """
    )
    columns = {row[1] for row in conn.execute("PRAGMA table_info(sessions)")}
    if "cursor_agents" not in columns:
        conn.execute("ALTER TABLE sessions ADD COLUMN cursor_agents TEXT NOT NULL DEFAULT '{}'")
    if "stage" not in columns:
        conn.execute("ALTER TABLE sessions ADD COLUMN stage TEXT NOT NULL DEFAULT 'brief'")
    job_columns = {row[1] for row in conn.execute("PRAGMA table_info(jobs)")}
    if "history_tokens" not in job_columns:
        conn.execute("ALTER TABLE jobs ADD COLUMN history_tokens INTEGER NOT NULL DEFAULT 0")


@contextmanager
def connection():
    with _lock:
        conn = _connect()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
