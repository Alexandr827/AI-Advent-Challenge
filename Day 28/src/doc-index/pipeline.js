import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJsonAtomic } from "../fs-utils.js";
import { chunkFixed, chunkStructural } from "./chunk.js";
import { compareStrategies, formatComparison } from "./compare.js";
import { absoluteDocumentPath, loadDocument, loadLaw, storedDocumentPath } from "./corpus.js";
import { EMBED_DIM, embed } from "./embed.js";
import { writeIndex } from "./store.js";

const USAGE = "Использование: index load <файл> [--source S] [--title T] [--strategy fixed|structural|both]";

export function indexChunks(doc, strategy = "both") {
  const selected = normalizeChunkStrategy(strategy);
  const chunks = [];
  if (selected === "fixed" || selected === "both") chunks.push(...chunkFixed(doc));
  if (selected === "structural" || selected === "both") chunks.push(...chunkStructural(doc));
  return chunks.map((chunk) => ({
    ...chunk,
    embedding: embed(chunk.text),
  }));
}

export function indexDocuments(docs) {
  return docs.flatMap((doc) => indexChunks(doc, doc.chunkStrategy));
}

export function indexLaw(root) {
  const doc = loadLaw(root);
  const chunks = indexChunks(doc);
  const dir = join(root, "data", "doc-index");
  const dbPath = join(dir, "law.sqlite");
  const comparisonPath = join(dir, "comparison.md");
  mkdirSync(dirname(dbPath), { recursive: true });
  writeIndex(dbPath, chunks);
  const report = compareStrategies(chunks, { chars: doc.text.length });
  writeFileSync(comparisonPath, formatComparison(report));
  return { dbPath, comparisonPath, report, chunks: chunks.length };
}

export async function indexCorpus(root, paths, { source, title, strategy } = {}) {
  if (!paths?.length) {
    throw new Error(USAGE);
  }
  if (strategy != null) normalizeChunkStrategy(strategy);
  const dir = join(root, "data", "doc-index");
  const manifestPath = join(dir, "manifest.json");
  const dbPath = join(dir, "corpus.sqlite");
  const jsonPath = join(dir, "corpus.json");
  const comparisonPath = join(dir, "corpus-comparison.md");
  const manifest = readManifest(manifestPath);
  const incoming = [];
  for (const filePath of paths) {
    const stored = storedDocumentPath(root, filePath);
    const abs = absoluteDocumentPath(root, stored);
    await loadDocument(abs, {
      root,
      source: source ?? undefined,
      title: title ?? undefined,
    });
    incoming.push({ path: stored, source, title, strategy });
  }
  for (const entry of incoming) upsertFile(manifest.files, entry);

  const docs = [];
  for (const entry of manifest.files) {
    const doc = await loadDocument(absoluteDocumentPath(root, entry.path), {
      root,
      source: entry.source ?? undefined,
      title: entry.title ?? undefined,
    });
    doc.chunkStrategy = storedChunkStrategy(entry.strategy);
    docs.push(doc);
  }
  const chunks = indexDocuments(docs);
  const report = compareStrategies(chunks, {
    chars: docs.reduce((sum, doc) => sum + doc.text.length, 0),
  });
  mkdirSync(dir, { recursive: true });
  writeIndex(dbPath, chunks);
  writeJsonAtomic(jsonPath, corpusJson(docs, chunks));
  writeFileSync(comparisonPath, formatComparison(report));
  writeJsonAtomic(manifestPath, manifest);
  return {
    dbPath,
    jsonPath,
    comparisonPath,
    manifestPath,
    report,
    dim: EMBED_DIM,
    chunks: chunks.length,
    docs: docs.map((doc) => ({
      file: doc.file,
      kind: doc.kind,
      chars: doc.text.length,
      strategy: doc.chunkStrategy,
    })),
  };
}

export function formatIndexRun(result) {
  const lines = [];
  for (const doc of result.docs) {
    lines.push(`load: ${doc.file} kind=${doc.kind} chars=${doc.chars} strategy=${doc.strategy}`);
  }
  const { fixed, structural } = result.report.strategies;
  lines.push(`chunk fixed: ${fixed.count}`);
  lines.push(`chunk structural: ${structural.count}`);
  lines.push(`embed: dim=${result.dim}`);
  lines.push(`write: ${result.dbPath}`);
  lines.push(`write: ${result.jsonPath}`);
  lines.push(`compare: ${result.comparisonPath}`);
  return lines.join("\n");
}

function corpusJson(docs, chunks) {
  return {
    dim: EMBED_DIM,
    documents: docs.map((doc) => ({
      source: doc.source,
      title: doc.title,
      file: doc.file,
      kind: doc.kind,
    })),
    chunks: chunks.map((chunk) => ({
      chunk_id: chunk.chunk_id,
      source: chunk.source,
      title: chunk.title,
      file: chunk.file,
      section: chunk.section,
      strategy: chunk.strategy,
      text: chunk.text,
      embedding: Array.from(chunk.embedding),
    })),
  };
}

function normalizeChunkStrategy(strategy) {
  if (strategy == null || strategy === "both") return "both";
  if (strategy === "fixed" || strategy === "structural") return strategy;
  throw new Error("Стратегия чанкинга: fixed, structural или both");
}

function storedChunkStrategy(strategy) {
  return strategy === "fixed" || strategy === "structural" ? strategy : "both";
}

function readManifest(filePath) {
  if (!existsSync(filePath)) return { files: [] };
  const data = JSON.parse(readFileSync(filePath, "utf8"));
  return { files: Array.isArray(data.files) ? data.files : [] };
}

function upsertFile(files, entry) {
  const index = files.findIndex((item) => item.path === entry.path);
  if (index < 0) {
    files.push({
      path: entry.path,
      source: entry.source ?? null,
      title: entry.title ?? null,
      strategy: entry.strategy ?? "both",
    });
    return;
  }
  const prev = files[index];
  files[index] = {
    path: entry.path,
    source: entry.source === undefined ? prev.source : entry.source,
    title: entry.title === undefined ? prev.title : entry.title,
    strategy: entry.strategy === undefined ? storedChunkStrategy(prev.strategy) : entry.strategy,
  };
}
