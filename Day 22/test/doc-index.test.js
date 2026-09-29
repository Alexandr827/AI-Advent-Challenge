import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "@cursor/sdk";
import { LlmAgent } from "../src/agent.js";
import { parseCommand } from "../src/cli.js";
import { chunkFixed, chunkStructural } from "../src/doc-index/chunk.js";
import { LAW_FILE, LAW_SOURCE, LAW_TITLE, loadDocument } from "../src/doc-index/corpus.js";
import { EMBED_DIM, embed, cosine } from "../src/doc-index/embed.js";
import { indexChunks, indexCorpus } from "../src/doc-index/pipeline.js";
import {
  LAW_SCORE_THRESHOLD,
  answerWithRag,
  attachLawContext,
  formatLawBlock,
  selectLawHits,
} from "../src/doc-index/rag.js";
import { searchChunks, writeIndex, openIndex } from "../src/doc-index/store.js";
import { buildPrompt } from "../src/profile/builder.js";

const ARTICLE_12 = `Статья 12. Сроки хранения рекламных материалов

Рекламные материалы или их копии, в том числе все вносимые в них изменения, а также договоры на производство, размещение и распространение рекламы должны храниться в течение года со дня последнего распространения рекламы или со дня окончания сроков действия таких договоров, кроме документов, в отношении которых законодательством Российской Федерации установлено иное.`;

const ARTICLE_11 = `Статья 11. Срок действия рекламы, признаваемой офертой

Если в соответствии с Гражданским кодексом Российской Федерации реклама признается офертой, такая оферта действует в течение двух месяцев со дня распространения рекламы при условии, что в ней не указан иной срок.`;

const FIXTURE = {
  source: LAW_SOURCE,
  title: LAW_TITLE,
  file: LAW_FILE,
  text: `${ARTICLE_12}\n\n${ARTICLE_11}\n\nСтатья 29.1. Реклама цифровых финансовых активов\n\nРеклама выпускаемых цифровых финансовых активов должна содержать наименование лица.`,
};

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const tmpDirs = [];

after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "doc-index-"));
  tmpDirs.push(dir);
  return dir;
}

describe("chunking", () => {
  it("режет закон по статьям и сохраняет метаданные", () => {
    const chunks = chunkStructural(FIXTURE);
    const sections = chunks.map((chunk) => chunk.section);
    assert.ok(sections.some((section) => section.startsWith("Статья 12.")));
    assert.ok(sections.some((section) => section.startsWith("Статья 11.")));
    assert.ok(sections.some((section) => section.startsWith("Статья 29.1.")));
    const article12 = chunks.find((chunk) => chunk.section.startsWith("Статья 12."));
    assert.equal(article12.source, LAW_SOURCE);
    assert.equal(article12.title, LAW_TITLE);
    assert.equal(article12.file, LAW_FILE);
    assert.equal(article12.strategy, "structural");
    assert.match(article12.chunk_id, /^structural:docs\/fz-38-o-reklame\.md:\d+$/);
    assert.equal(article12.boundary, true);
    assert.match(article12.text, /в течение года/);
  });

  it("длинную статью дорезает, оставляя имя секции, и склеивает короткий хвост", () => {
    const body = "1. Первая часть статьи о рекламе товаров. ".repeat(80);
    const doc = {
      ...FIXTURE,
      text: `Статья 5. Общие требования к рекламе\n\n${body}\n2. Хвост.`,
    };
    const chunks = chunkStructural(doc);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((chunk) => chunk.section.startsWith("Статья 5.")));
    assert.equal(chunks[0].boundary, true);
    assert.ok(chunks.slice(1).some((chunk) => chunk.boundary === false));
    assert.match(chunks[chunks.length - 1].text, /Хвост/);
  });

  it("фиксированное окно перекрывается и берёт секцию статьи", () => {
    const sentence = "Рекламные материалы хранятся в течение года. ";
    const doc = {
      ...FIXTURE,
      text: `Статья 12. Сроки хранения рекламных материалов\n\n${sentence.repeat(80)}`,
    };
    const chunks = chunkFixed(doc);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((chunk) => chunk.section.startsWith("Статья 12.")));
    assert.equal(chunks[0].boundary, true);
    const overlap = chunks[0].text.slice(-180);
    assert.ok(chunks[1].text.includes(overlap.trim().slice(0, 40)));
  });
});

