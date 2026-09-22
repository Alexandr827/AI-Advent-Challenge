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
import {
  createProfileStorage,
  formatProfileCleared,
  formatProfileCreated,
  formatProfileDeleted,
  formatProfileList,
  formatProfileSet,
  ProfileService,
} from "./profile.js";
import {
  createInvariantStorage,
  formatInvariantAdded,
  formatInvariantCheck,
  formatInvariantCreated,
  formatInvariantDeleted,
  formatInvariantList,
  formatInvariantRemoved,
  InvariantService,
} from "./invariant.js";
import {
  formatTaskApplied,
  formatTaskBanner,
  formatTaskReport,
  formatResume,
  formatStageCheck,
  formatTransitionMessage,
  isActiveTask,
} from "./task.js";
import {
  ContextOverflowError,
  formatAskTokenLine,
  formatTokensCommand,
} from "./tokens.js";

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

const profiles = new ProfileService({
  storage: createProfileStorage({
    dir: resolve(projectRoot, "data", "profiles"),
    dbPath: resolve(projectRoot, "data", "profiles.db.json"),
    apiUrl: process.env.PROFILE_API_URL,
  }),
});

const invariants = new InvariantService({
  storage: createInvariantStorage({
    path: resolve(projectRoot, "data", "invariants.json"),
  }),
});

