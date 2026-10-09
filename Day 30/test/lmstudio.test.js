import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { LlmAgent } from "../src/agent.js";
import { AgentPool } from "../src/pool.js";
import { loadState, saveState } from "../src/store.js";
import { contextLimit } from "../src/tokens.js";
import {
  completeChat,
  FZ38_CONTEXT_WINDOW,
  FZ38_SYSTEM_PROMPT,
  inspectLoadedModel,
  lawGenerationProfile,
  lmstudioUnavailableMessage,
  modelsUrl,
  normalizeLawProfile,
  parseChatCompletion,
  parseLmsPs,
  parseLoadedModels,
  storedLawProfile,
} from "../src/lmstudio.js";

const tmpDirs = [];

after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

describe("LM Studio client", () => {
  it("reads visible content and token usage", () => {
    const parsed = parseChatCompletion({
      choices: [{ finish_reason: "stop", message: { content: " Париж ", reasoning_content: "думаю" } }],
      usage: {
        prompt_tokens: 20,
        completion_tokens: 167,
        total_tokens: 187,
        completion_tokens_details: { reasoning_tokens: 161 },
      },
    });
    assert.equal(parsed.content, "Париж");
    assert.equal(parsed.usage.inputTokens, 20);
    assert.equal(parsed.usage.outputTokens, 167);
    assert.equal(parsed.usage.reasoningTokens, 161);
    assert.equal(parsed.usage.totalTokens, 187);
  });

  it("rejects an empty answer when the token budget was spent on reasoning", () => {
    assert.throws(
      () =>
        parseChatCompletion(
          {
            choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "..." } }],
          },
          { maxTokens: 64 },
        ),
      /LMSTUDIO_MAX_TOKENS/,
    );
  });

  it("posts the prompt and explains when the server is down", async () => {
    const calls = [];
    const parsed = await completeChat({
      model: "qwen3.5-4b",
      prompt: "Какая столица Франции?",
      maxTokens: 512,
      temperature: 0.2,
      baseUrl: "http://127.0.0.1:1234/v1",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({
          choices: [{ finish_reason: "stop", message: { content: "Париж" } }],
          usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
        });
      },
    });
    assert.equal(parsed.content, "Париж");
    assert.equal(calls[0].url, "http://127.0.0.1:1234/v1/chat/completions");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, "qwen3.5-4b");
    assert.equal(body.max_tokens, 512);
    assert.equal(body.temperature, 0.2);
    assert.equal(body.enable_thinking, undefined);
    assert.equal(body.messages[0].content, "Какая столица Франции?");

    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    await assert.rejects(
      () =>
        completeChat({
          prompt: "ping",
          baseUrl: "http://127.0.0.1:1234/v1",
          fetchImpl: async () => {
            throw refused;
          },
        }),
      (err) => {
        assert.match(err.message, /lms server start -p 1234/);
        assert.match(err.message, /lms load qwen3.5-4b/);
        return true;
      },
    );
    assert.match(lmstudioUnavailableMessage("http://127.0.0.1:1234/v1"), /1234/);
  });

  it("turns thinking off only when the caller asks", async () => {
    const calls = [];
    await completeChat({
      prompt: "норма",
      maxTokens: 1024,
      enableThinking: false,
      baseUrl: "http://127.0.0.1:1234/v1",
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse({
          choices: [{ finish_reason: "stop", message: { content: "Ответ: год" } }],
        });
      },
    });
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.enable_thinking, false);
    assert.equal(body.max_tokens, 1024);
    assert.equal(body.quantization, undefined);
    assert.equal(body.messages.at(-1).role, "assistant");
    assert.match(body.messages.at(-1).content, /<\/think>/);
  });
});

