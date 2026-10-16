import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { ensureProjectIndex } from "./assistant.js";
import { completeChat } from "./llm.js";
import { chunkStructural } from "./rag/chunk.js";
import { cosine, embed } from "./rag/embed.js";
import { retrieveProjectContext } from "./rag/project.js";

const execFileAsync = promisify(execFile);

export const REVIEW_DIFF_LIMIT = 12_000;
export const CODE_REVIEW_TOP_K = 6;
export const DOC_REVIEW_TOP_K = 4;

const CODE_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx"]);
const BUG_MARKERS = [
  /\bTODO\b/i,
  /\bFIXME\b/i,
  /\beval\s*\(/,
  /catch\s*\([^)]*\)\s*\{\s*\}/,
  /^-\s*.*\b(it|test)\s*\(/m,
];

const SECTION_BUGS = "## Потенциальные баги";
const SECTION_ARCH = "## Архитектурные проблемы";
const SECTION_REC = "## Рекомендации";

export async function runGit(root, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.replace(/\s+$/u, "");
}

const DEFAULT_BASE_REFS = ["main", "master", "origin/main"];

export async function resolveDefaultBase(root) {
  for (const ref of DEFAULT_BASE_REFS) {
    try {
      await runGit(root, ["rev-parse", "--verify", ref]);
      return ref;
    } catch {
      // try next
    }
  }
  return null;
}

export async function resolveDiffRange(root, { base, head } = {}) {
  const envBase = process.env.PR_BASE_SHA?.trim();
  const envHead = process.env.PR_HEAD_SHA?.trim();
  const resolvedBase = base ?? envBase;
  const resolvedHead = head ?? envHead;
  if (resolvedBase && resolvedHead) {
    return { mode: "range", base: resolvedBase, head: resolvedHead };
  }
  const defaultBase = await resolveDefaultBase(root);
  if (defaultBase) {
    return { mode: "range", base: defaultBase, head: "HEAD" };
  }
  return { mode: "working-tree" };
}

export function trimDiffText(diffText) {
  let text = String(diffText ?? "").trim() || "Изменений нет.";
  if (text.length > REVIEW_DIFF_LIMIT) {
    text = `${text.slice(0, REVIEW_DIFF_LIMIT)}\n… обрезано`;
  }
  return text;
}

export function parseChangedFilesFromDiff(text) {
  const files = new Set();
  for (const line of String(text ?? "").split("\n")) {
    const match = line.match(/^(?:---|\+\+\+)\s+[ab]\/(.*)$/);
    if (match?.[1]) files.add(match[1].trim());
  }
  return [...files].sort();
}

export async function loadDiffSource(source, options = {}) {
  const raw = String(source ?? "").trim();
  if (!raw) {
    throw new Error("Пустой источник diff");
  }
  if (/^https?:\/\//i.test(raw)) {
    const doFetch = options.fetch ?? globalThis.fetch;
    if (!doFetch) {
      throw new Error("fetch недоступен для загрузки diff по URL");
    }
    const token = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
    const headers = { Accept: "application/vnd.github.diff" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await doFetch(raw, { headers });
    if (!response.ok) {
      throw new Error(`Не удалось загрузить diff: HTTP ${response.status}`);
    }
    return await response.text();
  }
  const path = resolve(raw);
  if (existsSync(path)) {
    return readFileSync(path, "utf8");
  }
  throw new Error(`Файл diff не найден: ${raw}`);
}

async function collectWorkingTreeDiff(root) {
  const { gitDiff } = await import("./mcp-project.js");
  const result = await gitDiff(root, { root });
  const changedFiles = parseChangedFilesFromDiff(result.text);
  return {
    changedFiles,
    diffText: result.text,
    range: { mode: "working-tree" },
  };
}

export async function collectRangeDiff(root, options = {}) {
  const range = await resolveDiffRange(root, options);
  if (range.mode === "range") {
    const names = await runGit(root, ["diff", "--name-only", `${range.base}...${range.head}`]);
    const patch = await runGit(root, ["diff", "--unified=3", `${range.base}...${range.head}`]);
    const changedFiles = names
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const patchTrimmed = String(patch ?? "").trim();
    if (!changedFiles.length && !patchTrimmed) {
      return collectWorkingTreeDiff(root);
    }
    return { changedFiles, diffText: trimDiffText(patch || "Изменений нет."), range };
  }

  return collectWorkingTreeDiff(root);
}

export async function collectReviewDiff(root, options = {}) {
  if (options.diffText != null && String(options.diffText).trim()) {
    const diffText = trimDiffText(options.diffText);
    return {
      changedFiles: parseChangedFilesFromDiff(diffText),
      diffText,
      range: { mode: "external" },
    };
  }
  if (options.diffSource) {
    const raw = await loadDiffSource(options.diffSource, options);
    const diffText = trimDiffText(raw);
    return {
      changedFiles: parseChangedFilesFromDiff(diffText),
      diffText,
      range: { mode: "external", source: options.diffSource },
    };
  }
  return collectRangeDiff(root, options);
}

export function buildReviewQuery(changedFiles, diffText) {
  const added = extractAddedLines(diffText).join(" ");
  const paths = changedFiles.join(" ");
  return `${paths} ${added}`.trim().slice(0, 4000);
}

export function extractAddedLines(diffText) {
  const lines = [];
  for (const line of String(diffText ?? "").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      lines.push(line.slice(1).trim());
    }
  }
  return lines.filter(Boolean);
}

export function extractAddedLinesByFile(diffText) {
  const byFile = new Map();
  let current = "";
  for (const line of String(diffText ?? "").split("\n")) {
    if (line.startsWith("+++ b/")) {
      current = line.slice("+++ b/".length).trim();
      if (!byFile.has(current)) byFile.set(current, []);
      continue;
    }
    if (!current || !line.startsWith("+") || line.startsWith("+++")) continue;
    byFile.get(current).push(line.slice(1));
  }
  return byFile;
}

export async function retrieveDocHits(root, query) {
  try {
    const paths = await ensureProjectIndex(root);
    const { hits } = retrieveProjectContext(query, {
      indexPath: paths.dbPath,
      k: DOC_REVIEW_TOP_K,
    });
    return hits ?? [];
  } catch {
    return [];
  }
}

export function sourceCodePaths(changedFiles) {
  return changedFiles.filter((file) => CODE_EXT.has(extname(file).toLowerCase()));
}

export function retrieveCodeHits(root, changedFiles, diffText, query, k = CODE_REVIEW_TOP_K) {
  const paths = sourceCodePaths(changedFiles);
  const addedByFile = extractAddedLinesByFile(diffText);
  const vector = embed(query);
  const scored = [];

  for (const rel of paths) {
    const abs = join(root, rel);
    if (!existsSync(abs)) continue;
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const doc = {
      source: rel,
      title: rel,
      file: rel,
      kind: "code",
      text,
    };
    const chunks = chunkStructural(doc);
    const added = addedByFile.get(rel) ?? [];
    for (const chunk of chunks) {
      const overlaps = chunkOverlapsDiff(chunk.text, added);
      const score = cosine(vector, embed(chunk.text));
      scored.push({
        ...chunk,
        file: rel,
        score: overlaps ? Math.max(score, 0.85) : score,
        overlaps,
      });
    }
  }

  scored.sort((left, right) => right.score - left.score);
  const picked = [];
  const seen = new Set();
  for (const hit of scored) {
    const key = `${hit.file}\0${hit.section}\0${hit.text.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (hit.overlaps || hit.score > 0.05 || picked.length < k) {
      picked.push(hit);
    }
    if (picked.length >= k) break;
  }
  return picked;
}

function chunkOverlapsDiff(chunkText, addedLines) {
  if (!addedLines.length) return false;
  const normalized = String(chunkText ?? "");
  for (const line of addedLines) {
    const trimmed = String(line ?? "").trim();
    if (trimmed.length >= 8 && normalized.includes(trimmed)) return true;
  }
  return false;
}

export function mergeSources(docHits, codeHits) {
  const seen = new Set();
  const sources = [];
  for (const hit of [...(docHits ?? []), ...(codeHits ?? [])]) {
    const key = `${hit.file}\0${hit.section}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ file: hit.file, section: hit.section ?? hit.title ?? "" });
  }
  return sources;
}

