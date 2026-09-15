import readline from "node:readline";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CursorAgentError } from "@cursor/sdk";
import { loadEnv } from "./env.js";
import { AgentPool, MAX_AGENTS } from "./pool.js";
import { helpText, parseCommand } from "./cli.js";
import {
  formatBranches,
  formatFactsList,
  strategyLabel,
} from "./strategy.js";
import {
  formatForgetResult,
  formatRememberResult,
  parseRememberPayload,
} from "./memory.js";
import { ContextOverflowError, formatAskTokenLine, formatTokensCommand } from "./tokens.js";

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
  storePath: resolve(projectRoot, "data", "agents.json"),
});

function formatAgent(agent) {
  const item = agent.snapshot ?? agent;
  const system = item.systemPrompt
    ? ` system=${JSON.stringify(item.systemPrompt)}`
    : "";
  const tokens =
    item.tokens != null
      ? `  tokens=${item.tokens}  ctx=${item.occupancy ?? 0}/${item.contextLimit ?? "?"}`
      : "";
  const summarized =
    item.strategy && item.strategy !== "full"
      ? ` strategy=${strategyLabel(item.strategy, {
          window: item.window,
          factsCount: item.factsCount,
          currentBranch: item.currentBranch,
        })}`
      : item.compress
        ? ` compress=${item.compressEvery}${item.summarizedCount ? ` summary=${item.summarizedCount}` : ""}`
        : " compress=off";
  const mem = item.memory
    ? `  memory=s${item.memory.short}/w${item.memory.working}/l${item.memory.long}`
    : "";
  return `  #${item.id}  ${item.name}  model=${item.model}  runtime=${item.runtime}  ${item.status}  messages=${item.messages ?? 0}${summarized}${mem}${tokens}${system}`;
}

function printCursorError(err) {
  console.error(`Ошибка Cursor: ${err.message}`);
  if (/cloud/i.test(err.message) && RUNTIME === "local") {
    console.error("Подсказка: для cloud задайте CURSOR_RUNTIME=cloud или spawn --runtime cloud");
  }
}

function requireAgent(target) {
  const agent = pool.get(target);
  if (!agent) {
    throw new Error(`Агент не найден: ${target}`);
  }
  return agent;
}

function formatAgentStrategy(agent) {
  return `Стратегия ${agent.name}: ${strategyLabel(agent.strategy, {
    window: agent.window,
    factsCount: Object.keys(agent.facts).length,
    currentBranch: agent.currentBranch,
  })}`;
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
        contextLimit: cmd.contextLimit,
        compress: cmd.compress,
        compressEvery: cmd.compressEvery,
        strategy: cmd.strategy,
        window: cmd.window,
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
      const { reply, tokens } = await agent.ask(cmd.text);
      console.log(reply.trim() || "(пусто)");
      console.log(formatAskTokenLine(tokens));
      return true;
    }
    case "strategy": {
      const agent = requireAgent(cmd.target);
      if (cmd.strategy == null && cmd.window == null) {
        console.log(formatAgentStrategy(agent));
        return true;
      }
      if (cmd.strategy) {
        await agent.setStrategy(cmd.strategy, { window: cmd.window });
      } else {
        await agent.setWindow(cmd.window);
      }
      console.log(formatAgentStrategy(agent));
      return true;
    }
    case "window": {
      const agent = requireAgent(cmd.target);
      await agent.setWindow(cmd.window);
      console.log(formatAgentStrategy(agent));
      return true;
    }
    case "facts": {
      const agent = requireAgent(cmd.target);
      console.log(`Факты ${agent.name} (стратегия ${agent.strategy}):`);
      console.log(formatFactsList(agent.facts));
      return true;
    }
    case "checkpoint": {
      const agent = requireAgent(cmd.target);
      const count = agent.checkpoint();
      console.log(`Чекпоинт ${agent.name}: сохранено ${count} сообщ.`);
      return true;
    }
    case "branch": {
      const agent = requireAgent(cmd.target);
      const result = await agent.createBranches(cmd.branchA, cmd.branchB);
      console.log(
        `Ветки ${result.branches.join(" и ")} созданы от чекпоинта (${result.checkpointCount} сообщ.). Текущая: ${result.current}`,
      );
      return true;
    }
    case "use": {
      const agent = requireAgent(cmd.target);
      const branch = await agent.useBranch(cmd.branch);
      console.log(
        `Переключено на ветку ${branch} (${agent.messages.length} сообщ.)`,
      );
      return true;
    }
    case "branches": {
      const agent = requireAgent(cmd.target);
      console.log(formatBranches(agent.branchReport()));
      return true;
    }
    case "remember": {
      const agent = requireAgent(cmd.target);
      const payload = parseRememberPayload(cmd.payload);
      const result = await agent.remember(cmd.layer, { ...payload, kind: cmd.kind });
      console.log(formatRememberResult(result));
      return true;
    }
    case "forget": {
      const agent = requireAgent(cmd.target);
      const result = await agent.forget(cmd.layer, { key: cmd.key, kind: cmd.kind });
      console.log(formatForgetResult(result));
      return true;
    }
    case "memory": {
      const agent = requireAgent(cmd.target);
      console.log(`Память ${agent.name}:`);
      console.log(agent.memoryReport(cmd.layer));
      return true;
    }
    case "task": {
      const agent = requireAgent(cmd.target);
      if (cmd.action === "show") {
        const working = agent.memory.working;
        const title = working.task || "(нет активной задачи)";
        console.log(`Задача ${agent.name}: ${title}`);
        console.log(agent.memoryReport("working"));
        return true;
      }
      if (cmd.action === "clear") {
        const result = await agent.forget("working");
        console.log(formatForgetResult(result));
        return true;
      }
      const started = await agent.startTask(cmd.title);
      console.log(
        started.task
          ? `Новая задача ${agent.name}: «${started.task}». Рабочая память очищена.`
          : `Новая задача ${agent.name}: рабочая память очищена.`,
      );
      return true;
    }
    case "tokens": {
      const agent = pool.get(cmd.target);
      if (!agent) {
        throw new Error(`Агент не найден: ${cmd.target}`);
      }
      const sdkUsage = await agent.billedUsage();
      console.log(formatTokensCommand(agent.tokenReport, sdkUsage));
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
  await pool.disposeAll();
}

console.log(
  `CLI-хост агентов. Модель по умолчанию: ${MODEL}, runtime: ${RUNTIME}. Лимит: ${MAX_AGENTS}.`,
);
if (pool.size) {
  console.log(`Восстановлено агентов: ${pool.size}. История диалогов загружена.`);
}
console.log(
  "Введите help для списка команд. Память: short / working / long — remember, forget, memory, task; в ask — префикс /working или /long:…",
);
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
      if (err instanceof ContextOverflowError) {
        console.error(err.message);
      } else if (err instanceof CursorAgentError) {
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
