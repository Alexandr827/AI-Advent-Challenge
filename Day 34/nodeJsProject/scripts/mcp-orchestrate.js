import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { connectNamedMcp } from "../src/mcp-client.js";
import { planOrchestration, runOrchestration } from "../src/mcp-orchestrator.js";
import { formatToolTrace } from "../src/mcp-trace.js";

const DEFAULT_ASK =
  "Запиши мне результаты по прогнозу погоды в Москве 25 сентября 2026 года в 18 часов 26 минут по часовому поясу самой Москвы. Резульаты прогноза сохрани в отдельный файл внутри проекта";

export async function runOrchestrateCli(text, deps = {}) {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const cwd = deps.cwd ?? process.cwd();
  const plan = planOrchestration(text);
  if (!plan) {
    error("В запросе нет погоды или времени.");
    return { ok: false, code: 1, steps: [] };
  }
  if (plan.error) {
    error(plan.error);
    return { ok: false, code: 1, steps: [] };
  }
  const clients = new Map();
  try {
    const run = await runOrchestration(plan, async (req) => {
      let client = clients.get(req.server);
      if (!client) {
        client = await connectNamedMcp(req.server, cwd);
        clients.set(req.server, client);
      }
      return client.callTool({ name: req.name, arguments: req.arguments });
    });
    for (const step of run.steps) {
      log(
        formatToolTrace({
          server: step.server,
          tool: step.name,
          status: step.isError ? "error" : "completed",
          resultText: step.text,
          isError: step.isError,
        }),
      );
    }
    return { ok: run.ok, code: run.ok ? 0 : 1, steps: run.steps };
  } finally {
    for (const client of clients.values()) {
      await client.close();
    }
  }
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const text = process.argv.slice(2).join(" ").trim() || DEFAULT_ASK;
  const result = await runOrchestrateCli(text);
  if (!result.ok) process.exitCode = result.code || 1;
}