describe("38-FZ profile", () => {
  it("keeps quantization out of the request and reads it from the model list", async () => {
    assert.equal(normalizeLawProfile(undefined), "baseline");
    assert.equal(storedLawProfile("nope"), "baseline");
    assert.equal(storedLawProfile("fz38"), "fz38");
    assert.throws(() => normalizeLawProfile("q8"), /baseline или fz38/);

    const baseline = lawGenerationProfile("baseline");
    const fz38 = lawGenerationProfile("fz38");
    assert.equal(baseline.temperature, 0.2);
    assert.equal(baseline.maxTokens, 1024);
    assert.equal(baseline.systemPrompt, "");
    assert.equal(fz38.temperature, 0);
    assert.equal(fz38.maxTokens, 512);
    assert.equal(fz38.retryMaxTokens, 768);
    assert.equal(fz38.contextWindow, FZ38_CONTEXT_WINDOW);
    assert.match(FZ38_SYSTEM_PROMPT, /в течение года/);
    assert.match(fz38.systemPrompt, /индивидуальн/);

    const parsed = parseLoadedModels({
      data: [
        {
          id: "other",
          state: "not-loaded",
          quantization: "Q8_0",
          max_context_length: 8192,
        },
        {
          id: "qwen3.5-4b",
          state: "loaded",
          quantization: "Q4_K_M",
          loaded_context_length: 4096,
          max_context_length: 32768,
          arch: "qwen35",
        },
      ],
    });
    assert.equal(parsed[1].quantization, "Q4_K_M");
    assert.equal(parsed[1].contextLength, 4096);
    const info = await inspectLoadedModel({
      baseUrl: "http://127.0.0.1:1234/v1",
      fetchImpl: async (url) => {
        assert.equal(url, modelsUrl("http://127.0.0.1:1234/v1"));
        return jsonResponse({ data: parsed.map((item) => ({
          id: item.id,
          state: item.state,
          quantization: item.quantization,
          loaded_context_length: item.contextLength,
          max_context_length: item.maxContextLength,
        })) });
      },
    });
    assert.equal(info.quantization, "Q4_K_M");
    assert.equal(info.quantizationConfigurable, false);
    assert.equal(info.contextMatches, true);
    assert.deepEqual(info.quantizationsSeen, ["Q8_0", "Q4_K_M"]);

    const ps = parseLmsPs(`IDENTIFIER    MODEL         STATUS    SIZE       CONTEXT
qwen3.5-4b    qwen3.5-4b    IDLE      3.38 GB    4096       4           Local`);
    assert.equal(ps[0].size, "3.38 GB");
    assert.equal(ps[0].context, 4096);
  });
});

describe("lmstudio runtime", () => {
  it("keeps qwen context at the loaded 4096 window", () => {
    const prev = process.env.CURSOR_CONTEXT_LIMIT;
    delete process.env.CURSOR_CONTEXT_LIMIT;
    try {
      assert.equal(contextLimit("qwen3.5-4b", null), 4096);
    } finally {
      if (prev === undefined) delete process.env.CURSOR_CONTEXT_LIMIT;
      else process.env.CURSOR_CONTEXT_LIMIT = prev;
    }
  });

  it("stores runtime lmstudio instead of collapsing it to local", () => {
    const dir = mkdtempSync(join(tmpdir(), "lmstudio-pool-"));
    tmpDirs.push(dir);
    const storePath = join(dir, "agents.json");
    const pool = new AgentPool({
      apiKey: "",
      defaultModel: "qwen3.5-4b",
      defaultRuntime: "lmstudio",
      cwd: dir,
      storePath,
    });
    const [agent] = pool.spawn({ name: "local" });
    assert.equal(agent.runtime, "lmstudio");
    assert.equal(agent.model, "qwen3.5-4b");
    assert.throws(() => pool.spawn({ name: "bad", runtime: "remote" }), /lmstudio/);

    const raw = loadState(storePath);
    raw.agents[0].runtime = "lmstudio";
    saveState(storePath, raw);
    const restored = loadState(storePath);
    assert.equal(restored.agents[0].runtime, "lmstudio");
  });

  it("asks the local model and sends history on the next turn", async () => {
    const prompts = [];
    const agent = new LlmAgent({
      id: "1",
      name: "local",
      model: "qwen3.5-4b",
      runtime: "lmstudio",
      apiKey: "",
      cwd: tmpdir(),
      chatComplete: async ({ prompt, model }) => {
        prompts.push(prompt);
        assert.equal(model, "qwen3.5-4b");
        return {
          content: prompts.length === 1 ? "Париж" : "4",
          usage: {
            inputTokens: 12,
            outputTokens: 2,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 14,
            reasoningTokens: 1,
          },
        };
      },
    });
    const first = await agent.ask("Какая столица Франции?", { mcp: false });
    const second = await agent.ask("Сколько будет 2+2?", { mcp: false });
    assert.equal(first.reply, "Париж");
    assert.equal(second.reply, "4");
    assert.match(prompts[1], /Париж/);
    assert.match(prompts[1], /2\+2/);
    assert.equal(second.tokens.usage.totalTokens, 28);
    assert.equal(agent.runtime, "lmstudio");
  });
});