export function reviewMessages({ diffText, changedFiles, docHits, codeHits }) {
  const docBlock = (docHits ?? [])
    .map((hit) => `## ${hit.file} | ${hit.section}\n${hit.text}`)
    .join("\n\n");
  const codeBlock = (codeHits ?? [])
    .map((hit) => `## ${hit.file} | ${hit.section}\n${hit.text}`)
    .join("\n\n");
  const fileList = changedFiles.map((f) => `- ${f}`).join("\n") || "- нет";

  return [
    {
      role: "system",
      content: [
        "Ты ревьюер кода. Отвечай по-русски.",
        "Используй только diff, список файлов и приведённые фрагменты документации и кода.",
        "Не упоминай файлы и символы, которых нет в этих материалах.",
        "Ответ должен содержать ровно три раздела с заголовками markdown второго уровня:",
        SECTION_BUGS,
        SECTION_ARCH,
        SECTION_REC,
        "Без блоков «Источники» и «Изменённые файлы» — их добавит хост.",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "Проведи ревью изменений Pull Request.",
        "",
        "Изменённые файлы:",
        fileList,
        "",
        "Diff:",
        diffText || "нет",
        "",
        "Документация (RAG):",
        docBlock || "нет",
        "",
        "Код (фрагменты изменённых файлов):",
        codeBlock || "нет",
      ].join("\n"),
    },
  ];
}

