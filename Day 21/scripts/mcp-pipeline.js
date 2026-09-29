import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { connectMcp } from "../src/mcp-client.js";
import { runFeaturePipeline, toolText } from "../src/mcp-pipeline.js";

export function parsePipelineArgs(argv) {
  const out = {
    step: "",
    query: "",
    searchFile: "",
    search: "",
    feature: "",
    contentFile: "",
    content: "",
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value == null || value.startsWith("--")) {
        throw new Error(`Нужно значение для ${token}`);
      }
      return value;
    };
    if (token === "--query") out.query = next();
    else if (token === "--step") out.step = next();
    else if (token === "--search-file") out.searchFile = next();
    else if (token === "--search") out.search = next();
    else if (token === "--feature") out.feature = next();
    else if (token === "--content-file") out.contentFile = next();
    else if (token === "--content") out.content = next();
    else throw new Error(`Неизвестный аргумент: ${token}`);
  }
  return out;
}

function readInput(file, inline, label) {
  if (file) return readFileSync(resolve(file), "utf8");
  if (inline) return inline;
  throw new Error(`Нужен ${label}`);
}

export async function runPipelineCli(argv, deps) {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const readFile = deps.readFile ?? ((file) => readFileSync(file, "utf8"));
  let args;
  try {
    args = parsePipelineArgs(argv);
  } catch (err) {
    error(err.message);
    return { ok: false, code: 1 };
  }

  const call = deps.callTool;

  if (args.step === "search") {
    if (!args.query) {
      error("Нужен --query");
      return { ok: false, code: 1 };
    }
    const result = await call({
      name: "search_feature",
      arguments: { query: args.query },
    });
    const text = toolText(result);
    log(text);
    return { ok: !result.isError, code: result.isError ? 1 : 0 };
  }

  if (args.step === "summarize") {
    let search;
    try {
      search = readInput(args.searchFile, args.search, "--search или --search-file");
    } catch (err) {
      error(err.message);
      return { ok: false, code: 1 };
    }
    const result = await call({
      name: "summarize_feature",
      arguments: { search },
    });
    const text = toolText(result);
    log(text);
    return { ok: !result.isError, code: result.isError ? 1 : 0 };
  }

  if (args.step === "save") {
    if (!args.feature) {
      error("Нужен --feature");
      return { ok: false, code: 1 };
    }
    let content;
    try {
      content = readInput(args.contentFile, args.content, "--content или --content-file");
    } catch (err) {
      error(err.message);
      return { ok: false, code: 1 };
    }
    const result = await call({
      name: "saveToFile",
      arguments: { feature: args.feature, content },
    });
    const text = toolText(result);
    log(text);
    return { ok: !result.isError, code: result.isError ? 1 : 0 };
  }

  if (args.step) {
    error("Неизвестный --step. Допустимо: search, summarize, save");
    return { ok: false, code: 1 };
  }

  if (!args.query) {
    error("Нужен --query");
    return { ok: false, code: 1 };
  }

  const run = await runFeaturePipeline(call, { query: args.query });
  for (const step of run.steps) {
    log(step.name);
    log(step.text);
    log("");
  }
  if (!run.ok) return { ok: false, code: 1 };

  const savedLine = run.steps[2]?.text ?? "";
  const filePath = savedLine.replace(/^Сохранено:\s*/u, "").trim();
  let disk;
  try {
    disk = readFile(filePath);
  } catch (err) {
    error(`Не удалось прочитать ${filePath}: ${err.message}`);
    return { ok: false, code: 1 };
  }
  if (disk !== run.steps[1].text) {
    error("Файл не совпадает с текстом summarize_feature");
    return { ok: false, code: 1 };
  }
  return { ok: true, code: 0 };
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const client = await connectMcp();
  try {
    const result = await runPipelineCli(process.argv.slice(2), {
      callTool: (req) => client.callTool(req),
    });
    if (!result.ok) process.exitCode = result.code || 1;
  } finally {
    await client.close();
  }
}
