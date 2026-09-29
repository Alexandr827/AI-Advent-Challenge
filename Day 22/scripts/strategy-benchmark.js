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
  "Ты бизнес-аналитик. Собираешь и уточняешь бизнес-требования к запуску продаж. Фиксируй договорённости явно. Отвечай по-русски, структурировано, без воды. Не выдумывай факты сверх того, что сказал пользователь.";

const WINDOW = 8;

const QUESTIONS = [
  "Цель: запуск продажи строительных инструментов на маркетплейсы. Нужно собрать бизнес-требования к проекту. Начни с рамки проекта и списка вопросов, которые ещё надо закрыть.",
  "Ограничения: старт за 8 недель, бюджет на закупки 1.5 млн руб, без своего склада — только фулфилмент маркетплейса. Предпочитаю таблицы и списки, без воды.",
  "Площадки: Ozon и Wildberries. Запомни: не трогаем Яндекс Маркет на первом этапе.",
  "Ассортимент: ручной инструмент, электроинструмент, расходники. SKU на старте 120, из них 40 — электроинструмент. Зафиксируй это в требованиях.",
  "География: склады/отгрузка из Москвы и Казани. Целевые регионы — ЦФО и ПФО. Как это влияет на логистику и карточки?",
  "Решили: бренд «Стальной Клин», ценовой сегмент средний+, гарантия 12 месяцев через сервис-партнёра. Обнови бренд-требования.",
  "Конкуренты: «ВсеИнструменты.ру» и нишевые кабинеты на Wildberries. Чем отличаемся и какие требования к контенту карточек из этого следуют?",
  "KPI первого квартала: GMV 4 млн руб, возвраты не выше 8%, рейтинг карточек не ниже 4.6. Договорились считать успех запуска только по этим трём цифрам.",
  "Сведи все собранные бизнес-требования в один документ: цель, ограничения, площадки, ассортимент, логистика, бренд, KPI. Ничего не выдумывай сверх договорённостей.",
  "Напомни бюджет, срок запуска и какие площадки мы сознательно отложили. Если чего-то нет в контексте — так и скажи.",
  "Пересмотри ассортимент: электроинструмент на старте режем с 40 до 25 SKU, общее число SKU остаётся 120. Обнови требования и скажи, что ещё не менялось.",
  "Составь backlog первого спринта запуска кабинета, опираясь на все договорённости. Не предлагай Яндекс Маркет и не предлагай свой склад.",
];

const CHECKS = [
  { id: "budget", label: "бюджет 1.5 млн", re: /1\s*[.,]?\s*5\s*млн|1,5\s*млн|1\.5\s*млн|1500000|1\s*500\s*000/i },
  { id: "weeks", label: "8 недель", re: /8\s*недел/i },
  { id: "fulfillment", label: "без своего склада / фулфилмент", re: /фулфилмент|fulfillment|без своего склада|FBO|FBS/i },
  { id: "ozon", label: "Ozon", re: /ozon|озон/i },
  { id: "wb", label: "Wildberries", re: /wildberries|вайлдберр|вб\b/i },
  { id: "noYm", label: "Яндекс Маркет отложен", re: /яндекс\s*маркет/i },
  { id: "sku120", label: "120 SKU", re: /\b120\b/ },
  { id: "sku40or25", label: "40 или 25 электро-SKU", re: /\b40\b|\b25\b/ },
  { id: "moscow", label: "Москва", re: /москв/i },
  { id: "kazan", label: "Казань", re: /казан/i },
  { id: "cfoPfo", label: "ЦФО/ПФО", re: /цфо|пфо/i },
  { id: "brand", label: "Стальной Клин", re: /стальной\s*клин/i },
  { id: "midplus", label: "средний+", re: /средн/i },
  { id: "warranty", label: "гарантия 12 мес", re: /12\s*мес/i },
  { id: "gmv", label: "GMV 4 млн", re: /4\s*млн/i },
  { id: "returns", label: "возвраты 8%", re: /8\s*%/ },
  { id: "rating", label: "рейтинг 4.6", re: /4[.,]6/ },
];

const PROBE_STEPS = new Set([9, 10, 11, 12]);

const AGENTS = [
  { name: "str-full", strategy: "full", window: WINDOW },
  { name: "str-sliding", strategy: "sliding", window: WINDOW },
  { name: "str-facts", strategy: "facts", window: WINDOW },
  { name: "str-branch", strategy: "branching", window: WINDOW },
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
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length <= n ? s : `${s.slice(0, n)}…`;
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

const outPath = resolve(projectRoot, "data", "strategy-benchmark.json");
const storePath = resolve(projectRoot, "data", "strategy-bench-agents.json");

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
  window: WINDOW,
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
      strategy: spec.strategy,
      window: spec.window,
      compress: false,
      systemPrompt: SYSTEM,
    });

    const agentReport = {
      name: agent.name,
      strategy: spec.strategy,
      window: spec.window,
      turns: [],
      facts: {},
      branches: null,
      finalUsage: null,
      finalOccupancy: null,
      messageCount: 0,
      probeHits: {},
    };
    report.agents.push(agentReport);
    persist(outPath, report);

    console.log(`\n=== ${spec.name} (${spec.strategy}) ===`);

    for (let i = 0; i < QUESTIONS.length; i++) {
      const step = i + 1;
      const query = QUESTIONS[i];

      if (spec.strategy === "branching" && step === 7) {
        agent.checkpoint();
        const branched = await agent.createBranches("ozon-first", "multi-mp");
        console.log(
          `  checkpoint+branch → ${branched.branches.join(", ")} current=${branched.current} (cp ${branched.checkpointCount} сообщ.)`,
        );
        agentReport.branches = agent.branchReport();
      }

      console.log(`  [${step}/${QUESTIONS.length}] ${preview(query, 90)}`);
      const started = Date.now();
      const { reply, tokens } = await askWithRetry(agent, query);
      const elapsedMs = Date.now() - started;
      const last = tokens.last ?? {};
      const checks = PROBE_STEPS.has(step) ? scoreReply(reply) : null;
      const turn = {
        step,
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
        factsCount: tokens.factsCount,
        currentBranch: tokens.currentBranch,
        usageTotal: tokens.usage.totalTokens,
        usageInput: tokens.usage.inputTokens,
        usageOutput: tokens.usage.outputTokens,
        checks,
      };
      agentReport.turns.push(turn);
      if (checks) {
        agentReport.probeHits[step] = checks.filter((c) => c.hit).map((c) => c.id);
      }
      agentReport.facts = agent.facts;
      agentReport.finalUsage = tokens.usage;
      agentReport.finalOccupancy = tokens.occupancy;
      agentReport.messageCount = tokens.messageCount;
      agentReport.branches = spec.strategy === "branching" ? agent.branchReport() : null;
      persist(outPath, report);
      console.log(
        `    chars=${reply.length} in=${last.requestBilled ?? "~"} out=${last.responseBilled ?? "~"} occ=${tokens.occupancy} msgs=${tokens.messageCount}/${tokens.promptMessageCount} ${elapsedMs}ms`,
      );
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
