import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  citationAligned,
  parseCitedAnswer,
  quotesAreGrounded,
  retrieveLawContext,
} from "../src/doc-index/rag.js";
import { loadEnv } from "../src/env.js";
import { completeChat, DEFAULT_LMSTUDIO_MODEL } from "../src/lmstudio.js";
import { AgentPool } from "../src/pool.js";
import {
  articleHit,
  ensureLawIndex,
  expectHit,
  sleep,
  writeBenchJson,
} from "./lib/bench-runtime.js";
import { summarizeLocalBenchmark } from "./lib/rag-local.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(resolve(projectRoot, ".env"));

const MODEL = process.env.CURSOR_MODEL?.trim() || DEFAULT_LMSTUDIO_MODEL;
const RUNTIME = "lmstudio";
const PASSES = 2;
const lawPath = ensureLawIndex(projectRoot);

const QUESTIONS = JSON.parse(readFileSync(resolve(projectRoot, "data", "rag-questions.json"), "utf8"));
const cloudPath = resolve(projectRoot, "data", "rag-cite-benchmark.json");
const cloudReport = existsSync(cloudPath) ? JSON.parse(readFileSync(cloudPath, "utf8")) : null;

const SYSTEM =
  "Отвечай по-русски только по фрагментам закона. Нужны три блока: ответ, источники и дословные цитаты. Не выдумывай норму.";

function sourcesOk(sources, hits) {
  if (!sources?.length) return false;
  const ids = new Set((hits ?? []).map((hit) => hit.chunk_id));
  return sources.every(
    (source) => source.source && source.section && source.chunk_id && ids.has(source.chunk_id),
  );
}

try {
  await completeChat({
    model: MODEL,
    prompt: "Ответь одним словом: да",
    maxTokens: 64,
    enableThinking: false,
  });
} catch (err) {
  console.error(err?.message ?? err);
  process.exit(1);
}

const pool = new AgentPool({
  apiKey: "",
  defaultModel: MODEL,
  defaultRuntime: RUNTIME,
  cwd: projectRoot,
});

const report = {
  model: MODEL,
  runtime: RUNTIME,
  at: new Date().toISOString(),
  systemPrompt: SYSTEM,
  mode: "filtered",
  index: "data/doc-index/law.sqlite",
  passes: PASSES,
  cloud: cloudReport
    ? {
        model: cloudReport.model ?? null,
        runtime: cloudReport.runtime ?? null,
        at: cloudReport.at ?? null,
        file: "data/rag-cite-benchmark.json",
      }
    : null,
  questions: [],
};

const outPath = resolve(projectRoot, "data", "rag-local-benchmark.json");

function persist() {
  report.summary = summarizeLocalBenchmark(report.questions, cloudReport);
  writeBenchJson(outPath, report);
}

async function askLocal(agent, text) {
  let retries = 0;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const started = Date.now();
    try {
      const result = await agent.ask(text, { rag: true, ragMode: "filtered", mcp: false });
      return { result, latencyMs: Date.now() - started, retries };
    } catch (err) {
      lastErr = err;
      retries += 1;
      console.error(`  retry ${attempt}/3: ${err.message ?? err}`);
      if (/Локальная LLM недоступна/.test(String(err?.message ?? ""))) throw err;
      if (attempt === 3) break;
      await sleep(2000 * attempt);
    }
  }
  if (lastErr && typeof lastErr === "object") lastErr.retries = retries;
  throw lastErr;
}

persist();

try {
  for (let pass = 0; pass < PASSES; pass++) {
    console.log(`\n--- проход ${pass + 1}/${PASSES} ---`);
    for (const question of QUESTIONS) {
      let row = report.questions.find((item) => item.id === question.id);
      if (!row) {
        row = {
          id: question.id,
          question: question.question,
          expect: question.expect,
          article: question.article,
          runs: [],
        };
        report.questions.push(row);
      }
      console.log(`\n=== ${question.id} ===`);
      const name = "rag-local";
      if (pool.get(name)) await pool.kill(name);
      const [agent] = pool.spawn({
        name,
        strategy: "sliding",
        window: 2,
        compress: false,
        systemPrompt: SYSTEM,
      });
      const retrieval = retrieveLawContext(question.question, {
        indexPath: lawPath,
        mode: "filtered",
      });
      try {
        const { result, latencyMs, retries } = await askLocal(agent, question.question);
        const sources = result.law?.sources ?? [];
        const quotes = result.law?.quotes ?? [];
        const answer = parseCitedAnswer(result.reply);
        const run = {
          reply: result.reply,
          answer,
          abstained: Boolean(result.law?.abstained),
          sources,
          quotes,
          sourcesOk: sourcesOk(sources, retrieval.hits),
          quotesOk: quotesAreGrounded(quotes, retrieval.hits),
          aligned: citationAligned(answer, quotes, question.pattern),
          expectHit: expectHit(question.pattern, result.reply),
          sourceHit: articleHit(question.article, sources),
          latencyMs,
          finishReason: result.finishReason ?? null,
          retries,
          candidates: retrieval.candidates,
          dropped: retrieval.dropped,
          fit: result.law?.fit ?? { dropped: 0, shortened: false },
        };
        row.runs[pass] = run;
        console.log(
          `${name}: ожидание ${run.expectHit ? "да" : "нет"}, статья ${run.sourceHit ? "да" : "нет"}, цитаты ${run.quotesOk ? "да" : "нет"}, ${latencyMs} мс`,
        );
      } catch (err) {
        if (/Локальная LLM недоступна/.test(String(err?.message ?? ""))) throw err;
        row.runs[pass] = {
          error: err?.message ?? String(err),
          retries: err?.retries ?? 3,
          latencyMs: null,
          abstained: false,
          sourcesOk: false,
          quotesOk: false,
          aligned: false,
          expectHit: false,
          sourceHit: false,
          finishReason: null,
          fit: { dropped: 0, shortened: false },
        };
        console.error(`${name}: ${row.runs[pass].error}`);
      }
      persist();
      await pool.kill(name);
    }
  }
} finally {
  await pool.killAll();
}

persist();
const { local, cloud, speed, stability } = report.summary;
console.log(`\nЛокально, проход 1: ожидание ${local.expect}/${local.questions}, статья ${local.article}/${local.questions}, источники ${local.sources}/${local.questions}, цитаты ${local.quotes}/${local.questions}, смысл ${local.aligned}/${local.questions}, не знаю ${local.abstained}/${local.questions}`);
if (cloud) {
  console.log(
    `Облако ${cloud.model}: источники ${cloud.sources}/${cloud.questions}, цитаты ${cloud.quotes}/${cloud.questions}, смысл ${cloud.aligned}/${cloud.questions}, не знаю ${cloud.abstained}/${cloud.questions}`,
  );
} else {
  console.log("Облачный эталон не найден: data/rag-cite-benchmark.json");
}
const medianSec = speed.medianMs == null ? "—" : (speed.medianMs / 1000).toFixed(1);
const maxSec = speed.maxMs == null ? "—" : (speed.maxMs / 1000).toFixed(1);
console.log(`Скорость: медиана ${medianSec} с, максимум ${maxSec} с (${speed.samples} ответов модели)`);
console.log(`Стабильность: ${stability.stable}/${stability.questions} вопросов с теми же флагами на двух проходах`);
console.log(`Отчёт: ${outPath}`);