export function detectBugMarkers(diffText) {
  const findings = [];
  for (const line of String(diffText ?? "").split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const re of BUG_MARKERS) {
      if (re.test(line)) {
        findings.push(line.trim());
        break;
      }
    }
  }
  return findings;
}

export function fallbackReviewBody({ diffText, changedFiles, docHits, codeHits }) {
  const bugs = detectBugMarkers(diffText);
  const bugSection = bugs.length
    ? bugs.map((line) => `- ${line}`).join("\n")
    : "не обнаружено";

  const archLines = [];
  const docFiles = new Set((docHits ?? []).map((h) => h.file));
  for (const file of changedFiles) {
    const mentioned = [...docFiles].some((doc) => diffText.includes(doc) || file.includes("src"));
    if (!mentioned && CODE_EXT.has(extname(file).toLowerCase())) {
      archLines.push(`- ${file}: в документации нет явного описания этого модуля.`);
    }
  }
  const topDoc = docHits?.[0];
  if (topDoc?.text) {
    const clip = topDoc.text.replace(/\s+/g, " ").trim().slice(0, 200);
    archLines.push(`- Сверка с документацией (${topDoc.file} | ${topDoc.section}): ${clip}`);
  }
  if (!archLines.length) archLines.push("- Явных архитектурных расхождений по индексу не найдено.");

  const recLines = [];
  if (bugs.some((b) => /TODO|FIXME/i.test(b))) {
    recLines.push("- Закрыть или оформить TODO/FIXME до merge.");
  }
  const codeHit = codeHits?.[0];
  if (codeHit) {
    recLines.push(`- Проверить затронутый код (${codeHit.file}, ${codeHit.section}).`);
  }
  if (!recLines.length) recLines.push("- Прогнать тесты и убедиться, что diff покрыт проверками.");

  return [SECTION_BUGS, bugSection, "", SECTION_ARCH, archLines.join("\n"), "", SECTION_REC, recLines.join("\n")].join(
    "\n",
  );
}

export function formatReviewReply(body, sources, changedFiles) {
  const lines = [String(body ?? "").trim(), "", "Источники:"];
  if (!sources.length) lines.push("- нет");
  else {
    for (const source of sources) {
      lines.push(`- ${source.file} | ${source.section}`);
    }
  }
  lines.push("", "Изменённые файлы:");
  if (!changedFiles.length) lines.push("- нет");
  else {
    for (const file of changedFiles) lines.push(`- ${file}`);
  }
  return lines.join("\n");
}

export async function runProjectReview(root, options = {}) {
  const projectRoot = resolve(root);
  const { changedFiles, diffText, range } = await collectReviewDiff(projectRoot, {
    base: options.base,
    head: options.head,
    diffText: options.diffText,
    diffSource: options.diffSource,
    fetch: options.fetch,
  });
  const query = buildReviewQuery(changedFiles, diffText);
  const docHits = await retrieveDocHits(projectRoot, query);
  const codeHits = retrieveCodeHits(projectRoot, changedFiles, diffText, query);
  const sources = mergeSources(docHits, codeHits);

  let body = "";
  let usedModel = false;

  if (typeof options.generate === "function") {
    body = String(await options.generate({ diffText, changedFiles, docHits, codeHits, query, range }) ?? "");
    usedModel = Boolean(body.trim());
  } else if (options.allowModel !== false) {
    try {
      const result = await completeChat({
        messages: reviewMessages({ diffText, changedFiles, docHits, codeHits }),
        enableThinking: false,
        maxTokens: 1024,
        temperature: 0,
      });
      body = result.content;
      usedModel = Boolean(body.trim());
    } catch {
      body = "";
    }
  }

  if (!body.trim()) {
    body = fallbackReviewBody({ diffText, changedFiles, docHits, codeHits });
    usedModel = false;
  }

  return {
    reply: formatReviewReply(body, sources, changedFiles),
    body,
    sources,
    changedFiles,
    diffText,
    range,
    docHits,
    codeHits,
    usedModel,
  };
}
