import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  citationAligned,
  parseCitedAnswer,
  quotesAreGrounded,
} from "../src/doc-index/rag.js";
import { openIndex } from "../src/doc-index/store.js";
import { assertCursorApiKey, loadEnv } from "../src/env.js";
import { completeChat, DEFAULT_LMSTUDIO_MODEL } from "../src/lmstudio.js";
import { AgentPool } from "../src/pool.js";
import { articleHit, ensureLawIndex, expectHit, sleep, writeBenchJson } from "./lib/bench-runtime.js";
import { flagsMatch, median } from "./lib/rag-local.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(resolve(projectRoot, ".env"));

const API_KEY = assertCursorApiKey(process.env.CURSOR_API_KEY);
const LOCAL_MODEL = DEFAULT_LMSTUDIO_MODEL;
const CLOUD_MODEL = "composer-2.5";
const PASSES = 2;
const lawPath = ensureLawIndex(projectRoot);

const SYSTEM =
  "Отвечай по-русски только по фрагментам закона. Нужны три блока: ответ, источники и дословные цитаты. Не выдумывай норму.";

/** Первые три вопроса о норме из сценария дня 25 (дистанционная продажа). Строки без id задают память чата. */
const TURNS = [
  { text: "Цель: подготовить чеклист рекламы товара при дистанционной продаже." },
  { text: "Уточняю: продавец — индивидуальный предприниматель, товар — книги." },
  { text: "Ограничение: отвечаем только по 38-ФЗ, без других законов." },
  {
    text: "Термин: дистанционный способ — продажа без непосредственного ознакомления покупателя с товаром.",
  },
  {
    id: "seller",
    text: "Какие сведения о продавце обязательны в рекламе товара при дистанционном способе продажи?",
    article: "Статья 8.",
    pattern: "наименован|ОГРН|место нахожден|фамили",
  },
  {
    id: "ip",
    text: "А какие сведения нужны именно для индивидуального предпринимателя?",
    article: "Статья 8.",
    pattern: "индивидуальн|фамили|регистрационн",
  },
  { text: "Фиксируем: срок хранения материалов считаем календарным, не рабочими днями." },
  {
    id: "storage",
    text: "Сколько хранить рекламные материалы или их копии?",
    article: "Статья 12.",
    pattern: "одного года|в течение года|1 год",
  },
];

const QUESTIONS = TURNS.filter((turn) => turn.id);

const AGENTS = [
  { key: "local", name: "day28-qwen", model: LOCAL_MODEL, runtime: "lmstudio" },
  { key: "cloud", name: "day28-composer", model: CLOUD_MODEL, runtime: "local" },
];

try {
  await completeChat({
    model: LOCAL_MODEL,
    prompt: "Ответь одним словом: да",
    maxTokens: 64,
    enableThinking: false,
  });
} catch (err) {
  console.error(err?.message ?? err);
  process.exit(1);
}

const pool = new AgentPool({
  apiKey: API_KEY,
  defaultModel: LOCAL_MODEL,
  defaultRuntime: "lmstudio",
  cwd: projectRoot,
});

const db = openIndex(lawPath, { readOnly: true });
const chunkById = db.prepare(
  "SELECT chunk_id, source, section, text, file FROM chunks WHERE chunk_id = ?",
);

function hitsFor(quotes) {
  const ids = [...new Set((quotes ?? []).map((item) => item.chunk_id).filter(Boolean))];
  return ids.map((id) => chunkById.get(id)).filter(Boolean);
}

const report = {
  at: new Date().toISOString(),
  source: "day-25 distance-sale, first three law questions",
  passes: PASSES,
  systemPrompt: SYSTEM,
  agents: AGENTS.map(({ key, model, runtime }) => ({ key, model, runtime })),
  questions: QUESTIONS.map((question) => ({
    id: question.id,
    question: question.text,
    article: question.article,
    local: [],
    cloud: [],
  })),
};

const outPath = resolve(projectRoot, "data", "rag-day28-compare.json");

function sideStats(key) {
  const runs = [];
  let stable = 0;
  for (const question of report.questions) {
    const pair = question[key] ?? [];
    if (pair.length >= 2 && !pair[0]?.error && !pair[1]?.error && flagsMatch(pair[0], pair[1])) {
      stable += 1;
    }
    for (const run of pair) {
      if (!run || run.error || run.abstained) continue;
      if (Number.isFinite(run.latencyMs)) runs.push(run);
    }
  }
  const first = report.questions.map((question) => question[key]?.[0]).filter(Boolean);
  const latencies = runs.map((run) => run.latencyMs);
  return {
    questions: report.questions.length,
    expect: first.filter((run) => run.expectHit).length,
    article: first.filter((run) => run.sourceHit).length,
    sources: first.filter((run) => run.sourcesOk).length,
    quotes: first.filter((run) => run.quotesOk).length,
    aligned: first.filter((run) => run.aligned).length,
    abstained: first.filter((run) => run.abstained).length,
    speed: {
      medianMs: median(latencies),
      maxMs: latencies.length ? Math.max(...latencies) : null,
      samples: latencies.length,
    },
    stability: { stable, questions: report.questions.length },
  };
}

