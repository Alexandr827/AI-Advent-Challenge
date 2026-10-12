import { existsSync, readdirSync } from "node:fs";
import { basename, extname, join, sep } from "node:path";
import { writeJsonAtomic } from "../fs-utils.js";
import { chunkStructural } from "./chunk.js";
import { documentRole, loadDocument } from "./load.js";
import { embed } from "./embed.js";
import { openIndex, searchChunks, writeIndex } from "./store.js";

export const PROJECT_TOP_K = 4;

const SKIP_DIRS = new Set(["node_modules", ".git", "data"]);
const DOC_EXT = new Set([".md", ".txt", ".markdown", ".pdf"]);
const SCHEMA_EXT = new Set([".sql", ".prisma", ".graphql", ".gql"]);

const STRUCTURE_RE = /структур|устроен|каталог|архитектур|состав проект|какие папк|где лежит/i;

export function projectIndexPaths(root) {
  const dir = join(root, "data", "doc-index");
  return {
    dbPath: join(dir, "project.sqlite"),
    manifestPath: join(dir, "project-manifest.json"),
  };
}

export function isProjectDoc(relPath) {
  const norm = String(relPath ?? "").split(sep).join("/");
  const base = basename(norm);
  const ext = extname(base).toLowerCase();
  const lower = base.toLowerCase();
  if (!norm.includes("/") && /^readme\.(md|txt|markdown)$/i.test(base)) return true;
  if ((norm === "docs" || norm.startsWith("docs/")) && DOC_EXT.has(ext)) return true;
  if (SCHEMA_EXT.has(ext)) return true;
  if ((ext === ".json" || ext === ".yml" || ext === ".yaml") && /openapi|swagger/.test(lower)) {
    return true;
  }
  if (ext === ".json" && lower.includes("schema")) return true;
  return false;
}

export function collectProjectDocs(root) {
  const found = new Set();
  walk(root, "");
  return [...found].sort();

  function walk(dir, rel) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isProjectDoc(childRel)) found.add(childRel);
    }
  }
}

export async function indexProjectDocs(root) {
  const paths = collectProjectDocs(root);
  if (!paths.length) {
    throw new Error("В проекте нет README, docs, схем или API-описаний для индекса");
  }
  const docs = [];
  for (const rel of paths) {
    const doc = await loadDocument(rel, { root, source: "project" });
    doc.role = doc.role ?? documentRole(rel);
    docs.push(doc);
  }
  const chunks = docs.flatMap((doc) =>
    chunkStructural(doc).map((chunk) => ({
      ...chunk,
      embedding: embed(chunk.text),
    })),
  );
  const { dbPath, manifestPath } = projectIndexPaths(root);
  writeIndex(dbPath, chunks);
  const manifest = {
    files: docs.map((doc) => ({
      path: doc.file,
      role: doc.role,
      kind: doc.kind,
      title: doc.title,
    })),
  };
  writeJsonAtomic(manifestPath, manifest);
  return { dbPath, manifestPath, chunks: chunks.length, docs, manifest };
}

export function formatProjectIndex(result) {
  const lines = [];
  for (const doc of result.docs) {
    lines.push(`load: ${doc.file} role=${doc.role} kind=${doc.kind} chars=${doc.text.length}`);
  }
  lines.push(`chunks: ${result.chunks}`);
  lines.push(`write: ${result.dbPath}`);
  lines.push(`write: ${result.manifestPath}`);
  return lines.join("\n");
}

export function isStructureQuestion(query) {
  return STRUCTURE_RE.test(String(query ?? ""));
}

export function retrieveProjectContext(query, { indexPath, k = PROJECT_TOP_K } = {}) {
  const searchQuery = String(query ?? "").trim();
  if (!indexPath || !existsSync(indexPath)) {
    return { hits: [], searchQuery };
  }
  const db = openIndex(indexPath, { readOnly: true });
  try {
    let hits = searchQuery
      ? searchChunks(db, embed(searchQuery), { strategy: "structural", k })
      : [];
    if (!searchQuery || isStructureQuestion(searchQuery)) {
      const overview = readmeOverview(db);
      if (overview && !hits.some((hit) => hit.chunk_id === overview.chunk_id)) {
        hits = [overview, ...hits];
      }
    }
    return { hits, searchQuery };
  } finally {
    db.close();
  }
}

function readmeOverview(db) {
  const rows = db
    .prepare(
      `SELECT chunk_id, strategy, source, title, file, section, text
       FROM chunks
       WHERE strategy = 'structural' AND lower(file) LIKE 'readme%'`,
    )
    .all();
  if (!rows.length) return null;
  rows.sort((left, right) => chunkIndex(left.chunk_id) - chunkIndex(right.chunk_id));
  return { ...rows[0], score: 1 };
}

function chunkIndex(chunkId) {
  const match = String(chunkId ?? "").match(/:(\d+)$/);
  return match ? Number(match[1]) : 0;
}
