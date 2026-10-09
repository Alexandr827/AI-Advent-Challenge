import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  citationAligned,
  parseCitedAnswer,
  quotesAreGrounded,
} from "../src/doc-index/rag.js";
import { openIndex } from "../src/doc-index/store.js";
import { loadEnv } from "../src/env.js";
import {
  completeChat,
  DEFAULT_LMSTUDIO_MODEL,
  FZ38_CONTEXT_WINDOW,
  inspectLoadedModel,
  parseLmsPs,
} from "../src/lmstudio.js";
import { AgentPool } from "../src/pool.js";
import { articleHit, ensureLawIndex, expectHit, sleep, writeBenchJson } from "./lib/bench-runtime.js";
import { median } from "./lib/rag-local.js";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(resolve(projectRoot, ".env"));

const MODEL = DEFAULT_LMSTUDIO_MODEL;
const PASSES = 2;
const lawPath = ensureLawIndex(projectRoot);

const QUESTIONS = [
  {
    id: "storage",
    text: "Сколько хранить рекламные материалы или их копии?",
    article: "Статья 12.",
    pattern: "одного года|в течение года|1 год",
  },
  {
    id: "offer",
    text: "Сколько действует реклама-оферта, если свой срок не указан?",
    article: "Статья 11.",
    pattern: "двух месяц|два месяц|2 месяц",
  },
  {
    id: "definition",
    text: "Как в основных понятиях определены реклама и объект рекламирования?",
    article: "Статья 3.",
    pattern: "неопредел[её]нн[а-яё]*\\s+круг",
  },
];

const ARMS = [
  {
    key: "baseline",
    name: "day29-plain",
    lawProfile: "baseline",
    temperature: 0.2,
    maxTokens: 1024,
    contextWindow: FZ38_CONTEXT_WINDOW,
  },
  {
    key: "fz38",
    name: "day29-law",
    lawProfile: "fz38",
    temperature: 0,
    maxTokens: 512,
    contextWindow: FZ38_CONTEXT_WINDOW,
  },
];

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

async function readResources() {
  const resources = {
    quantizationConfigurable: false,
    expectedContext: FZ38_CONTEXT_WINDOW,
    api: null,
    lmsPs: null,
  };
  try {
    resources.api = await inspectLoadedModel({ model: MODEL });
  } catch (err) {
    resources.apiError = err?.message ?? String(err);
  }
  const lmsBin = join(homedir(), ".lmstudio", "bin", "lms");
  if (!existsSync(lmsBin)) return resources;
  try {
    const { stdout } = await execFileAsync(lmsBin, ["ps"], { timeout: 8000 });
    const rows = parseLmsPs(stdout);
    resources.lmsPs = rows.find((row) => row.identifier === MODEL || row.model === MODEL) ?? rows[0] ?? null;
  } catch (err) {
    resources.lmsPsError = err?.message ?? String(err);
  }
  return resources;
}

