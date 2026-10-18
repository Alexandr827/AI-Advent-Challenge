import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  citationAligned,
  parseCitedAnswer,
  quotesAreGrounded,
  retrieveLawContext,
} from "../src/doc-index/rag.js";
import { AgentPool } from "../src/pool.js";
import {
  askWithRetry,
  ensureLawIndex,
  initBenchEnv,
  writeBenchJson,
} from "./lib/bench-runtime.js";

const { projectRoot, apiKey: API_KEY, model: MODEL, runtime: RUNTIME } =
  initBenchEnv(import.meta.url);

ensureLawIndex(projectRoot);

const QUESTIONS = JSON.parse(readFileSync(resolve(projectRoot, "data", "rag-questions.json"), "utf8"));

const SYSTEM =
  "Отвечай по-русски только по фрагментам закона. Нужны три блока: ответ, источники и дословные цитаты. Не выдумывай норму.";

function sourcesOk(sources, hits) {
  if (!sources?.length) return false;
  const ids = new Set((hits ?? []).map((hit) => hit.chunk_id));
  return sources.every(
    (source) => source.source && source.section && source.chunk_id && ids.has(source.chunk_id),
  );
}

const pool = new AgentPool({
  apiKey: API_KEY,
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
  questions: [],
};

const outPath = resolve(projectRoot, "data", "rag-cite-benchmark.json");

function persist() {
  writeBenchJson(outPath, report);
}

persist();

try {
  for (const question of QUESTIONS) {
    const row = {
      id: question.id,
      question: question.question,
      expect: question.expect,
      article: question.article,
      filtered: null,
    };
    report.questions.push(row);
    console.log(`\n=== ${question.id} ===`);
    const name = "rag-cite";
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
    const result = await askWithRetry(agent, question.question, {
      rag: true,
      ragMode: "filtered",
      mcp: false,
    });
    const sources = result.law?.sources ?? [];
    const quotes = result.law?.quotes ?? [];
    const answer = parseCitedAnswer(result.reply);
    row.filtered = {
      reply: result.reply,
      answer,
      abstained: Boolean(result.law?.abstained),
      sources,
      quotes,
      sourcesOk: sourcesOk(sources, retrieval.hits),
      quotesOk: quotesAreGrounded(quotes, retrieval.hits),
      aligned: citationAligned(answer, quotes, question.pattern),
      candidates: retrieval.candidates,
      dropped: retrieval.dropped,
    };
    console.log(
      `${name}: источники ${row.filtered.sourcesOk ? "да" : "нет"}, цитаты ${row.filtered.quotesOk ? "да" : "нет"}, смысл ${row.filtered.aligned ? "да" : "нет"}`,
    );
    persist();
    await pool.kill(name);
  }
} finally {
  await pool.killAll();
}

function count(field) {
  return report.questions.filter((item) => item.filtered?.[field]).length;
}

report.summary = {
  questions: report.questions.length,
  sources: count("sourcesOk"),
  quotes: count("quotesOk"),
  aligned: count("aligned"),
  abstained: report.questions.filter((item) => item.filtered?.abstained).length,
};
persist();
console.log(`\nИсточники: ${report.summary.sources}/${report.questions.length}`);
console.log(`Цитаты: ${report.summary.quotes}/${report.questions.length}`);
console.log(`Смысл совпал с цитатой: ${report.summary.aligned}/${report.questions.length}`);
console.log(`Не знаю: ${report.summary.abstained}/${report.questions.length}`);