const pool = new AgentPool({
  apiKey: API_KEY,
  defaultModel: MODEL,
  defaultRuntime: RUNTIME,
  cwd: projectRoot,
  storePath: resolve(projectRoot, "data", "agents.json"),
  profileLoader: profiles.loader,
  invariantLoader: invariants.loader,
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
  const task =
    item.memory?.task && item.memory.taskState
      ? `  task=${item.memory.taskState} ${item.memory.taskStep}/${item.memory.taskTotal}`
      : "";
  const profile = item.profileId
    ? `  profile=${item.profileId}`
    : "";
  const invariantSet = item.invariantSetId
    ? `  invariants=${item.invariantSetId}`
    : "";
  return `  #${item.id}  ${item.name}  model=${item.model}  runtime=${item.runtime}  ${item.status}  messages=${item.messages ?? 0}${summarized}${mem}${task}${profile}${invariantSet}${tokens}${system}`;
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
      if (cmd.profileId && !(await profiles.loader.exists(cmd.profileId))) {
        throw new Error(`Профиль не найден: ${cmd.profileId}`);
      }
      if (cmd.invariantSetId && !(await invariants.loader.exists(cmd.invariantSetId))) {
        throw new Error(`Набор инвариантов не найден: ${cmd.invariantSetId}`);
      }
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
        profileId: cmd.profileId,
        invariantSetId: cmd.invariantSetId,
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
      const { reply, tokens, task, invariants: invariantResult } = await agent.ask(cmd.text);
      if (task?.active) {
        const shown = isActiveTask(task.before) ? task.before : task.context;
        const banner = formatTaskBanner(shown);
        if (banner) console.log(banner);
      }
      const checkLine = formatInvariantCheck(invariantResult);
      if (checkLine) console.log(checkLine);
      const stageLine = formatStageCheck(invariantResult);
      if (stageLine) console.log(stageLine);
      console.log(reply.trim() || "(пусто)");
      if (task?.changed) {
        console.log(formatTaskApplied(task.applied, task.context));
      }
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
        console.log(formatTaskReport(agent.taskContext));
        console.log(agent.memoryReport("working"));
        return true;
      }
      if (cmd.action === "continue") {
        console.log(formatResume(agent.taskContext));
        console.log(formatTaskReport(agent.taskContext));
        return true;
      }
      if (cmd.action === "clear") {
        const result = await agent.forget("working");
        console.log(formatForgetResult(result));
        return true;
      }
      if (cmd.action === "plan") {
        const context = await agent.setTaskPlan(cmd.items);
        console.log(formatTaskReport(context));
        return true;
      }
      if (cmd.action === "approve") {
        const { previous, context } = await agent.approveTask();
        console.log(formatTransitionMessage(previous, context));
        console.log(formatTaskReport(context));
        return true;
      }
      if (cmd.action === "next") {
        const context = await agent.nextTaskStep(cmd.current);
        console.log(formatTaskReport(context));
        return true;
      }
      if (cmd.action === "transition") {
        const { previous, context } = await agent.transitionTask(cmd.state);
        console.log(formatTransitionMessage(previous, context));
        console.log(formatTaskReport(context));
        return true;
      }
      if (cmd.action === "current") {
        const context = await agent.setTaskCurrent(cmd.current);
        console.log(formatTaskReport(context));
        return true;
      }
      const started = await agent.startTask(cmd.title);
      console.log(
        started.task
          ? `Новая задача ${agent.name}: «${started.task}». Этап PLANNING, шаг 1/1. Рабочая память очищена.`
          : `Новая задача ${agent.name}: рабочая память очищена.`,
      );
      if (started.task) {
        console.log(formatTaskReport(started.context));
      }
      return true;
    }
    case "profile": {
      if (cmd.action === "list") {
        console.log(formatProfileList(await profiles.list()));
        return true;
      }
      if (cmd.action === "create") {
        const created = await profiles.create(cmd.userId, { name: cmd.name });
        console.log(formatProfileCreated(created));
        return true;
      }
      if (cmd.action === "delete") {
        const attached = pool
          .list()
          .filter((item) => item.profileId === cmd.userId)
          .map((item) => requireAgent(item.id));
        for (const agent of attached) {
          await agent.detachProfile();
        }
        const id = await profiles.remove(cmd.userId);
        console.log(formatProfileDeleted(id, attached));
        return true;
      }
      if (cmd.action === "attach") {
        const agent = requireAgent(cmd.target);
        const profile = await agent.attachProfile(cmd.userId);
        console.log(`Профиль ${profile.userId} подключён к агенту ${agent.name}`);
        return true;
      }
      if (cmd.action === "detach") {
        const agent = requireAgent(cmd.target);
        await agent.detachProfile();
        console.log(`Профиль отключён от агента ${agent.name}`);
        return true;
      }
      if (cmd.action === "name") {
        const profile = await profiles.setName(cmd.userId, cmd.name);
        console.log(`Профиль ${profile.userId}: имя = ${profile.name}`);
        return true;
      }
      if (cmd.action === "clear") {
        const result = await profiles.clear(cmd.userId, cmd.section, cmd.key);
        console.log(formatProfileCleared(result));
        return true;
      }
      const profile = await profiles.load(cmd.userId);
      console.log(profiles.format(profile));
      return true;
    }
    case "invariant": {
      if (cmd.action === "list") {
        console.log(formatInvariantList(await invariants.list()));
        return true;
      }
      if (cmd.action === "create") {
        const created = await invariants.create(cmd.setId);
        console.log(formatInvariantCreated(created));
        return true;
      }
      if (cmd.action === "delete") {
        const attached = pool
          .list()
          .filter((item) => item.invariantSetId === cmd.setId)
          .map((item) => requireAgent(item.id));
        for (const agent of attached) {
          await agent.detachInvariants();
        }
        const id = await invariants.delete(cmd.setId);
        console.log(formatInvariantDeleted(id, attached));
        return true;
      }
      if (cmd.action === "attach") {
        const agent = requireAgent(cmd.target);
        const set = await agent.attachInvariants(cmd.setId);
        console.log(`Инварианты ${set.id} подключены к агенту ${agent.name}`);
        return true;
      }
      if (cmd.action === "detach") {
        const agent = requireAgent(cmd.target);
        await agent.detachInvariants();
        console.log(`Инварианты отключены от агента ${agent.name}`);
        return true;
      }
      if (cmd.action === "add") {
        const result = await invariants.add(cmd.setId, cmd.specType, cmd.specArgs);
        console.log(formatInvariantAdded(result));
        return true;
      }
      if (cmd.action === "rm") {
        const result = await invariants.remove(cmd.setId, cmd.itemId);
        console.log(formatInvariantRemoved(result));
        return true;
      }
      const set = await invariants.load(cmd.setId);
      console.log(invariants.format(set));
      return true;
    }
    case "style":
    case "constraints":
    case "context": {
      if (cmd.action === "show") {
        const profile = await profiles.load(cmd.userId);
        console.log(profiles.format(profile));
        return true;
      }
      const result = await profiles.setEntry(
        cmd.userId,
        cmd.section,
        cmd.key,
        cmd.value,
      );
      console.log(formatProfileSet(result));
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
  "Введите help для списка команд. Память: short / working / long. Задача: planning → execution → validation → done (переходы контролируемые). Персонализация: profile / style / constraints / context. Инварианты: invariant — отдельное хранилище, проверка каждого ответа.",
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
