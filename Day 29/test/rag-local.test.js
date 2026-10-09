import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LlmAgent } from "../src/agent.js";
import { estimateTokens } from "../src/tokens.js";
import { fitLawHits, formatLawBlock } from "../src/doc-index/rag.js";
import {
  completeChat,
  FZ38_MAX_TOKENS,
  FZ38_MAX_TOKENS_RETRY,
  lmstudioMaxTokens,
  RAG_LMSTUDIO_MAX_TOKENS,
} from "../src/lmstudio.js";
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
      lawProfile: "fz38",
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
    assert.equal(plainBody.temperature, 0.2);
    assert.equal(plainBody.max_tokens, lmstudioMaxTokens());
    assert.equal(plainBody.quantization, undefined);
    assert.equal(plainBody.messages[0].role, "user");

    const rag = await agent.ask("Сколько хранить рекламные материалы?", {
      rag: true,
      ragMode: "filtered",
      mcp: false,
    });
    const ragBody = JSON.parse(calls[1].init.body);
    assert.equal(calls[1].url, "http://127.0.0.1:1234/v1/chat/completions");
    assert.equal(ragBody.enable_thinking, false);
    assert.equal(ragBody.temperature, 0);
    assert.equal(ragBody.max_tokens, FZ38_MAX_TOKENS);
    assert.equal(ragBody.quantization, undefined);
    assert.equal(ragBody.messages[0].role, "system");
    assert.match(ragBody.messages[0].content, /один год/);
    assert.equal(ragBody.messages[1].role, "user");
    assert.match(ragBody.messages[1].content, /в течение года/);
    assert.equal(rag.law.abstained, false);
    assert.equal(rag.law.sources[0].chunk_id, "c12");
    assert.equal(rag.finishReason, "stop");
    assert.equal(agent.sdkAgentId, null);

    calls.length = 0;
    const chat = await agent.chat("Сколько хранить рекламные материалы?");
    const chatBody = JSON.parse(calls[0].init.body);
    assert.equal(chatBody.enable_thinking, false);
    assert.equal(chatBody.temperature, 0);
    assert.equal(chatBody.max_tokens, FZ38_MAX_TOKENS);
    assert.equal(chatBody.messages[0].role, "system");
    assert.match(chatBody.messages[1].content, /в течение года/);
    assert.equal(chat.abstained, false);
    assert.equal(agent.sdkAgentId, null);
  });

  it("keeps the day-28 budget when the law profile is baseline", async () => {
    const calls = [];
    const agent = new LlmAgent({
      id: "2",
      name: "baseline-rag",
      model: "qwen3.5-4b",
      runtime: "lmstudio",
      lawProfile: "baseline",
      apiKey: "",
      cwd: tmpdir(),
      retrieveLaw: () => [hit("12", CHUNK)],
      chatComplete: (options) =>
        completeChat({
          ...options,
          baseUrl: "http://127.0.0.1:1234/v1",
          fetchImpl: async (url, init) => {
            calls.push({ url, init });
            return jsonResponse({
              choices: [{ finish_reason: "stop", message: { content: `Ответ: в течение года. «${CHUNK}»` } }],
              usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 },
            });
          },
        }),
    });
    await agent.ask("Сколько хранить рекламные материалы?", { rag: true, ragMode: "filtered", mcp: false });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.temperature, 0.2);
    assert.equal(body.max_tokens, RAG_LMSTUDIO_MAX_TOKENS);
    assert.equal(body.quantization, undefined);
    assert.equal(body.messages.some((item) => item.role === "system"), false);
    assert.match(body.messages[0].content, /в течение года/);
  });

  it("retries a truncated 38-FZ answer with the larger token cap", async () => {
    const caps = [];
    const agent = new LlmAgent({
      id: "3",
      name: "retry-rag",
      model: "qwen3.5-4b",
      runtime: "lmstudio",
      lawProfile: "fz38",
      apiKey: "",
      cwd: tmpdir(),
      retrieveLaw: () => [hit("12", CHUNK)],
      chatComplete: (options) =>
        completeChat({
          ...options,
          baseUrl: "http://127.0.0.1:1234/v1",
          fetchImpl: async (url, init) => {
            const body = JSON.parse(init.body);
            caps.push(body.max_tokens);
            const first = caps.length === 1;
            return jsonResponse({
              choices: [
                {
                  finish_reason: first ? "length" : "stop",
                  message: { content: first ? "Обрезано" : `Ответ: в течение года. «${CHUNK}»` },
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: first ? 512 : 20, total_tokens: first ? 522 : 30 },
            });
          },
        }),
    });
    const rag = await agent.ask("Сколько хранить?", { rag: true, ragMode: "filtered", mcp: false });
    assert.deepEqual(caps, [FZ38_MAX_TOKENS, FZ38_MAX_TOKENS_RETRY]);
    assert.equal(rag.retried, true);
    assert.equal(rag.finishReason, "stop");
    assert.match(rag.reply, /в течение года/);
  });

  it("applies temperature, max tokens and context from the call", async () => {
    const calls = [];
    const agent = new LlmAgent({
      id: "4",
      name: "tuned",
      model: "qwen3.5-4b",
      runtime: "lmstudio",
      apiKey: "",
      cwd: tmpdir(),
      retrieveLaw: () => [hit("12", CHUNK)],
      chatComplete: (options) =>
        completeChat({
          ...options,
          baseUrl: "http://127.0.0.1:1234/v1",
          fetchImpl: async (url, init) => {
            calls.push(JSON.parse(init.body));
            return jsonResponse({
              choices: [{ finish_reason: "stop", message: { content: `Ответ: в течение года. «${CHUNK}»` } }],
              usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
            });
          },
        }),
    });
    await agent.ask("Сколько хранить?", {
      rag: true,
      ragMode: "filtered",
      mcp: false,
      temperature: 0.4,
      maxTokens: 300,
      contextWindow: 4096,
    });
    assert.equal(calls[0].temperature, 0.4);
    assert.equal(calls[0].max_tokens, 300);
    assert.equal(calls.length, 1);
    await assert.rejects(
      () =>
        agent.ask("Сколько хранить рекламные материалы целиком?", {
          rag: true,
          ragMode: "filtered",
          mcp: false,
          contextWindow: 8,
        }),
      /Переполнение контекста/,
    );

    const plain = [];
    const bare = new LlmAgent({
      id: "5",
      name: "bare",
      model: "qwen3.5-4b",
      runtime: "lmstudio",
      apiKey: "",
      cwd: tmpdir(),
      chatComplete: (options) =>
        completeChat({
          ...options,
          baseUrl: "http://127.0.0.1:1234/v1",
          fetchImpl: async (url, init) => {
            plain.push(JSON.parse(init.body));
            return jsonResponse({
              choices: [{ finish_reason: "stop", message: { content: "Париж" } }],
              usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
            });
          },
        }),
    });
    await bare.ask("Какая столица Франции?", {
      mcp: false,
      temperature: 0.1,
      maxTokens: 64,
    });
    assert.equal(plain[0].temperature, 0.1);
    assert.equal(plain[0].max_tokens, 64);
    assert.equal(plain[0].messages[0].role, "user");

    const cloud = new LlmAgent({
      id: "6",
      name: "cloud",
      model: "composer-2.5",
      runtime: "local",
      apiKey: "cursor_test",
      cwd: tmpdir(),
    });
    await assert.rejects(
      () => cloud.ask("текст", { mcp: false, temperature: 0 }),
      /локальной модели/,
    );
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
