import { existsSync, readFileSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { extractText } from "unpdf";

export const LAW_SOURCE = "38-ФЗ";
export const LAW_TITLE = "Федеральный закон «О рекламе»";
export const LAW_FILE = "docs/fz-38-o-reklame.md";

const TEXT_EXT = new Set([".md", ".txt", ".markdown"]);
const CODE_EXT = new Set([".js", ".mjs", ".cjs", ".ts"]);

export function lawFilePath(root) {
  return joinSafe(root, LAW_FILE);
}

export function loadTextDocument(filePath, { source, title, file } = {}) {
  const text = readUtf8(filePath);
  const name = file ?? basename(filePath);
  const kind = extname(filePath).toLowerCase() === ".md" ? "md" : "txt";
  return {
    source: source ?? LAW_SOURCE,
    title: title ?? LAW_TITLE,
    file: name,
    kind,
    text,
  };
}

export function loadLaw(root) {
  return loadTextDocument(lawFilePath(root), {
    source: LAW_SOURCE,
    title: LAW_TITLE,
    file: LAW_FILE,
  });
}

export function storedDocumentPath(root, filePath) {
  const abs = isAbsolute(filePath) ? resolve(filePath) : resolve(root, filePath);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return abs;
  return rel.split(sep).join("/");
}

export function absoluteDocumentPath(root, stored) {
  return isAbsolute(stored) ? stored : resolve(root, stored);
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
  } else if (CODE_EXT.has(ext)) {
    text = readUtf8(abs);
    kind = "code";
  } else if (ext === ".pdf") {
    text = await readPdf(abs);
    kind = "pdf";
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
    text,
  };
}

function joinSafe(root, file) {
  return resolve(root, file);
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