describe("index", () => {
  it("поднимает статью 12 и не подмешивает вопрос без общих слов", () => {
    const dir = tempDir();
    const dbPath = join(dir, "law.sqlite");
    const chunks = indexChunks(FIXTURE);
    writeIndex(dbPath, chunks);
    const query = "сколько хранить рекламные материалы";
    const related = attachLawContext(query, { indexPath: dbPath });
    assert.ok(related.length >= 1);
    assert.match(related[0].section, /^Статья 12\./);
    assert.ok(related[0].score >= LAW_SCORE_THRESHOLD);
    const block = formatLawBlock(related);
    const prompt = buildPrompt({ query, law: block });
    assert.match(prompt, new RegExp(related[0].chunk_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(prompt, /в течение года/);
    assert.match(prompt, /сколько хранить рекламные материалы/);

    const unrelated = attachLawContext("какая погода в Москве завтра", { indexPath: dbPath });
    assert.deepEqual(unrelated, []);
    const plain = buildPrompt({ query: "какая погода в Москве завтра", law: formatLawBlock(unrelated) });
    assert.equal(plain.includes("Фрагменты Федерального закона"), false);
    const noisy = selectLawHits(
      [
        {
          score: 0.9,
          text: "Статья 14. Реклама в телепрограммах и телепередачах. Прерывание телепрограммы рекламой.",
          section: "Статья 14. Реклама в телепрограммах и телепередачах",
          chunk_id: "structural:docs/fz-38-o-reklame.md:14",
        },
      ],
      LAW_SCORE_THRESHOLD,
      "какая погода в Москве завтра",
    );
    assert.deepEqual(noisy, []);
  });

  it("читает вектор из sqlite тем же эмбеддером", () => {
    const dir = tempDir();
    const dbPath = join(dir, "law.sqlite");
    writeIndex(dbPath, indexChunks(FIXTURE));
    const db = openIndex(dbPath, { readOnly: true });
    try {
      const hits = searchChunks(db, embed("срок хранения рекламных материалов"), {
        strategy: "structural",
        k: 2,
      });
      assert.match(hits[0].section, /^Статья 12\./);
      assert.ok(hits[0].score > cosine(embed("срок хранения рекламных материалов"), embed(ARTICLE_11)));
    } finally {
      db.close();
    }
  });
});

function agentFixture(overrides = {}) {
  return new LlmAgent({
    id: "1",
    name: "tester",
    model: "composer-2.5",
    runtime: "local",
    apiKey: "test-key",
    cwd: process.cwd(),
    compress: false,
    ...overrides,
  });
}

function installFakeSdk(prompts) {
  const original = Agent.create;
  Agent.create = async () => ({
    agentId: "fake",
    async send(prompt) {
      prompts.push(prompt);
      return {
        id: "run-1",
        async wait() {
          return { id: "run-1", status: "finished", result: "В течение года." };
        },
      };
    },
  });
  return () => {
    Agent.create = original;
  };
}

describe("ask", { concurrency: 1 }, () => {
  it("не ищет закон, если запрос уходит в оркестрацию MCP", async () => {
    let calls = 0;
    const agent = agentFixture({
      retrieveLaw() {
        calls += 1;
        return [];
      },
    });
    await assert.rejects(() => agent.ask("какая погода", { mcp: true, rag: true }), /город/);
    assert.equal(calls, 0);
  });

  it("разбирает --rag и --no-rag", () => {
    assert.equal(parseCommand("ask law --rag сколько хранить материалы").rag, true);
    assert.equal(parseCommand("ask law --no-rag сколько хранить материалы").rag, false);
    assert.equal(parseCommand("ask law сколько хранить материалы").rag, undefined);
    assert.equal(parseCommand("ask law --mcp --rag сколько хранить").mcp, true);
    assert.throws(() => parseCommand("ask law --rag --no-rag текст"), /--rag/);
  });

  it("без rag не ищет закон и не кладёт фрагменты в промпт", async () => {
    const prompts = [];
    const restore = installFakeSdk(prompts);
    let calls = 0;
    try {
      const agent = agentFixture({
        retrieveLaw() {
          calls += 1;
          return [];
        },
      });
      const result = await agent.ask("сколько хранить рекламные материалы");
      assert.equal(calls, 0);
      assert.equal(result.law, null);
      assert.equal(prompts.length, 1);
      assert.equal(prompts[0].includes("Фрагменты Федерального закона"), false);
      assert.match(prompts[0], /сколько хранить рекламные материалы/);
    } finally {
      restore();
    }
  });

  it("с rag ищет чанки и склеивает их с вопросом", async () => {
    const prompts = [];
    const restore = installFakeSdk(prompts);
    const hit = {
      chunk_id: "structural:docs/fz-38-o-reklame.md:12",
      section: "Статья 12. Сроки хранения рекламных материалов",
      text: ARTICLE_12,
      score: 0.46,
      file: "docs/fz-38-o-reklame.md",
    };
    let calls = 0;
    try {
      const agent = agentFixture({
        retrieveLaw() {
          calls += 1;
          return [hit];
        },
      });
      const result = await agent.ask("сколько хранить рекламные материалы", { rag: true });
      assert.equal(calls, 1);
      assert.equal(result.law.sources[0].chunk_id, hit.chunk_id);
      assert.match(prompts[0], /в течение года/);
      assert.match(prompts[0], /сколько хранить рекламные материалы/);
      assert.match(prompts[0], /Статья 12/);
    } finally {
      restore();
    }
  });
});

describe("answerWithRag", () => {
  it("передаёт фрагменты и вопрос в generate и возвращает источники", async () => {
    const hits = [
      {
        chunk_id: "structural:docs/fz-38-o-reklame.md:12",
        section: "Статья 12. Сроки хранения рекламных материалов",
        text: ARTICLE_12,
        score: 0.46,
        file: "docs/fz-38-o-reklame.md",
      },
    ];
    let seen = "";
    const result = await answerWithRag("сколько хранить рекламные материалы", {
      retrieve: () => hits,
      generate: async ({ query, law }) => {
        seen = buildPrompt({ query, law });
        return "в течение года";
      },
    });
    assert.match(seen, /в течение года/);
    assert.match(seen, /сколько хранить рекламные материалы/);
    assert.equal(result.reply, "в течение года");
    assert.equal(result.sources[0].section.startsWith("Статья 12."), true);
    await assert.rejects(() => answerWithRag("вопрос", {}), /generate/);
  });

  it("держит десять контрольных вопросов с ожиданием и статьёй", () => {
    const questions = JSON.parse(readFileSync(join(projectRoot, "data/rag-questions.json"), "utf8"));
    assert.equal(questions.length, 10);
    for (const item of questions) {
      assert.match(item.article, /^Статья /);
      assert.ok(item.question.trim());
      assert.ok(item.expect.trim());
      new RegExp(item.pattern, "i");
    }
  });
});

describe("corpus", () => {
  it("режет markdown по заголовкам и сохраняет метаданные", () => {
    const doc = {
      source: "notes/article.md",
      title: "Заметка",
      file: "notes/article.md",
      kind: "md",
      text: "# Введение\n\nАбзац про загрузку документов.\n\n## Детали\n\nРаздел с подробностями.\n",
    };
    const chunks = chunkStructural(doc);
    const intro = chunks.find((chunk) => chunk.section === "Введение");
    const details = chunks.find((chunk) => chunk.section === "Детали");
    assert.ok(intro);
    assert.ok(details);
    assert.equal(intro.boundary, true);
    assert.equal(intro.source, "notes/article.md");
    assert.equal(intro.title, "Заметка");
    assert.equal(intro.file, "notes/article.md");
    assert.equal(intro.strategy, "structural");
    assert.match(intro.chunk_id, /^structural:notes\/article\.md:\d+$/);
    assert.match(intro.text, /^# Введение/);
    const fixed = chunkFixed(doc);
    assert.equal(fixed[0].section, "Введение");
  });

  it("режет код по функциям, секция — имя функции", () => {
    const doc = {
      source: "src/example.js",
      title: "example.js",
      file: "src/example.js",
      kind: "code",
      text: "const answer = 1;\n\nexport function loadDocument(filePath) {\n  return filePath;\n}\n\nfunction chunkFixed(doc) {\n  return doc;\n}\n",
    };
    const chunks = chunkStructural(doc);
    assert.ok(chunks.some((chunk) => chunk.section === "src/example.js"));
    const load = chunks.find((chunk) => chunk.section === "loadDocument");
    const fixed = chunks.find((chunk) => chunk.section === "chunkFixed");
    assert.ok(load);
    assert.ok(fixed);
    assert.equal(load.boundary, true);
    assert.equal(load.strategy, "structural");
    assert.equal(load.source, "src/example.js");
    assert.equal(load.file, "src/example.js");
    assert.match(load.chunk_id, /^structural:src\/example\.js:\d+$/);
    assert.match(load.text, /export function loadDocument/);
  });

  it("достаёт текст из pdf и режет по страницам", async () => {
    const doc = await loadDocument(join(projectRoot, "docs/sample.pdf"), { root: projectRoot });
    assert.equal(doc.kind, "pdf");
    assert.equal(doc.file, "docs/sample.pdf");
    assert.match(doc.text, /Document indexing sample/);
    assert.match(doc.text, /Second page of the indexing sample/);
    assert.match(doc.text, /^page 1/m);
    assert.match(doc.text, /^page 2/m);
    const chunks = chunkStructural(doc);
    assert.ok(chunks.some((chunk) => chunk.section === "page 1" && chunk.boundary));
    assert.ok(chunks.some((chunk) => chunk.section === "page 2" && chunk.boundary));
  });

  it("пишет sqlite и json с эмбеддингом и метаданными и сравнивает стратегии", async () => {
    const root = tempDir();
    writeFileSync(
      join(root, "note.md"),
      "# Введение\n\nТекст раздела про индексацию документов и чанки.\n\n## Детали\n\nВторой раздел с подробностями о метаданных чанка.\n",
    );
    const result = await indexCorpus(root, ["note.md"], { source: "article" });
    assert.ok(result.report.strategies.fixed.count > 0);
    assert.ok(result.report.strategies.structural.count > 0);
    const saved = JSON.parse(readFileSync(result.jsonPath, "utf8"));
    assert.equal(saved.dim, EMBED_DIM);
    const chunk = saved.chunks.find((item) => item.strategy === "structural" && item.section === "Введение");
    assert.ok(chunk);
    assert.equal(chunk.source, "article");
    assert.equal(chunk.file, "note.md");
    assert.equal(chunk.title, "Введение");
    assert.match(chunk.chunk_id, /^structural:note\.md:\d+$/);
    assert.equal(chunk.embedding.length, EMBED_DIM);
    assert.ok(saved.chunks.some((item) => item.strategy === "fixed"));
    const comparison = readFileSync(result.comparisonPath, "utf8");
    assert.match(comparison, /\| fixed \|/);
    assert.match(comparison, /\| structural \|/);
    const db = openIndex(result.dbPath, { readOnly: true });
    try {
      const hits = searchChunks(db, embed("индексацию документов"), { strategy: "structural", k: 2 });
      assert.equal(hits[0].source, "article");
      assert.match(hits[0].section, /Введение/);
    } finally {
      db.close();
    }

    writeFileSync(
      join(root, "code.js"),
      "export function alpha() {\n  return 1;\n}\n\nfunction beta() {\n  return 2;\n}\n",
    );
    const again = await indexCorpus(root, ["code.js"]);
    const manifest = JSON.parse(readFileSync(again.manifestPath, "utf8"));
    assert.deepEqual(
      manifest.files.map((item) => item.path),
      ["note.md", "code.js"],
    );
    assert.equal(manifest.files[0].source, "article");
    assert.equal(manifest.files[0].strategy, "both");
    assert.equal(again.docs.length, 2);
  });

  it("грузит файлы разными стратегиями чанкинга", async () => {
    const root = tempDir();
    writeFileSync(join(root, "note.md"), "# Введение\n\nТекст про фиксированное окно индекса.\n");
    writeFileSync(join(root, "code.js"), "export function alpha() {\n  return 1;\n}\n");
    const fixedOnly = await indexCorpus(root, ["note.md"], { strategy: "fixed" });
    assert.ok(fixedOnly.report.strategies.fixed.count > 0);
    assert.equal(fixedOnly.report.strategies.structural.count, 0);
    assert.equal(fixedOnly.docs[0].strategy, "fixed");
    const mixed = await indexCorpus(root, ["code.js"], { strategy: "structural" });
    const saved = JSON.parse(readFileSync(mixed.jsonPath, "utf8"));
    assert.ok(saved.chunks.some((chunk) => chunk.file === "note.md" && chunk.strategy === "fixed"));
    assert.equal(saved.chunks.some((chunk) => chunk.file === "note.md" && chunk.strategy === "structural"), false);
    assert.ok(saved.chunks.some((chunk) => chunk.file === "code.js" && chunk.strategy === "structural"));
    assert.equal(saved.chunks.some((chunk) => chunk.file === "code.js" && chunk.strategy === "fixed"), false);
    const manifest = JSON.parse(readFileSync(mixed.manifestPath, "utf8"));
    assert.equal(manifest.files[0].strategy, "fixed");
    assert.equal(manifest.files[1].strategy, "structural");
    await assert.rejects(() => indexCorpus(root, ["note.md"], { strategy: "sliding" }), /fixed, structural или both/);
  });

  it("разбирает index load", () => {
    assert.deepEqual(parseCommand('index load README.md --source readme --title "Обзор"'), {
      type: "index-load",
      paths: ["README.md"],
      source: "readme",
      title: "Обзор",
      strategy: undefined,
    });
    assert.deepEqual(parseCommand("index load docs/sample.pdf --strategy structural"), {
      type: "index-load",
      paths: ["docs/sample.pdf"],
      source: undefined,
      title: undefined,
      strategy: "structural",
    });
    assert.throws(() => parseCommand("index load"), /index load/);
    assert.throws(() => parseCommand("index load README.md --strategy sliding"), /fixed, structural или both/);
  });
});
