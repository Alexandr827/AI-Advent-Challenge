import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { completeChat } from "../src/lmstudio.js";
import { browserUrls, startLlmService } from "../src/llm-service.js";

const handles = [];

after(async () => {
  await Promise.all(handles.map((handle) => handle.close()));
});

function upstreamOk(content = "Париж") {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content } }],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
      });
    },
  };
}

async function listen(overrides = {}) {
  const handle = await startLlmService({
    host: "127.0.0.1",
    port: 0,
    token: "secret",
    upstream: "http://127.0.0.1:1234/v1",
    queueLimit: 8,
    rateLimit: 10,
    maxContext: 4096,
    maxTokens: 512,
    fetchImpl: async () => upstreamOk(),
    ...overrides,
  });
  handles.push(handle);
  return handle;
}

async function post(url, body, { token = "secret" } = {}) {
  const headers = { "content-type": "application/json" };
  if (token != null) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${url}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, json, text };
}

function chatBody(content, extra = {}) {
  return {
    model: "qwen3.5-4b",
    max_tokens: 64,
    messages: [{ role: "user", content }],
    ...extra,
  };
}

async function waitFor(predicate) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 1000) throw new Error("таймаут ожидания");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("llm service", () => {
  it("prints browser urls for this laptop and the phone", () => {
    assert.deepEqual(browserUrls(8790, ["192.168.1.124"]), [
      "http://127.0.0.1:8790/",
      "http://192.168.1.124:8790/",
    ]);
  });

  it("serves a chat page without the token", async () => {
    const handle = await listen();
    const response = await fetch(`${handle.url}/`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    assert.match(html, /id="message"/);
    assert.match(html, /id="temperature"/);
    assert.match(html, /id="max-tokens"/);
    assert.match(html, /id="system"/);
    assert.match(html, /id="law"/);
    assert.equal(html.includes("secret"), false);
    assert.equal(html.includes(handle.upstream), false);
  });

  it("opens /health without a token and answers chat with the bearer", async () => {
    let forwarded = null;
    const handle = await listen({
      fetchImpl: async (url, init) => {
        forwarded = { url, init };
        return upstreamOk("Париж");
      },
    });

    const health = await fetch(`${handle.url}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true,
      upstream: "http://127.0.0.1:1234/v1",
    });

    const result = await post(handle.url, chatBody("Какая столица Франции?", { max_tokens: 5000 }));
    assert.equal(result.status, 200);
    assert.equal(result.json.choices[0].message.content, "Париж");
    assert.equal(Number(result.headers.get("x-queue-depth")), 1);
    assert.ok(Number(result.headers.get("x-queue-wait-ms")) >= 0);
    assert.equal(forwarded.url, "http://127.0.0.1:1234/v1/chat/completions");
    assert.equal(forwarded.init.headers.Authorization, undefined);
    const payload = JSON.parse(forwarded.init.body);
    assert.equal(payload.max_tokens, 512);
    assert.equal(payload.messages[0].content, "Какая столица Франции?");
  });

  it("answers from the law index without calling the model when nothing matches", async () => {
    let calls = 0;
    const handle = await listen({
      retrieveLaw: () => ({ hits: [] }),
      fetchImpl: async () => {
        calls += 1;
        return upstreamOk("не должен");
      },
    });
    const result = await post(handle.url, { ...chatBody("Какая столица Франции?"), rag: true });
    assert.equal(result.status, 200);
    assert.match(result.json.choices[0].message.content, /Не знаю/);
    assert.equal(calls, 0);
  });

  it("sends law fragments to the model and hides the checkbox flag", async () => {
    let forwarded = null;
    const handle = await listen({
      retrieveLaw: () => ({
        hits: [{
          chunk_id: "c12",
          section: "Статья 12",
          source: "38-ФЗ",
          text: "хранятся в течение года",
          score: 0.9,
        }],
      }),
      fetchImpl: async (_url, init) => {
        forwarded = JSON.parse(init.body);
        return upstreamOk("в течение года");
      },
    });
    const result = await post(handle.url, { ...chatBody("Сколько хранить?"), rag: true });
    assert.equal(result.status, 200);
    assert.equal(result.json.choices[0].message.content, "в течение года");
    assert.equal(forwarded.rag, undefined);
    assert.equal(forwarded.enable_thinking, false);
    assert.match(forwarded.messages.at(-2).content, /хранятся в течение года/);
    assert.match(forwarded.messages.at(-1).content, /<think>/);
  });

  it("rejects a missing or foreign bearer", async () => {
    const handle = await listen();
    const missing = await post(handle.url, chatBody("ping"), { token: null });
    const foreign = await post(handle.url, chatBody("ping"), { token: "other" });
    assert.equal(missing.status, 401);
    assert.equal(foreign.status, 401);
  });

  it("runs a second connection only after the first leaves the model", async () => {
    let active = 0;
    let maxActive = 0;
    const order = [];
    let releaseFirst;
    const hold = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const handle = await listen({
      fetchImpl: async (_url, init) => {
        const { messages } = JSON.parse(init.body);
        const label = messages[0].content;
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(`start:${label}`);
        if (label === "один") await hold;
        active -= 1;
        order.push(`end:${label}`);
        return upstreamOk(label);
      },
    });

    const first = post(handle.url, chatBody("один"));
    await waitFor(() => order.includes("start:один"));
    const second = post(handle.url, chatBody("два"));
    await waitFor(() => handle.depth() >= 2);
    assert.deepEqual(order, ["start:один"]);
    releaseFirst();
    const [left, right] = await Promise.all([first, second]);
    assert.equal(left.status, 200);
    assert.equal(right.status, 200);
    assert.equal(maxActive, 1);
    assert.ok(order.indexOf("end:один") < order.indexOf("start:два"));
    assert.ok(Number(right.headers.get("x-queue-wait-ms")) >= Number(left.headers.get("x-queue-wait-ms")));
  });

  it("answers 429 when the queue is already full", async () => {
    let calls = 0;
    let release;
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    const handle = await listen({
      queueLimit: 2,
      fetchImpl: async () => {
        calls += 1;
        await hold;
        return upstreamOk("ок");
      },
    });

    const first = post(handle.url, chatBody("один"));
    await waitFor(() => handle.depth() >= 1);
    const second = post(handle.url, chatBody("два"));
    await waitFor(() => handle.depth() >= 2);
    const third = await post(handle.url, chatBody("три"));
    assert.equal(third.status, 429);
    assert.equal(third.headers.get("retry-after"), "1");
    assert.match(third.json.error.message, /Очередь занята/);
    assert.equal(calls, 1);
    release();
    const done = await Promise.all([first, second]);
    assert.deepEqual(done.map((item) => item.status), [200, 200]);
    assert.equal(calls, 2);
  });

  it("answers 429 before queueing when the rate limit is exceeded", async () => {
    let calls = 0;
    const handle = await listen({
      rateLimit: 2,
      fetchImpl: async () => {
        calls += 1;
        return upstreamOk("ок");
      },
    });
    const first = await post(handle.url, chatBody("один"));
    const second = await post(handle.url, chatBody("два"));
    const third = await post(handle.url, chatBody("три"));
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 429);
    assert.match(third.json.error.message, /Слишком много запросов/);
    assert.ok(Number(third.headers.get("retry-after")) >= 1);
    assert.equal(calls, 2);
  });

  it("rejects a prompt over the context limit before calling the model", async () => {
    let calls = 0;
    const handle = await listen({
      fetchImpl: async () => {
        calls += 1;
        return upstreamOk("не должен");
      },
    });
    const result = await post(handle.url, chatBody("а".repeat(4096 * 4), { max_tokens: 512 }));
    assert.equal(result.status, 400);
    assert.match(result.json.error.message, /4096/);
    assert.equal(calls, 0);
  });

  it("sends the service token from the CLI client", async () => {
    const previous = process.env.LLM_SERVICE_TOKEN;
    let seen = null;
    const handle = await listen({
      fetchImpl: async () => upstreamOk("Париж"),
    });
    process.env.LLM_SERVICE_TOKEN = "secret";
    try {
      const parsed = await completeChat({
        baseUrl: `${handle.url}/v1`,
        prompt: "Какая столица Франции? Ответь одним словом.",
        maxTokens: 64,
      });
      assert.equal(parsed.content, "Париж");

      delete process.env.LLM_SERVICE_TOKEN;
      await completeChat({
        prompt: "ping",
        fetchImpl: async (_url, init) => {
          seen = init.headers;
          return {
            ok: true,
            status: 200,
            async json() {
              return { choices: [{ finish_reason: "stop", message: { content: "ок" } }] };
            },
            async text() {
              return JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ок" } }] });
            },
          };
        },
      });
      assert.equal(seen.Authorization, undefined);
    } finally {
      if (previous === undefined) delete process.env.LLM_SERVICE_TOKEN;
      else process.env.LLM_SERVICE_TOKEN = previous;
    }
  });
});
