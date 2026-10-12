import { mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cosine } from "./embed.js";

const SCHEMA = `
CREATE TABLE chunks (
  chunk_id TEXT PRIMARY KEY,
  strategy TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  file TEXT NOT NULL,
  section TEXT NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB NOT NULL
);
CREATE INDEX idx_chunks_strategy ON chunks(strategy);
`;

export function openIndex(filePath, { readOnly = false } = {}) {
  return new DatabaseSync(filePath, { readOnly });
}

export function writeIndex(filePath, chunks) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  rmSync(tmp, { force: true });
  const db = new DatabaseSync(tmp);
  try {
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec(SCHEMA);
    const insert = db.prepare(
      `INSERT INTO chunks
        (chunk_id, strategy, source, title, file, section, text, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.exec("BEGIN");
    for (const chunk of chunks) {
      insert.run(
        chunk.chunk_id,
        chunk.strategy,
        chunk.source,
        chunk.title,
        chunk.file,
        chunk.section,
        chunk.text,
        vecToBlob(chunk.embedding),
      );
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  renameSync(tmp, filePath);
}

export function searchChunks(db, vector, { strategy = "structural", k = 4 } = {}) {
  const rows = db
    .prepare(
      `SELECT chunk_id, strategy, source, title, file, section, text, embedding
       FROM chunks WHERE strategy = ?`,
    )
    .all(strategy);
  return rows
    .map((row) => ({
      chunk_id: row.chunk_id,
      strategy: row.strategy,
      source: row.source,
      title: row.title,
      file: row.file,
      section: row.section,
      text: row.text,
      score: cosine(vector, blobToVec(row.embedding)),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, k);
}

function vecToBlob(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function blobToVec(blob) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const copy = new ArrayBuffer(buf.byteLength);
  new Uint8Array(copy).set(buf);
  return new Float32Array(copy);
}
