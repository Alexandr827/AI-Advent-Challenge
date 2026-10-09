import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LlmAgent } from "../src/agent.js";
import { estimateTokens } from "../src/tokens.js";
import { fitLawHits, formatLawBlock } from "../src/doc-index/rag.js";
import { completeChat, lmstudioMaxTokens, RAG_LMSTUDIO_MAX_TOKENS } from "../src/lmstudio.js";
import { summarizeLocalBenchmark } from "../scripts/lib/rag-local.js";

const CHUNK =
  "Рекламные материалы или их копии должны храниться в течение года со дня последнего распространения.";

function hit(id, text, score = 0.9) {
  return {
    source: "38-ФЗ",
    section: `Статья ${id}.`,
    chunk_id: `c${id}`,
    score,
    file: "docs/fz-38-o-reklame.md",
    text,
  };
}

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

describe("fitLawHits", () => {
  it("drops the weakest tail before shortening text", () => {
    const hits = [hit(1, "А".repeat(400), 0.9), hit(2, "Б".repeat(400), 0.5), hit(3, "В".repeat(400), 0.4)];
    const budget = estimateTokens(formatLawBlock(hits.slice(0, 2)));
    const fitted = fitLawHits(hits, { budgetTokens: budget });
    assert.equal(fitted.dropped, 1);
    assert.equal(fitted.shortened, false);
    assert.deepEqual(
      fitted.hits.map((item) => item.chunk_id),
      ["c1", "c2"],
    );
    assert.ok(estimateTokens(fitted.law) <= budget);
    assert.equal(hits[2].text.length, 400);
  });

  it("shortens the remaining chunk when it still overflows", () => {
    const original = "Д".repeat(2000);
    const hits = [hit(1, original)];
    const floor = estimateTokens(formatLawBlock([hit(1, "Д")]));
    const fitted = fitLawHits(hits, { budgetTokens: floor + 20 });
    assert.equal(fitted.dropped, 0);
    assert.equal(fitted.shortened, true);
    assert.ok(fitted.hits[0].text.length < original.length);
    assert.ok(estimateTokens(fitted.law) <= floor + 20);
    assert.equal(hits[0].text, original);
  });
});

describe("local RAG ask", () => {
  it("sends the law chunk to the local model and skips Cursor", async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({
        choices: [{ finish_reason: "stop", message: { content: `Ответ: в течение года. «${CHUNK}»` } }],
        usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
      });
    };
    const agent = new LlmAgent({
      id: "1",
      name: "local-rag",
      model: "qwen3.5-4b",
      runtime: "lmstudio",
      apiKey: "",
      cwd: tmpdir(),
      retrieveLaw: () => [hit("12", CHUNK)],
      chatComplete: (options) =>
        completeChat({
          ...options,
          baseUrl: "http://127.0.0.1:1234/v1",
          fetchImpl,
        }),
    });

    const plain = await agent.ask("Какая столица Франции?", { mcp: false });
    assert.equal(plain.reply, `Ответ: в течение года. «${CHUNK}»`);
    const plainBody = JSON.parse(calls[0].init.body);
    assert.equal(plainBody.enable_thinking, undefined);
    assert.equal(plainBody.max_tokens, lmstudioMaxTokens());

    const rag = await agent.ask("Сколько хранить рекламные материалы?", {
      rag: true,
      ragMode: "filtered",
      mcp: false,
    });
    const ragBody = JSON.parse(calls[1].init.body);
    assert.equal(calls[1].url, "http://127.0.0.1:1234/v1/chat/completions");
    assert.equal(ragBody.enable_thinking, false);
    assert.equal(ragBody.max_tokens, RAG_LMSTUDIO_MAX_TOKENS);
    assert.match(ragBody.messages[0].content, /в течение года/);
    assert.equal(rag.law.abstained, false);
    assert.equal(rag.law.sources[0].chunk_id, "c12");
    assert.equal(rag.finishReason, "stop");
    assert.equal(agent.sdkAgentId, null);

    calls.length = 0;
    const chat = await agent.chat("Сколько хранить рекламные материалы?");
    const chatBody = JSON.parse(calls[0].init.body);
    assert.equal(chatBody.enable_thinking, false);
    assert.equal(chatBody.max_tokens, RAG_LMSTUDIO_MAX_TOKENS);
    assert.match(chatBody.messages[0].content, /в течение года/);
    assert.equal(chat.abstained, false);
    assert.equal(agent.sdkAgentId, null);
  });
});

describe("local vs cloud summary", () => {
  it("scores quality, speed and stability from two passes", () => {
    const summary = summarizeLocalBenchmark(
      [
        {
          id: "storage",
          runs: [
            {
              expectHit: true,
              sourceHit: true,
              quotesOk: true,
              sourcesOk: true,
              aligned: true,
              abstained: false,
              latencyMs: 1000,
            },
            {
              expectHit: true,
              sourceHit: true,
              quotesOk: false,
              sourcesOk: true,
              aligned: false,
              abstained: false,
              latencyMs: 3000,
            },
          ],
        },
        {
          id: "offer",
          runs: [
            {
              expectHit: false,
              sourceHit: true,
              quotesOk: true,
              sourcesOk: true,
              aligned: false,
              abstained: false,
              latencyMs: 2000,
            },
            {
              expectHit: false,
              sourceHit: true,
              quotesOk: true,
              sourcesOk: true,
              aligned: false,
              abstained: false,
              latencyMs: 2000,
            },
          ],
        },
      ],
      {
        model: "composer-2.5",
        runtime: "local",
        questions: [
          { filtered: { sourcesOk: true, quotesOk: true, aligned: true, abstained: false } },
          { filtered: { sourcesOk: true, quotesOk: true, aligned: false, abstained: false } },
        ],
      },
    );
    assert.equal(summary.local.expect, 1);
    assert.equal(summary.local.article, 2);
    assert.equal(summary.local.quotes, 2);
    assert.equal(summary.local.aligned, 1);
    assert.equal(summary.cloud.model, "composer-2.5");
    assert.equal(summary.cloud.sources, 2);
    assert.equal(summary.cloud.aligned, 1);
    assert.equal(summary.stability.stable, 1);
    assert.equal(summary.stability.questions, 2);
    assert.equal(summary.speed.medianMs, 2000);
    assert.equal(summary.speed.maxMs, 3000);
    assert.equal(summary.speed.samples, 4);

    const localOnly = summarizeLocalBenchmark([
      { id: "a", runs: [{ expectHit: true, sourceHit: false, quotesOk: false, latencyMs: 10, abstained: true }] },
    ]);
    assert.equal(localOnly.cloud, null);
    assert.equal(localOnly.speed.samples, 0);
  });
});
