import { existsSync, readFileSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { extractText } from "unpdf";

const TEXT_EXT = new Set([".md", ".txt", ".markdown"]);
const DATA_EXT = new Set([".json", ".yml", ".yaml", ".sql", ".prisma", ".graphql", ".gql"]);

export function storedDocumentPath(root, filePath) {
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return abs;
  return rel.split(sep).join("/");
}

export function absoluteDocumentPath(root, stored) {
  return isAbsolute(stored) ? stored : resolve(root, stored);
}

/** doc — README и docs; schema — схемы данных; api — OpenAPI/Swagger. */
export function documentRole(filePath) {
  const base = basename(String(filePath ?? "")).toLowerCase();
  const ext = extname(base);
  if (/openapi|swagger/.test(base)) return "api";
  if (ext === ".sql" || ext === ".prisma" || ext === ".graphql" || ext === ".gql") return "schema";
  if (ext === ".json" && base.includes("schema")) return "schema";
  return "doc";
}

export async function loadDocument(filePath, { source, title, root } = {}) {
  const abs = root ? absoluteDocumentPath(root, storedDocumentPath(root, filePath)) : resolve(filePath);
  if (!existsSync(abs)) {
    throw new Error(`Файл не найден: ${abs}`);
  }
  const ext = extname(abs).toLowerCase();
  const file = root ? storedDocumentPath(root, abs) : basename(abs);
  let kind;
  let text;
  if (TEXT_EXT.has(ext)) {
    text = readUtf8(abs);
    kind = ext === ".txt" ? "txt" : "md";
  } else if (ext === ".pdf") {
    text = await readPdf(abs);
    kind = "pdf";
  } else if (DATA_EXT.has(ext)) {
    text = readUtf8(abs);
    kind = dataKind(ext);
  } else {
    throw new Error(`Неизвестное расширение: ${abs}`);
  }
  const derivedTitle =
    title ??
    (kind === "md" || kind === "txt" ? titleFromMarkdown(text, basename(abs)) : basename(abs));
  return {
    source: source ?? file,
    title: derivedTitle,
    file,
    kind,
    role: documentRole(file),
    text,
  };
}

function dataKind(ext) {
  if (ext === ".json") return "json";
  if (ext === ".yml" || ext === ".yaml") return "yaml";
  if (ext === ".sql") return "sql";
  if (ext === ".prisma") return "prisma";
  return "graphql";
}

function readUtf8(filePath) {
  const text = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n").trim();
  if (!text) {
    throw new Error(`Пустой документ: ${filePath}`);
  }
  return text;
}

function titleFromMarkdown(text, fallback) {
  const match = text.match(/^#\s+(\S.*?)\s*$/m);
  return match ? match[1].trim() : fallback;
}

async function readPdf(filePath) {
  const data = new Uint8Array(readFileSync(filePath));
  const extracted = await extractText(data, { mergePages: false });
  const pages = Array.isArray(extracted.text) ? extracted.text : [extracted.text];
  const parts = [];
  pages.forEach((page, index) => {
    const body = String(page ?? "").replace(/\r\n/g, "\n").trim();
    if (!body) return;
    parts.push(`page ${index + 1}\n${body}`);
  });
  if (!parts.length) {
    throw new Error(`Пустой документ: ${filePath}`);
  }
  return parts.join("\n\n");
}
