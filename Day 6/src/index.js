import readline from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CursorAgentError } from "@cursor/sdk";
import { loadEnv } from "./env.js";
import { AgentPool, MAX_AGENTS } from "./pool.js";
import { helpText, parseCommand } from "./cli.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(resolve(projectRoot, ".env"));

const API_KEY = process.env.CURSOR_API_KEY?.trim();
const MODEL = process.env.CURSOR_MODEL ?? "composer-2.5";
const RUNTIME = (process.env.CURSOR_RUNTIME ?? "local").toLowerCase();

if (!API_KEY) {
  console.error("Задайте CURSOR_API_KEY в .env");
  process.exit(1);
}

if (RUNTIME !== "local" && RUNTIME !== "cloud") {
  console.error("CURSOR_RUNTIME должен быть local или cloud");
  process.exit(1);
}

const pool = new AgentPool({
  apiKey: API_KEY,
  defaultModel: MODEL,
  defaultRuntime: RUNTIME,
  cwd: projectRoot,
});

function formatAgent(agent) {
  const item = agent.snapshot ?? agent;
  const system = item.systemPrompt
    ? ` system=${JSON.stringify(item.systemPrompt)}`
    : "";
  return `  #${item.id}  ${item.name}  model=${item.model}  runtime=${item.runtime}  ${item.status}${system}`;
}

function printCursorError(err) {
  console.error(`Ошибка Cursor: ${err.message}`);
  if (/cloud/i.test(err.message) && RUNTIME === "local") {
    console.error("Подсказка: для cloud задайте CURSOR_RUNTIME=cloud или spawn --runtime cloud");
  }
}

async function handle(cmd) {
  switch (cmd.type) {
    case "empty":
      return true;
    case "help":
      console.log(helpText());
      return true;
    case "exit":
      return false;
    case "list": {
      const items = pool.list();
      if (!items.length) {
        console.log(`Пул пуст (0/${MAX_AGENTS})`);
        return true;
      }
      console.log(`Агенты (${items.length}/${MAX_AGENTS}):`);
      for (const item of items) {
        console.log(formatAgent(item));
      }
      return true;
    }
    case "spawn": {
      const created = pool.spawn({
        name: cmd.name,
        model: cmd.model,
        systemPrompt: cmd.systemPrompt,
        runtime: cmd.runtime,
        count: cmd.count,
      });
      console.log(`Создано: ${created.length}`);
      for (const agent of created) {
        console.log(formatAgent(agent));
      }
      return true;
    }
    case "ask": {
      const agent = pool.get(cmd.target);
      if (!agent) {
        throw new Error(`Агент не найден: ${cmd.target}`);
      }
      console.log(`→ ${agent.name}:`);
      const text = await agent.ask(cmd.text);
      console.log(text.trim() || "(пусто)");
      return true;
    }
    case "kill": {
      if (cmd.all) {
        const n = await pool.killAll();
        console.log(`Остановлено: ${n}`);
        return true;
      }
      const agent = await pool.kill(cmd.target);
      console.log(`Остановлен: ${agent.name} (#${agent.id})`);
      return true;
    }
    default:
      throw new Error("Неизвестная команда. Введите help.");
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "> ",
});

let disposed = false;
let shouldPrompt = true;

async function shutdown() {
  if (disposed) return;
  disposed = true;
  shouldPrompt = false;
  await pool.killAll();
}

console.log(
  `CLI-хост агентов. Модель по умолчанию: ${MODEL}, runtime: ${RUNTIME}. Лимит: ${MAX_AGENTS}.`,
);
console.log("Введите help для списка команд.");
rl.prompt();

let chain = Promise.resolve();

rl.on("line", (line) => {
  chain = chain.then(async () => {
    if (disposed || !shouldPrompt) return;
    try {
      const cmd = parseCommand(line);
      const keepGoing = await handle(cmd);
      if (!keepGoing) {
        shouldPrompt = false;
        rl.close();
        return;
      }
    } catch (err) {
      if (err instanceof CursorAgentError) {
        printCursorError(err);
      } else {
        console.error(err.message ?? err);
      }
    }
    if (shouldPrompt) {
      rl.prompt();
    }
  }).catch((err) => {
    console.error(err.message ?? err);
    if (shouldPrompt) {
      rl.prompt();
    }
  });
});

rl.on("SIGINT", () => {
  shouldPrompt = false;
  rl.close();
});

rl.on("close", async () => {
  await shutdown();
  process.exit(0);
});
