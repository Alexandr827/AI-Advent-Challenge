import { existsSync, readFileSync } from "node:fs";
import { connectProjectMcp } from "./mcp-client.js";
import { completeChat } from "./llm.js";
import {
  indexProjectDocs,
  isStructureQuestion,
  projectIndexPaths,
  retrieveProjectContext,
} from "./rag/project.js";

export const PROJECT_MCP_NAME = "project-mcp";
export const PROJECT_MCP_TOOLS = ["git_branch", "list_files", "git_diff"];

const DIFF_RE = /diff|изменен|различ|ветк/i;

export function wantsDiff(query) {
  return DIFF_RE.test(String(query ?? ""));
}

export async function ensureProjectIndex(root) {
  const paths = projectIndexPaths(root);
  if (!existsSync(paths.dbPath) || !existsSync(paths.manifestPath)) {
    await indexProjectDocs(root);
  }
  return paths;
}

export function readProjectManifest(manifestPath) {
  if (!existsSync(manifestPath)) return { files: [] };
  const data = JSON.parse(readFileSync(manifestPath, "utf8"));
  return { files: Array.isArray(data.files) ? data.files : [] };
}

export function mcpToolText(result) {
  return (result?.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

export async function callProjectMcp(root, toolNames, { callTool } = {}) {
  if (callTool) {
    const out = {};
    for (const name of toolNames) {
      out[name] = mcpToolText(await callTool({ name, arguments: {} }));
    }
    return out;
  }

  const client = await connectProjectMcp(root);
  try {
    const out = {};
    for (const name of toolNames) {
      out[name] = mcpToolText(await client.callTool({ name, arguments: {} }));
    }
    return out;
  } finally {
    await client.close();
  }
}

export async function answerProjectHelp(query, options = {}) {
  const root = options.root;
  if (!root) throw new Error("answerProjectHelp: нужен root");
  const paths = await ensureProjectIndex(root);
  const manifest = readProjectManifest(paths.manifestPath);
  const question = String(query ?? "").trim();
  const toolNames = ["git_branch", "list_files"];
  if (question && wantsDiff(question)) toolNames.push("git_diff");
  const mcp = await callProjectMcp(root, toolNames, { callTool: options.callTool });
  const found = question
    ? typeof options.retrieve === "function"
      ? options.retrieve(question)
      : retrieveProjectContext(question, { indexPath: paths.dbPath })
    : { hits: [] };
  const hits = Array.isArray(found) ? found : (found?.hits ?? []);

  if (!question) {
    return {
      reply: formatConnection(root, manifest, mcp),
      hits,
      sources: [],
      usedModel: false,
    };
  }

  let modelText = "";
  let usedModel = false;
  if (typeof options.generate === "function") {
    try {
      modelText = String(await options.generate({ query: question, hits, mcp }) ?? "");
      usedModel = Boolean(modelText.trim());
    } catch {
      modelText = "";
    }
  } else if (options.allowModel !== false) {
    try {
      const result = await completeChat({
        messages: projectMessages(question, hits, mcp),
        enableThinking: false,
        maxTokens: 512,
        temperature: 0,
      });
      modelText = result.content;
      usedModel = Boolean(modelText.trim());
    } catch {
      modelText = "";
    }
  }
  if (!modelText.trim()) {
    modelText = extractiveAnswer(question, hits, mcp);
    usedModel = false;
  }
  return {
    reply: composeProjectReply(modelText, hits, mcp),
    hits,
    sources: sourcesOf(hits),
    usedModel,
  };
}

export function composeProjectReply(answer, hits, mcp) {
  const lines = [
    "Ответ:",
    String(answer ?? "").trim() || "В документации проекта нет фрагмента по этому вопросу.",
    "",
    "Источники:",
  ];
  const sources = sourcesOf(hits);
  if (!sources.length) lines.push("- нет");
  else {
    for (const source of sources) lines.push(`- ${source.file} | ${source.section}`);
  }
  lines.push("", "Контекст MCP:");
  if (mcp?.git_branch) lines.push(`Ветка: ${String(mcp.git_branch).trim()}`);
  if (mcp?.list_files) {
    lines.push("Файлы:");
    lines.push(String(mcp.list_files).trim());
  }
  if (mcp?.git_diff) {
    lines.push("Diff:");
    lines.push(String(mcp.git_diff).trim());
  }
  return lines.join("\n");
}

function formatConnection(root, manifest, mcp) {
  const lines = [
    `Ассистент разработчика подключён к ${root}.`,
    "",
    "RAG:",
  ];
  const files = manifest?.files ?? [];
  if (!files.length) lines.push("- индекс пуст");
  else {
    for (const file of files) lines.push(`- ${file.path} (${file.role})`);
  }
  lines.push(
    "",
    `MCP: ${PROJECT_MCP_NAME}`,
    `Инструменты: ${PROJECT_MCP_TOOLS.join(", ")}`,
    "",
    "Контекст MCP:",
  );
  if (mcp?.git_branch) lines.push(`Ветка: ${String(mcp.git_branch).trim()}`);
  if (mcp?.list_files) {
    lines.push("Файлы:");
    lines.push(String(mcp.list_files).trim());
  }
  return lines.join("\n");
}

function extractiveAnswer(query, hits, mcp) {
  const parts = [];
  const ranked = [...hits].sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
  const overview = ranked.find((hit) => /^readme/i.test(String(hit.file ?? "")));
  const best = isStructureQuestion(query) && overview ? overview : ranked[0];
  if (best?.text) {
    const clip = best.text.replace(/\s+/g, " ").trim().slice(0, 500);
    parts.push(`По документации (${best.file}, ${best.section}): ${clip}`);
  }
  if (isStructureQuestion(query) && mcp?.list_files) {
    const dirs = topLevelEntries(mcp.list_files);
    if (dirs.length) parts.push(`Каталоги и файлы верхнего уровня: ${dirs.join(", ")}.`);
  }
  if (!parts.length) parts.push("В индексе документации нет подходящего фрагмента.");
  return parts.join("\n");
}

function projectMessages(query, hits, mcp) {
  const sources = hits
    .map((hit) => `## ${hit.file} | ${hit.section}\n${hit.text}`)
    .join("\n\n");
  const context = [
    mcp?.git_branch ? `Ветка: ${mcp.git_branch}` : "",
    mcp?.list_files ? `Файлы:\n${mcp.list_files}` : "",
    mcp?.git_diff ? `Diff:\n${mcp.git_diff}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    {
      role: "system",
      content: [
        "Ты ассистент разработчика. Отвечай по-русски только по фрагментам документации и контексту MCP.",
        "Не выдумывай файлы и команды, которых нет во фрагментах.",
        "Короткий ответ, без заголовков «Источники» и «Контекст MCP» — их добавит хост.",
      ].join("\n"),
    },
    {
      role: "user",
      content: `Вопрос: ${query}\n\nДокументация:\n${sources || "нет"}\n\nКонтекст проекта:\n${context || "нет"}`,
    },
  ];
}

function sourcesOf(hits) {
  const seen = new Set();
  const sources = [];
  for (const hit of hits ?? []) {
    const key = `${hit.file}\0${hit.section}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ file: hit.file, section: hit.section, chunk_id: hit.chunk_id });
  }
  return sources;
}

function topLevelEntries(listing) {
  const names = new Set();
  for (const line of String(listing ?? "").split("\n")) {
    const path = line.trim();
    if (!path || path.startsWith("…")) continue;
    const slash = path.indexOf("/");
    names.add(slash === -1 ? path : path.slice(0, slash));
  }
  return [...names].sort();
}
