import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { retrieveLawContext } from "../src/doc-index/rag.js";
import { AgentPool } from "../src/pool.js";
import {
  askWithRetry,
  articleHit,
  ensureLawIndex,
  expectHit,
  initBenchEnv,
  writeBenchJson,
} from "./lib/bench-runtime.js";

const { projectRoot, apiKey: API_KEY, model: MODEL, runtime: RUNTIME } =
  initBenchEnv(import.meta.url);

ensureLawIndex(projectRoot);

const QUESTIONS = JSON.parse(readFileSync(resolve(projectRoot, "data", "rag-questions.json"), "utf8"));

const SYSTEM =
  "Отвечай по-русски и называй номер статьи. Не выдумывай норму: если точного правила не знаешь, так и скажи.";

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
  questions: [],
};

const outPath = resolve(projectRoot, "data", "rag-filter-benchmark.json");

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
      plain: null,
      filtered: null,
    };
    report.questions.push(row);
    console.log(`\n=== ${question.id} ===`);
    for (const mode of [
      { key: "plain", name: "rag-plain", ragMode: "plain" },
      { key: "filtered", name: "rag-filtered", ragMode: "filtered" },
    ]) {
      if (pool.get(mode.name)) await pool.kill(mode.name);
      const [agent] = pool.spawn({
        name: mode.name,
        strategy: "sliding",
        window: 2,
        compress: false,
        systemPrompt: SYSTEM,
      });
      const retrieval = retrieveLawContext(question.question, {
        indexPath: lawPath,
        mode: mode.ragMode,
      });
      const result = await askWithRetry(agent, question.question, {
        rag: true,
        ragMode: mode.ragMode,
        mcp: false,
      });
      const sources = result.law?.sources ?? [];
      row[mode.key] = {
        reply: result.reply,
        sources,
        expectHit: expectHit(question.pattern, result.reply),
        sourceHit: articleHit(question.article, sources),
        candidates: retrieval.candidates,
        dropped: retrieval.dropped,
        searchQuery: retrieval.searchQuery,
      };
      console.log(
        `${mode.name}: ожидание ${row[mode.key].expectHit ? "да" : "нет"}, статья ${row[mode.key].sourceHit ? "да" : "нет"}, отсеяно ${row[mode.key].dropped}/${row[mode.key].candidates}`,
      );
      persist();
      await pool.kill(mode.name);
    }
  }
} finally {
  await pool.killAll();
}

function count(key, field) {
  return report.questions.filter((item) => item[key]?.[field]).length;
}

report.summary = {
  questions: report.questions.length,
  expectPlain: count("plain", "expectHit"),
  expectFiltered: count("filtered", "expectHit"),
  articlePlain: count("plain", "sourceHit"),
  articleFiltered: count("filtered", "sourceHit"),
};
persist();
console.log(`\nОжидание без фильтра: ${report.summary.expectPlain}/${report.questions.length}`);
console.log(`Ожидание с фильтром: ${report.summary.expectFiltered}/${report.questions.length}`);
console.log(`Статья без фильтра: ${report.summary.articlePlain}/${report.questions.length}`);
console.log(`Статья с фильтром: ${report.summary.articleFiltered}/${report.questions.length}`);
