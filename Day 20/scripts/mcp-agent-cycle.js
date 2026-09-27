import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/env.js";
import { AgentPool } from "../src/pool.js";
import { formatToolTrace, toolMatches } from "../src/mcp-trace.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(resolve(projectRoot, ".env"));

const API_KEY = process.env.CURSOR_API_KEY?.trim();
const MODEL = process.env.CURSOR_MODEL ?? "composer-2.5";
const RUNTIME = (process.env.CURSOR_RUNTIME ?? "local").toLowerCase();

if (!API_KEY || API_KEY === "cursor_your-key-here") {
  console.error("Задайте CURSOR_API_KEY в .env");
  process.exit(1);
}
if (RUNTIME !== "local") {
  console.error("MCP stdio доступен только при CURSOR_RUNTIME=local");
  process.exit(1);
}

const AGENT = "mcp-git";
const QUERY = [
  "Вызови MCP-инструмент git_status сервера demo-mcp.",
  "Параметр repo не передавай: сервер сам возьмёт каталог проекта.",
  "Другие инструменты не используй.",
  "Когда получишь результат, первой строкой ответа напиши дословно первую строку вывода git_status.",
  "Второй строкой одной фразой скажи, есть ли незакоммиченные изменения.",
].join(" ");

function persist(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function completedCall(tools, name) {
  return (tools?.calls ?? []).find(
    (call) => toolMatches(call, name) && call.status === "completed" && call.resultText,
  );
}

const pool = new AgentPool({
  apiKey: API_KEY,
  defaultModel: MODEL,
  defaultRuntime: RUNTIME,
  cwd: projectRoot,
  storePath: resolve(projectRoot, "data", "mcp-agent-agents.json"),
});

if (pool.get(AGENT)) await pool.kill(AGENT);

const [agent] = pool.spawn({
  name: AGENT,
  model: MODEL,
  runtime: "local",
  systemPrompt:
    "Отвечай по-русски. Для вопросов о статусе репозитория вызывай только MCP-инструмент git_status и опирайся на его текст.",
});

let exitCode = 0;
try {
  console.log(`> ask ${AGENT} ${QUERY}`);
  console.log(`→ ${agent.name}:`);
  const { reply, tools } = await agent.ask(QUERY);
  for (const call of tools?.calls ?? []) {
    if (call.status === "running") continue;
    console.log(formatToolTrace(call));
  }
  const text = String(reply ?? "").trim();
  console.log(text || "(пусто)");

  const call = completedCall(tools, "git_status");
  const firstLine = call?.resultText?.split("\n").find((line) => line.trim()) ?? "";
  const used = Boolean(firstLine) && text.includes(firstLine);
  persist(resolve(projectRoot, "data", "mcp-agent-cycle.json"), {
    model: MODEL,
    runtime: RUNTIME,
    at: new Date().toISOString(),
    query: QUERY,
    runId: tools?.runId ?? null,
    calls: tools?.calls ?? [],
    reply: text,
    used,
  });

  if (!call) {
    console.error("Агент не получил результат MCP git_status");
    exitCode = 1;
  } else if (!used) {
    console.error("Ответ агента не содержит текст результата git_status");
    exitCode = 1;
  } else {
    console.log(`Агент использовал результат MCP: ${firstLine}`);
  }
} finally {
  await agent.dispose();
}

process.exit(exitCode);
