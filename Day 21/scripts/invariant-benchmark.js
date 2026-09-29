import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/env.js";
import { AgentPool } from "../src/pool.js";
import {
  createInvariantStorage,
  formatInvariantCheck,
  InvariantService,
  validateResponse,
} from "../src/invariant.js";

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
  "Отвечай по-русски, кратко, на уровне проектирования. Если вопрос про проект — предлагай конкретный стек, архитектуру и зависимости.";

const SET_ID = "bpmn";

const QUESTIONS = [
  {
    id: "compatible",
    label: "совместимый запрос",
    query:
      "Спроектируй сервис запуска исполняемых BPMN-процессов. Какой стек, архитектуру и API взять?",
  },
  {
    id: "stack",
    label: "конфликт стека",
    query: "Давай сделаем проект на C# и ASP.NET",
  },
  {
    id: "arch",
    label: "конфликт архитектуры",
    query: "Сделай архитектуру MVC, классический контроллер и представление",
  },
  {
    id: "decision",
    label: "конфликт решения REST",
    query: "Давай перейдём на GraphQL вместо REST",
  },
  {
    id: "apis",
    label: "конфликт платного API",
    query: "Подключи Stripe для приёма оплаты",
  },
  {
    id: "neutral",
    label: "нейтральный вопрос",
    query: "Сколько будет 2+2?",
  },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function preview(text, n = 360) {
  const s = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function mentionScore(reply) {
  const text = String(reply ?? "");
  return {
    node: /node/i.test(text),
    javascript: /javascript|\bjs\b/i.test(text),
    csharp: /c#|csharp|си шарп|\.net|asp\.net/i.test(text),
    mvvm: /mvvm/i.test(text),
    mvc: /mvc/i.test(text),
    graphql: /graphql/i.test(text),
    rest: /\brest\b/i.test(text),
    stripe: /stripe/i.test(text),
    refusal:
      /запрещ|нельзя|не вход|отказ|нарушен|не использу|не подходит|нельзя предлагать|не бер/i.test(
        text,
      ),
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

const outPath = resolve(projectRoot, "data", "invariant-benchmark.json");
const storePath = resolve(projectRoot, "data", "invariant-bench-agents.json");
const invariantPath = resolve(projectRoot, "data", "invariant-bench.json");

const invariants = new InvariantService({
  storage: createInvariantStorage({ path: invariantPath }),
});

async function ensureSet() {
  if (await invariants.loader.exists(SET_ID)) {
    await invariants.delete(SET_ID);
  }
  await invariants.create(SET_ID);
  await invariants.add(SET_ID, "stack", ["NodeJS", "JavaScript"]);
  await invariants.add(SET_ID, "arch", ["MVVM"]);
  await invariants.add(SET_ID, "budget", ["100000"]);
  await invariants.add(SET_ID, "maxdeps", ["5"]);
  await invariants.add(SET_ID, "nobanned", ["RxJava"]);
  await invariants.add(SET_ID, "decision", ["REST без GraphQL"]);
  await invariants.add(SET_ID, "apis", ["free"]);
  return invariants.load(SET_ID);
}

const pool = new AgentPool({
  apiKey: API_KEY,
  defaultModel: MODEL,
  defaultRuntime: RUNTIME,
  cwd: projectRoot,
  storePath,
  invariantLoader: invariants.loader,
});

const report = {
  model: MODEL,
  runtime: RUNTIME,
  at: new Date().toISOString(),
  systemPrompt: SYSTEM,
  setId: SET_ID,
  questions: QUESTIONS,
  agents: [],
};

persist(outPath, report);

try {
  const set = await ensureSet();
  report.set = {
    id: set.id,
    items: set.items.map((item) => ({
      id: item.id,
      type: item.type,
      description: item.description,
    })),
  };
  persist(outPath, report);

  const specs = [
    { name: "inv-off", invariantSetId: "" },
    { name: "inv-on", invariantSetId: SET_ID },
  ];

  for (const spec of specs) {
    const existing = pool.get(spec.name);
    if (existing) await pool.kill(spec.name);

    const [agent] = pool.spawn({
      name: spec.name,
      strategy: "full",
      compress: false,
      systemPrompt: SYSTEM,
      invariantSetId: spec.invariantSetId || undefined,
    });

    const agentReport = {
      name: agent.name,
      invariantSetId: spec.invariantSetId || "",
      occupancyBeforeAsk: agent.tokenReport.occupancy,
      turns: [],
      finalUsage: null,
      finalOccupancy: null,
      messageCount: 0,
    };
    report.agents.push(agentReport);
    persist(outPath, report);

    console.log(
      `\n=== ${spec.name} (invariants ${spec.invariantSetId || "none"}) occ=${agent.tokenReport.occupancy} ===`,
    );

    for (const [index, question] of QUESTIONS.entries()) {
      const step = index + 1;
      console.log(`  [${step}] ${question.label}: ${preview(question.query, 80)}`);
      const started = Date.now();
      const { reply, tokens, invariants: pipeline } = await askWithRetry(
        agent,
        question.query,
      );
      const elapsedMs = Date.now() - started;
      const last = tokens.last ?? {};
      const published = validateResponse(reply, set.items);
      const checkLine = formatInvariantCheck(pipeline);
      const turn = {
        step,
        id: question.id,
        label: question.label,
        query: question.query,
        elapsedMs,
        replyChars: reply.length,
        replyPreview: preview(reply, 500),
        reply: reply.trim(),
        requestEstimated: last.requestEstimated ?? null,
        requestBilled: last.requestBilled,
        responseEstimated: last.responseEstimated ?? null,
        responseBilled: last.responseBilled,
        occupancy: tokens.occupancy,
        percent: tokens.percent,
        messageCount: tokens.messageCount,
        usageTotal: tokens.usage.totalTokens,
        usageInput: tokens.usage.inputTokens,
        usageOutput: tokens.usage.outputTokens,
        pipeline: {
          ok: pipeline?.ok ?? null,
          status: pipeline?.status ?? null,
          refused: pipeline?.refused ?? false,
          attempts: pipeline?.attempts ?? 1,
          violations: (pipeline?.violations ?? []).map((item) => item.description),
          checkLine: checkLine || "",
        },
        publishedCheck: {
          ok: published.ok,
          status: published.status,
          violations: published.violations.map((item) => item.description),
        },
        mentions: mentionScore(reply),
      };
      agentReport.turns.push(turn);
      agentReport.finalUsage = tokens.usage;
      agentReport.finalOccupancy = tokens.occupancy;
      agentReport.messageCount = tokens.messageCount;
      persist(outPath, report);
      console.log(
        `    ${published.ok ? "PASS" : "FAIL"} host=${pipeline?.refused ? "REFUSE" : pipeline?.attempts > 1 ? "RETRY" : "ok"} attempts=${pipeline?.attempts ?? 1} chars=${reply.length} in=${last.requestBilled ?? "~"} out=${last.responseBilled ?? "~"} ${elapsedMs}ms`,
      );
      if (checkLine) console.log(`    ${checkLine}`);
      console.log(`    ${preview(reply, 220)}`);
    }

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
