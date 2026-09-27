import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/env.js";
import { AgentPool } from "../src/pool.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(resolve(projectRoot, ".env"));

const API_KEY = process.env.CURSOR_API_KEY?.trim();
const MODEL = process.env.CURSOR_MODEL ?? "composer-2.5";
const RUNTIME = (process.env.CURSOR_RUNTIME ?? "local").toLowerCase();

if (!API_KEY) {
  console.error("Задайте CURSOR_API_KEY в .env");
  process.exit(1);
}

const SYSTEM =
  "Отвечай по-русски. Опирайся только на факты из контекста и из блоков памяти. Если факта нет — напиши «нет в контексте», не выдумывай.";

const Q1 = "Меня зовут Алексей. Отвечай кратко, по-русски, без воды.";
const Q2 =
  "Задача: спроектировать REST API списка задач. Ограничение: без внешних сервисов и без ORM.";
const Q3 = "Решили: аутентификация только JWT, ресурс задач — /tasks.";
const Q4 = "Статусы задачи: todo, doing, done. Зафиксируй это как договорённость.";
const Q5 = "Набросай эндпоинты списка задач, опираясь на то, что уже сказано.";
const PROBE_A =
  "Как меня зовут и в каком стиле отвечать? Какой auth и путь ресурса? Цель задачи и ограничения? Какие статусы? Нет в контексте — так и скажи.";
const PROBE_C =
  "Напомни цель текущей задачи и ограничение про ORM. Напомни auth и как меня зовут. Нет в контексте — так и скажи.";

const QUESTIONS = [Q1, Q2, Q3, Q4, Q5, PROBE_A, PROBE_A, PROBE_C];

const CHECKS = [
  { id: "name", label: "Алексей", re: /алексе/i },
  { id: "style", label: "кратко / без воды", re: /кратко|без воды/i },
  { id: "jwt", label: "JWT", re: /jwt/i },
  { id: "tasks", label: "/tasks", re: /\/tasks/i },
  { id: "goal", label: "цель REST API / список задач", re: /rest\s*api|списк[аеу]\s+задач/i },
  { id: "orm", label: "без ORM / внешних сервисов", re: /orm|внешн/i },
  { id: "todo", label: "статусы todo/doing/done", re: /todo/i },
  { id: "missing", label: "нет в контексте", re: /нет в контексте/i },
];

const MEM_ON_REMEMBER = [
  { layer: "long", kind: "profile", key: "имя", value: "Алексей" },
  { layer: "long", kind: "profile", key: "стиль", value: "кратко, по-русски, без воды" },
  { layer: "long", kind: "decisions", key: "auth", value: "JWT" },
  { layer: "long", kind: "decisions", key: "ресурс", value: "/tasks" },
  { layer: "long", kind: "knowledge", key: "статусы", value: "todo | doing | done" },
];

const MEM_ON_WORKING = [
  { layer: "working", key: "цель", value: "REST API списка задач" },
  {
    layer: "working",
    key: "ограничения",
    value: "без внешних сервисов и без ORM",
  },
];

const AGENTS = [
  { name: "mem-off", useMemory: false },
  { name: "mem-on", useMemory: true },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function scoreReply(text) {
  return CHECKS.map((check) => ({
    id: check.id,
    label: check.label,
    hit: check.re.test(text),
  }));
}

function preview(text, n = 280) {
  const s = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function snapshotMemory(agent) {
  return {
    messages: agent.messages.length,
    memory: agent.memory,
    counts: agent.tokenReport.memory,
  };
}

async function askWithRetry(agent, text, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await agent.ask(text);
    } catch (err) {
      lastErr = err;
      console.error(`  retry ${i}/${attempts} ${agent.name}: ${err.message ?? err}`);
      await sleep(2000 * i);
    }
  }
  throw lastErr;
}

