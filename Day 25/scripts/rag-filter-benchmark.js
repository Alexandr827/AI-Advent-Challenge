import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/env.js";
import { indexLaw } from "../src/doc-index/pipeline.js";
import { retrieveLawContext } from "../src/doc-index/rag.js";
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

const lawPath = resolve(projectRoot, "data", "doc-index", "law.sqlite");
if (!existsSync(lawPath)) indexLaw(projectRoot);

const QUESTIONS = JSON.parse(readFileSync(resolve(projectRoot, "data", "rag-questions.json"), "utf8"));

const SYSTEM =
  "Отвечай по-русски и называй номер статьи. Не выдумывай норму: если точного правила не знаешь, так и скажи.";

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function askWithRetry(agent, text, options, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await agent.ask(text, options);
    } catch (err) {
      lastErr = err;
      console.error(`  retry ${i}/${attempts} ${agent.name}: ${err.message ?? err}`);
      await sleep(2000 * i);
    }
  }
  throw lastErr;
}

function expectHit(pattern, text) {
  return new RegExp(pattern, "i").test(String(text ?? ""));
}

function articleHit(article, sources) {
  return (sources ?? []).some((source) => String(source.section ?? "").startsWith(article));
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
  questions: [],
};

const outPath = resolve(projectRoot, "data", "rag-filter-benchmark.json");

function persist() {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
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