const pool = new AgentPool({
  apiKey: "",
  defaultModel: MODEL,
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
  model: MODEL,
  passes: PASSES,
  questions: QUESTIONS.map((question) => ({
    id: question.id,
    question: question.text,
    article: question.article,
    baseline: [],
    fz38: [],
  })),
  resources: await readResources(),
};
const outPath = resolve(projectRoot, "data", "rag-day29-three.json");

function sideStats(key) {
  const runs = [];
  for (const question of report.questions) {
    for (const run of question[key] ?? []) {
      if (!run || run.error || run.abstained) continue;
      if (Number.isFinite(run.latencyMs)) runs.push(run);
    }
  }
  const first = report.questions.map((question) => question[key]?.[0]).filter(Boolean);
  const latencies = runs.map((run) => run.latencyMs);
  const completion = runs.map((run) => run.usage?.completionTokens).filter((n) => Number.isFinite(n));
  const prompt = runs.map((run) => run.usage?.promptTokens).filter((n) => Number.isFinite(n));
  const speed = runs
    .map((run) =>
      Number.isFinite(run.usage?.completionTokens) && run.latencyMs > 0
        ? (run.usage.completionTokens / run.latencyMs) * 1000
        : null,
    )
    .filter((n) => Number.isFinite(n));
  return {
    questions: report.questions.length,
    expect: first.filter((run) => run.expectHit).length,
    article: first.filter((run) => run.sourceHit).length,
    sources: first.filter((run) => run.sourcesOk).length,
    quotes: first.filter((run) => run.quotesOk).length,
    aligned: first.filter((run) => run.aligned).length,
    speed: {
      medianMs: median(latencies),
      maxMs: latencies.length ? Math.max(...latencies) : null,
      medianTokensPerSec: median(speed),
    },
    tokens: {
      medianPrompt: median(prompt),
      medianCompletion: median(completion),
    },
  };
}

function persist() {
  report.summary = { baseline: sideStats("baseline"), fz38: sideStats("fz38") };
  writeBenchJson(outPath, report);
}

function score(question, result, latencyMs) {
  const sources = result.law?.sources ?? [];
  const quotes = result.law?.quotes ?? [];
  const answer = parseCitedAnswer(result.reply);
  const hits = hitsFor(quotes.length ? quotes : sources);
  const last = result.tokens?.last ?? {};
  return {
    reply: result.reply,
    answer,
    sources,
    quotes,
    sourcesOk: sources.length > 0 && sources.every((source) => source.source && source.section && source.chunk_id),
    quotesOk: quotesAreGrounded(quotes, hits),
    aligned: citationAligned(answer, quotes, question.pattern),
    expectHit: expectHit(question.pattern, result.reply),
    sourceHit: articleHit(question.article, sources),
    latencyMs,
    finishReason: result.finishReason ?? null,
    retried: Boolean(result.retried),
    usage: {
      promptTokens: Number.isFinite(last.requestBilled) ? last.requestBilled : null,
      completionTokens: Number.isFinite(last.responseBilled) ? last.responseBilled : null,
      reasoningTokens: Number.isFinite(last.reasoningTokens) ? last.reasoningTokens : null,
    },
  };
}

persist();

try {
  for (let pass = 0; pass < PASSES; pass++) {
    console.log(`\n--- проход ${pass + 1}/${PASSES} ---`);
    for (const spec of ARMS) {
      if (pool.get(spec.name)) await pool.kill(spec.name);
      const [agent] = pool.spawn({
        name: spec.name,
        model: MODEL,
        runtime: "lmstudio",
        compress: false,
        lawProfile: spec.lawProfile,
        contextLimit: spec.contextWindow,
      });
      console.log(`\n# ${spec.lawProfile}`);
      for (const question of QUESTIONS) {
        process.stdout.write(`  ${question.id}… `);
        const started = Date.now();
        try {
          const result = await agent.ask(question.text, {
            mcp: false,
            rag: true,
            ragMode: "filtered",
            temperature: spec.temperature,
            maxTokens: spec.maxTokens,
            contextWindow: spec.contextWindow,
          });
          const latencyMs = Date.now() - started;
          const run = score(question, result, latencyMs);
          report.questions.find((item) => item.id === question.id)[spec.key][pass] = run;
          console.log(
            `фраза ${run.expectHit ? "да" : "нет"}, статья ${run.sourceHit ? "да" : "нет"}, смысл ${run.aligned ? "да" : "нет"}, ${(latencyMs / 1000).toFixed(1)} с`,
          );
        } catch (err) {
          console.error(err?.message ?? err);
          if (/Локальная LLM недоступна/.test(String(err?.message ?? ""))) throw err;
          report.questions.find((item) => item.id === question.id)[spec.key][pass] = {
            error: err?.message ?? String(err),
            expectHit: false,
            sourceHit: false,
            quotesOk: false,
            aligned: false,
            sourcesOk: false,
            latencyMs: null,
          };
          await sleep(1000);
        }
        persist();
      }
      await pool.kill(spec.name);
    }
  }
} finally {
  db.close();
  await pool.killAll();
}

persist();
console.log("");
console.log(JSON.stringify(report.summary, null, 2));
console.log(`Отчёт: ${outPath}`);
