import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

const outPath = resolve(projectRoot, "data", "rag-benchmark.json");

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
      withoutRag: null,
      withRag: null,
    };
    report.questions.push(row);
    console.log(`\n=== ${question.id} ===`);
    for (const mode of [
      { key: "withoutRag", name: "rag-off", rag: false },
      { key: "withRag", name: "rag-on", rag: true },
    ]) {
      if (pool.get(mode.name)) await pool.kill(mode.name);
      const [agent] = pool.spawn({
        name: mode.name,
        strategy: "sliding",
        window: 2,
        compress: false,
        systemPrompt: SYSTEM,
      });
      const result = await askWithRetry(agent, question.question, { rag: mode.rag, mcp: false });
      const sources = result.law?.sources ?? [];
      row[mode.key] = {
        reply: result.reply,
        sources,
        expectHit: expectHit(question.pattern, result.reply),
        sourceHit: articleHit(question.article, sources),
      };
      const articleNote = mode.rag ? `, статья ${row[mode.key].sourceHit ? "да" : "нет"}` : "";
      console.log(`${mode.name}: ожидание ${row[mode.key].expectHit ? "да" : "нет"}${articleNote}`);
      persist();
      await pool.kill(mode.name);
    }
  }
} finally {
  await pool.killAll();
}

const expectWithoutRag = report.questions.filter((item) => item.withoutRag?.expectHit).length;
const expectWithRag = report.questions.filter((item) => item.withRag?.expectHit).length;
const articleWithRag = report.questions.filter((item) => item.withRag?.sourceHit).length;
report.summary = {
  questions: report.questions.length,
  expectWithoutRag,
  expectWithRag,
  articleWithRag,
};
persist();
console.log(`\nОжидание без RAG: ${expectWithoutRag}/${report.questions.length}`);
console.log(`Ожидание с RAG: ${expectWithRag}/${report.questions.length}`);
console.log(`Статья в источниках: ${articleWithRag}/${report.questions.length}`);
