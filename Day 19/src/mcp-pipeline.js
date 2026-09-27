import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const SEARCH_DIRS = ["src", "scripts", "test"];
const HIT_LIMIT = 12;
const EXCERPT_LIMIT = 200;
const README_PARAGRAPHS = 2;
const README_PARAGRAPH_LIMIT = 320;

export const PIPELINE_ASK_EXAMPLES = [
  "ask <agent> Вот тебе текст А, прогони через mcp-tool summarize",
  "ask <agent> прогони git_status через mcp-tool search, summarize и save",
];

const TOOL_ALIASES = {
  search: "search_feature",
  search_feature: "search_feature",
  summarize: "summarize_feature",
  summarise: "summarize_feature",
  summarize_feature: "summarize_feature",
  summirize: "summarize_feature",
  save: "saveToFile",
  savetofile: "saveToFile",
  save_to_file: "saveToFile",
};

const TOOL_JOINERS = new Set(["и", "and", "потом", "затем", "then", "+"]);

export function featureSlug(value) {
  return String(value ?? "")
    .trim()
    .replace(/\.\./g, "")
    .replace(/[\\/]/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}_-]/gu, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function needles(query) {
  const raw = String(query ?? "").trim().toLowerCase();
  if (!raw) return [];
  const underscored = raw.replace(/\s+/g, "_");
  return [...new Set([raw, underscored].filter(Boolean))];
}

function matches(text, query) {
  const hay = String(text ?? "").toLowerCase();
  return needles(query).some((needle) => hay.includes(needle));
}

function excerptOf(line) {
  const flat = String(line ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= EXCERPT_LIMIT) return flat;
  return `${flat.slice(0, EXCERPT_LIMIT - 1)}…`;
}

function walkJs(dir, files) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkJs(full, files);
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(full);
  }
}

export function searchFeature(query, { root }) {
  const q = String(query ?? "").trim();
  const feature = featureSlug(q);
  const hits = [];
  if (q) {
    const files = [];
    for (const dir of SEARCH_DIRS) walkJs(join(root, dir), files);
    files.sort();
    for (const file of files) {
      if (hits.length >= HIT_LIMIT) break;
      const rel = relative(root, file).split(sep).join("/");
      const lines = readFileSync(file, "utf8").split(/\r?\n/u);
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= HIT_LIMIT) break;
        if (!matches(lines[i], q)) continue;
        hits.push({
          file: rel,
          line: i + 1,
          excerpt: excerptOf(lines[i]),
        });
      }
    }
  }
  return {
    ok: true,
    text: `${JSON.stringify({ feature, query: q, hits }, null, 2)}\n`,
  };
}