function persist() {
  report.summary = {
    local: sideStats("local"),
    cloud: sideStats("cloud"),
  };
  writeBenchJson(outPath, report);
}

async function askChat(agent, text) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const started = Date.now();
    try {
      const result = await agent.chat(text);
      return { result, latencyMs: Date.now() - started, retries: attempt - 1 };
    } catch (err) {
      lastErr = err;
      console.error(`  retry ${attempt}/3 ${agent.name}: ${err.message ?? err}`);
      if (/Локальная LLM недоступна/.test(String(err?.message ?? ""))) throw err;
      if (attempt === 3) break;
      await sleep(2000 * attempt);
    }
  }
  throw lastErr;
}

function score(question, result, latencyMs, retries) {
  const sources = result.sources ?? [];
  const quotes = result.quotes ?? [];
  const answer = parseCitedAnswer(result.reply);
  const hits = hitsFor(quotes.length ? quotes : sources);
  return {
    reply: result.reply,
    answer,
    abstained: Boolean(result.abstained),
    sources,
    quotes,
    sourcesOk: sources.length > 0 && sources.every((source) => source.source && source.section && source.chunk_id),
    quotesOk: quotesAreGrounded(quotes, hits),
    aligned: citationAligned(answer, quotes, question.pattern),
    expectHit: expectHit(question.pattern, result.reply),
    sourceHit: articleHit(question.article, sources),
    latencyMs,
    retries,
  };
}

persist();

try {
  for (let pass = 0; pass < PASSES; pass++) {
    console.log(`\n--- проход ${pass + 1}/${PASSES} ---`);
    for (const spec of AGENTS) {
      if (pool.get(spec.name)) await pool.kill(spec.name);
      const [agent] = pool.spawn({
        name: spec.name,
        model: spec.model,
        runtime: spec.runtime,
        strategy: "sliding",
        window: 8,
        compress: false,
        systemPrompt: SYSTEM,
      });
      console.log(`\n# ${spec.model} (${spec.runtime})`);
      for (const turn of TURNS) {
        process.stdout.write(`  ${turn.id ?? "память"}… `);
        try {
          const { result, latencyMs, retries } = await askChat(agent, turn.text);
          if (!turn.id) {
            console.log(`${(latencyMs / 1000).toFixed(1)} с`);
            continue;
          }
          const row = report.questions.find((item) => item.id === turn.id);
          const run = score(turn, result, latencyMs, retries);
          row[spec.key][pass] = run;
          console.log(
            `ожидание ${run.expectHit ? "да" : "нет"}, статья ${run.sourceHit ? "да" : "нет"}, цитаты ${run.quotesOk ? "да" : "нет"}, ${(latencyMs / 1000).toFixed(1)} с`,
          );
          persist();
        } catch (err) {
          console.error(err?.message ?? err);
          if (/Локальная LLM недоступна/.test(String(err?.message ?? ""))) throw err;
          if (turn.id) {
            const row = report.questions.find((item) => item.id === turn.id);
            row[spec.key][pass] = {
              error: err?.message ?? String(err),
              latencyMs: null,
              expectHit: false,
              sourceHit: false,
              quotesOk: false,
              aligned: false,
              abstained: false,
              sourcesOk: false,
            };
            persist();
          }
        }
      }
      await pool.kill(spec.name);
    }
  }
} finally {
  db.close();
  await pool.killAll();
}

persist();
function line(label, stats) {
  const medianSec = stats.speed.medianMs == null ? "—" : (stats.speed.medianMs / 1000).toFixed(1);
  const maxSec = stats.speed.maxMs == null ? "—" : (stats.speed.maxMs / 1000).toFixed(1);
  console.log(
    `${label}: фраза ${stats.expect}/${stats.questions}, статья ${stats.article}/${stats.questions}, источники ${stats.sources}/${stats.questions}, цитаты ${stats.quotes}/${stats.questions}, смысл ${stats.aligned}/${stats.questions}`,
  );
  console.log(`  скорость: медиана ${medianSec} с, максимум ${maxSec} с`);
  console.log(`  стабильность: ${stats.stability.stable}/${stats.stability.questions}`);
}
console.log("");
line("qwen3.5-4b", report.summary.local);
line("composer-2.5", report.summary.cloud);
console.log(`Отчёт: ${outPath}`);