function persist(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function recordTurn(agentReport, turn) {
  agentReport.turns.push(turn);
  if (turn.checks) {
    agentReport.probeHits[turn.step] = turn.checks.filter((c) => c.hit).map((c) => c.id);
  }
}

async function runAsk(agent, agentReport, { step, label, query, probe }) {
  console.log(`  [${step}] ${label}: ${preview(query, 90)}`);
  const started = Date.now();
  const { reply, tokens } = await askWithRetry(agent, query);
  const elapsedMs = Date.now() - started;
  const last = tokens.last ?? {};
  const turn = {
    step,
    label,
    query,
    elapsedMs,
    replyChars: reply.length,
    replyPreview: preview(reply, 400),
    reply: reply.trim(),
    requestEstimated: last.requestEstimated ?? null,
    requestBilled: last.requestBilled,
    responseEstimated: last.responseEstimated ?? null,
    responseBilled: last.responseBilled,
    occupancy: tokens.occupancy,
    percent: tokens.percent,
    promptMessageCount: tokens.promptMessageCount,
    messageCount: tokens.messageCount,
    usageTotal: tokens.usage.totalTokens,
    usageInput: tokens.usage.inputTokens,
    usageOutput: tokens.usage.outputTokens,
    memory: snapshotMemory(agent),
    checks: probe ? scoreReply(reply) : null,
  };
  recordTurn(agentReport, turn);
  agentReport.finalUsage = tokens.usage;
  agentReport.finalOccupancy = tokens.occupancy;
  agentReport.messageCount = tokens.messageCount;
  agentReport.memory = snapshotMemory(agent);
  console.log(
    `    chars=${reply.length} in=${last.requestBilled ?? "~"} out=${last.responseBilled ?? "~"} occ=${tokens.occupancy} msgs=${tokens.messageCount} ${elapsedMs}ms`,
  );
  return turn;
}

const outPath = resolve(projectRoot, "data", "memory-benchmark.json");
const storePath = resolve(projectRoot, "data", "memory-bench-agents.json");

const pool = new AgentPool({
  apiKey: API_KEY,
  defaultModel: MODEL,
  defaultRuntime: RUNTIME,
  cwd: projectRoot,
  storePath,
});

const report = {
  model: MODEL,
  runtime: RUNTIME,
  at: new Date().toISOString(),
  systemPrompt: SYSTEM,
  questions: QUESTIONS,
  agents: [],
};

persist(outPath, report);

try {
  for (const spec of AGENTS) {
    const existing = pool.get(spec.name);
    if (existing) await pool.kill(spec.name);

    const [agent] = pool.spawn({
      name: spec.name,
      strategy: "full",
      compress: false,
      systemPrompt: SYSTEM,
    });

    const agentReport = {
      name: agent.name,
      useMemory: spec.useMemory,
      turns: [],
      probeHits: {},
      memoryAfterSetup: null,
      memoryAfterForget: null,
      memoryAfterNewTask: null,
      finalUsage: null,
      finalOccupancy: null,
      messageCount: 0,
      memory: snapshotMemory(agent),
    };
    report.agents.push(agentReport);
    persist(outPath, report);

    console.log(`\n=== ${spec.name} (memory ${spec.useMemory ? "on" : "off"}) ===`);

    await runAsk(agent, agentReport, { step: 1, label: "setup", query: Q1 });
    persist(outPath, report);
    await runAsk(agent, agentReport, { step: 2, label: "setup", query: Q2 });
    persist(outPath, report);
    await runAsk(agent, agentReport, { step: 3, label: "setup", query: Q3 });
    persist(outPath, report);
    await runAsk(agent, agentReport, { step: 4, label: "setup", query: Q4 });
    persist(outPath, report);

    if (spec.useMemory) {
      console.log("  [remember] long profile/decisions/knowledge + working");
      for (const item of MEM_ON_REMEMBER) {
        await agent.remember(item.layer, item);
      }
      await agent.startTask("Спроектировать REST API");
      for (const item of MEM_ON_WORKING) {
        await agent.remember(item.layer, item);
      }
      agentReport.memoryAfterSetup = snapshotMemory(agent);
      agentReport.turns.push({
        step: "remember",
        label: "remember+task",
        memory: snapshotMemory(agent),
      });
      persist(outPath, report);
    }

    await runAsk(agent, agentReport, { step: 5, label: "endpoints", query: Q5 });
    persist(outPath, report);
    await runAsk(agent, agentReport, {
      step: 6,
      label: "probe-A",
      query: PROBE_A,
      probe: true,
    });
    persist(outPath, report);

    console.log("  [forget] short");
    await agent.forget("short");
    agentReport.memoryAfterForget = snapshotMemory(agent);
    agentReport.turns.push({
      step: "forget-short",
      label: "forget short",
      memory: snapshotMemory(agent),
    });
    persist(outPath, report);

    await runAsk(agent, agentReport, {
      step: 7,
      label: "probe-B",
      query: PROBE_A,
      probe: true,
    });
    persist(outPath, report);

    if (spec.useMemory) {
      console.log("  [task] start Другая задача");
      await agent.startTask("Другая задача");
      agentReport.memoryAfterNewTask = snapshotMemory(agent);
      agentReport.turns.push({
        step: "task-start",
        label: "task start Другая задача",
        memory: snapshotMemory(agent),
      });
      persist(outPath, report);
    }

    await runAsk(agent, agentReport, {
      step: 8,
      label: "probe-C",
      query: PROBE_C,
      probe: true,
    });
    persist(outPath, report);

    console.log(
      `  done ${spec.name}: in=${agentReport.finalUsage.inputTokens} out=${agentReport.finalUsage.outputTokens} total=${agentReport.finalUsage.totalTokens}`,
    );
  }

  report.atEnd = new Date().toISOString();
  persist(outPath, report);
  console.log(`\nSaved ${outPath}`);
} finally {
  await pool.disposeAll();
}