function withoutFences(text) {
  const lines = [];
  let fence = false;
  for (const line of String(text).split(/\r?\n/u)) {
    if (/^(?:`{3,}|~{3,})/u.test(line.trim())) {
      fence = !fence;
      continue;
    }
    if (!fence) lines.push(line);
  }
  return lines.join("\n");
}

function readmeParagraphs(root, query) {
  let text = "";
  try {
    text = readFileSync(join(root, "README.md"), "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const found = [];
  for (const block of withoutFences(text).split(/\n\s*\n/u)) {
    const paragraph = block.replace(/\s+/g, " ").trim();
    if (!paragraph || !matches(paragraph, query)) continue;
    found.push(
      paragraph.length <= README_PARAGRAPH_LIMIT
        ? paragraph
        : `${paragraph.slice(0, README_PARAGRAPH_LIMIT - 1)}…`,
    );
    if (found.length >= README_PARAGRAPHS) break;
  }
  return found;
}

function summarizePlain(text, root) {
  const raw = String(text ?? "").trim();
  if (!raw) return { ok: false, text: "summarize_feature: пустой текст" };
  const preview = raw.length <= 400 ? raw : `${raw.slice(0, 399)}…`;
  const paragraphs = readmeParagraphs(root, raw.slice(0, 80));
  const lines = ["# сводка", "", preview];
  if (paragraphs.length) {
    lines.push("", "## README");
    for (const paragraph of paragraphs) lines.push(`> ${paragraph}`);
  }
  return { ok: true, text: `${lines.join("\n")}\n` };
}

export function summarizeFeature(searchText, { root }) {
  const raw = String(searchText ?? "").trim();
  if (!raw) return { ok: false, text: "summarize_feature: пустой текст" };
  if (!raw.startsWith("{") && !raw.startsWith("[")) {
    return summarizePlain(raw, root);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, text: "summarize_feature: невалидный JSON в search" };
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.hits)) {
    return { ok: false, text: "summarize_feature: в search нет массива hits" };
  }
  const query = String(data.query ?? "");
  const feature = String(data.feature ?? "") || featureSlug(query);
  const paragraphs = readmeParagraphs(root, query);
  const lines = [
    `# ${feature || "feature"}`,
    "",
    `Найдено: ${data.hits.length}`,
    "",
    "## Код",
  ];
  if (!data.hits.length) {
    lines.push("Совпадений в коде нет.");
  } else {
    for (const hit of data.hits) {
      lines.push(`- ${hit.file}:${hit.line} — ${hit.excerpt}`);
    }
  }
  lines.push("", "## README");
  if (!paragraphs.length) {
    lines.push("В README.md нет абзаца с этим запросом.");
  } else {
    for (const paragraph of paragraphs) {
      lines.push(`> ${paragraph}`);
    }
  }
  return { ok: true, text: `${lines.join("\n")}\n` };
}

function insideRoot(root, filePath) {
  const base = resolve(root);
  const target = resolve(filePath);
  const rel = relative(base, target);
  return rel !== "" && !rel.startsWith("..") && !rel.includes(sep);
}

export function withSummaryDescription(feature, content) {
  const name = String(feature ?? "").trim() || "фича";
  const results = String(content ?? "").trimEnd();
  return [
    "## Описание",
    "",
    `Краткая сводка фичи «${name}». Её собрал mcp-tool summarize_feature: фрагменты кода проекта и абзацы README.md, где встречается этот запрос.`,
    "",
    "## Результаты",
    "",
    results,
    "",
  ].join("\n");
}

export function saveFeatureFile({ feature, content, summarized }, { root }) {
  const raw = String(feature ?? "").trim();
  if (!raw) {
    return { ok: false, text: "saveToFile: пустое имя фичи" };
  }
  if (raw.includes("..") || raw.includes("/") || raw.includes("\\")) {
    return { ok: false, text: "saveToFile: имя не должно содержать путь" };
  }
  if (content == null || String(content) === "") {
    return { ok: false, text: "saveToFile: пустой content" };
  }
  const slug = featureSlug(raw);
  if (!slug) {
    return { ok: false, text: "saveToFile: пустое имя файла" };
  }
  const fileName = `${slug}.md`;
  const filePath = resolve(root, fileName);
  if (!insideRoot(root, filePath)) {
    return { ok: false, text: "saveToFile: путь вне каталога проекта" };
  }
  const body = summarized ? withSummaryDescription(raw, content) : String(content);
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, filePath);
  return { ok: true, text: `Сохранено: ${filePath}`, path: filePath };
}

export function toolText(result) {
  return (result?.content ?? [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function cleanPayload(chunk) {
  return String(chunk ?? "")
    .replace(/^\s*прогони(?:\s+через)?\s+/iu, "")
    .replace(/(?:,\s*)?прогони(?:\s+через)?\s*$/iu, "")
    .replace(/\s+через\s*$/iu, "")
    .replace(/^(?:,\s*)+/u, "")
    .replace(/[,\s]+$/u, "")
    .trim();
}

function takeFeature(chunk) {
  const match = String(chunk ?? "").match(/(?:^|\s)--?feature\s+(\S+)/iu);
  if (!match) return { feature: "", text: String(chunk ?? "").trim() };
  return {
    feature: match[1].replace(/[.,]$/u, ""),
    text: String(chunk).replace(match[0], " ").replace(/\s+/g, " ").trim(),
  };
}

export function parseAskMcpRequest(text) {
  const source = String(text ?? "");
  const marker = source.match(/mcp[-\s]?tool\b/iu);
  if (!marker) return null;
  const after = source.slice(marker.index + marker[0].length).trim();
  const tokens = after.split(/\s+/u).filter(Boolean);
  const tools = [];
  let index = 0;
  while (index < tokens.length) {
    const bare = tokens[index].replace(/^[,(]+|[),.:]+$/gu, "").toLowerCase();
    if (!bare || TOOL_JOINERS.has(bare)) {
      index += 1;
      continue;
    }
    const name = TOOL_ALIASES[bare];
    if (!name) break;
    tools.push(name);
    index += 1;
  }
  if (!tools.length) return null;
  const head = takeFeature(cleanPayload(source.slice(0, marker.index)));
  const tail = takeFeature(tokens.slice(index).join(" "));
  const feature = head.feature || tail.feature;
  const payload = [head.text, tail.text].filter(Boolean).join("\n").trim();
  return { tools, payload, feature };
}

function extractFeatureQuery(text) {
  const quoted = String(text ?? "").match(/[«"]([^»"]+)[»"]/u);
  if (quoted?.[1]?.trim()) return quoted[1].trim();
  const feature = String(text ?? "").match(/фич[а-яё]*\s+([A-Za-zА-Яа-яЁё0-9_-]+)/iu);
  return feature?.[1]?.trim() ?? "";
}

export function planMcpFromAsk(text, { mcp = false } = {}) {
  if (mcp === false) return null;
  const explicit = parseAskMcpRequest(text);
  if (explicit) return explicit;
  const lower = String(text ?? "").toLowerCase();
  const tools = [];
  if (/найт|поиск|фич/u.test(lower)) tools.push("search_feature");
  if (/резюм|суммар|кратк/u.test(lower)) tools.push("summarize_feature");
  if (/сохран|файл/u.test(lower)) tools.push("saveToFile");
  if (!tools.length) {
    return {
      tools: [],
      payload: "",
      feature: "",
      error:
        "MCP включён, но в запросе нет поиска, резюме или сохранения. Добавьте это в текст или напишите mcp-tool search, summarize и save.",
    };
  }
  const query = extractFeatureQuery(text);
  if ((tools.includes("search_feature") || tools.includes("saveToFile")) && !query) {
    return {
      tools,
      payload: "",
      feature: "",
      error: "Не понял имя фичи. Напишите «фича стратегия» или mcp-tool search стратегия.",
    };
  }
  return { tools, payload: query, feature: featureSlug(query) };
}

export async function runAskMcpRequest(request, callTool) {
  const steps = [];
  let text = String(request.payload ?? "");
  let feature = String(request.feature ?? "");
  for (const name of request.tools) {
    let args;
    if (name === "search_feature") {
      if (!text.trim()) {
        return {
          ok: false,
          steps: [
            ...steps,
            {
              name,
              arguments: { query: text },
              text: "search_feature: пустой query",
              isError: true,
            },
          ],
        };
      }
      args = { query: text };
    } else if (name === "summarize_feature") {
      args = { search: text };
    } else {
      let saveFeature = feature;
      if (!saveFeature) {
        try {
          const parsed = JSON.parse(text);
          if (parsed?.feature) saveFeature = String(parsed.feature);
        } catch {
          const heading = text.match(/^#\s+(\S+)/u);
          saveFeature = heading ? heading[1] : featureSlug(text.split("\n")[0] || "");
        }
      }
      const summarized = steps.some((step) => step.name === "summarize_feature" && !step.isError);
      args = { feature: saveFeature || "feature", content: text, summarized };
    }
    const result = await callTool({ name, arguments: args });
    const body = toolText(result);
    steps.push({
      name,
      arguments: args,
      text: body,
      isError: Boolean(result.isError),
    });
    if (result.isError) return { ok: false, steps };
    text = body;
    if (name === "search_feature") {
      try {
        const parsed = JSON.parse(body);
        if (parsed?.feature) feature = String(parsed.feature);
      } catch {
        feature = feature || featureSlug(args.query);
      }
    }
  }
  return { ok: true, steps };
}

export function formatMcpAskReply(steps, { server = "demo-mcp" } = {}) {
  const lines = (steps ?? []).map((step) => {
    const mark = step.isError ? "завершился с ошибкой" : "отработал";
    return `mcp-tool ${step.name} ${mark} (сервер ${server}, mcp-client → mcp-server).`;
  });
  const body = String(steps?.at(-1)?.text ?? "").trimEnd();
  return body ? `${lines.join("\n")}\n\n${body}\n` : `${lines.join("\n")}\n`;
}

export async function runFeaturePipeline(callTool, { query }) {
  const steps = [];
  const searchResult = await callTool({
    name: "search_feature",
    arguments: { query },
  });
  const searchBody = toolText(searchResult);
  steps.push({
    name: "search_feature",
    arguments: { query },
    text: searchBody,
    isError: Boolean(searchResult.isError),
  });
  if (searchResult.isError) return { ok: false, steps };

  const summaryResult = await callTool({
    name: "summarize_feature",
    arguments: { search: searchBody },
  });
  const summaryBody = toolText(summaryResult);
  steps.push({
    name: "summarize_feature",
    arguments: { search: searchBody },
    text: summaryBody,
    isError: Boolean(summaryResult.isError),
  });
  if (summaryResult.isError) return { ok: false, steps };

  let feature = featureSlug(query);
  try {
    const parsed = JSON.parse(searchBody);
    if (parsed?.feature) feature = String(parsed.feature);
  } catch {
    feature = featureSlug(query);
  }
  const saveResult = await callTool({
    name: "saveToFile",
    arguments: { feature, content: summaryBody, summarized: true },
  });
  steps.push({
    name: "saveToFile",
    arguments: { feature, content: summaryBody, summarized: true },
    text: toolText(saveResult),
    isError: Boolean(saveResult.isError),
  });
  return { ok: !saveResult.isError, steps };
}
