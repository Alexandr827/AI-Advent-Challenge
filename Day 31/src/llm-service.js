import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fitLawHits,
  isWeakLawContext,
  LAW_ABSTAIN_REPLY,
  retrieveLawContext,
} from "./doc-index/rag.js";
import { loadEnv } from "./env.js";
import {
  DEFAULT_LMSTUDIO_MODEL,
  FZ38_CONTEXT_WINDOW,
  FZ38_SYSTEM_PROMPT,
  lmstudioBaseUrl,
  lmstudioMaxTokens,
  lmstudioUnavailableMessage,
} from "./lmstudio.js";
import { isMainModule } from "./mcp-serve.js";
import { estimateTokens } from "./tokens.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultLawIndexPath = resolve(projectRoot, "data", "doc-index", "law.sqlite");

export const DEFAULT_LLM_SERVICE_HOST = "0.0.0.0";
export const DEFAULT_LLM_SERVICE_PORT = 8790;
export const DEFAULT_LLM_SERVICE_QUEUE = 8;
export const DEFAULT_LLM_SERVICE_RATE_LIMIT = 10;
export const DEFAULT_LLM_SERVICE_MAX_CONTEXT = FZ38_CONTEXT_WINDOW;
const RATE_WINDOW_MS = 60_000;
const BODY_LIMIT = 1_048_576;

export function tokensMatch(provided, expected) {
  const left = createHash("sha256").update(String(provided ?? "")).digest();
  const right = createHash("sha256").update(String(expected ?? "")).digest();
  return timingSafeEqual(left, right);
}

export function createQueue(limit) {
  let busy = false;
  const waiting = [];

  function occupied() {
    return (busy ? 1 : 0) + waiting.length;
  }

  function pump() {
    if (busy) return;
    const next = waiting.shift();
    if (!next) return;
    busy = true;
    next.grant();
  }

  return {
    get depth() {
      return occupied();
    },
    tryAdmit() {
      if (occupied() >= limit) return null;
      const depth = occupied() + 1;
      const enqueuedAt = Date.now();
      let grant;
      const turn = new Promise((resolveTurn) => {
        grant = resolveTurn;
      });
      waiting.push({ grant, enqueuedAt });
      pump();
      return { turn, depth, enqueuedAt };
    },
    release() {
      busy = false;
      pump();
    },
  };
}

export function createRateLimiter(limit, windowMs = RATE_WINDOW_MS) {
  const hits = new Map();
  return {
    take(ip, now = Date.now()) {
      const recent = (hits.get(ip) ?? []).filter((stamp) => now - stamp < windowMs);
      if (recent.length >= limit) {
        hits.set(ip, recent);
        const retryAfter = Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000));
        return { ok: false, retryAfter };
      }
      recent.push(now);
      hits.set(ip, recent);
      return { ok: true };
    },
  };
}

function parsePositiveInt(raw, name) {
  const n = Number(String(raw ?? "").trim());
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${name} должен быть целым числом >= 1`);
  }
  return n;
}

function envInt(env, name, fallback) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  return parsePositiveInt(raw, name);
}

export function llmServiceConfig(env = process.env, overrides = {}) {
  const portRaw = overrides.port ?? env.LLM_SERVICE_PORT?.trim();
  const port = portRaw === undefined || portRaw === ""
    ? DEFAULT_LLM_SERVICE_PORT
    : Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("LLM_SERVICE_PORT должен быть целым числом от 0 до 65535");
  }
  const upstream = String(overrides.upstream ?? lmstudioBaseUrlFrom(env)).replace(/\/$/, "");
  return {
    host: overrides.host ?? (env.LLM_SERVICE_HOST?.trim() || DEFAULT_LLM_SERVICE_HOST),
    port,
    token: overrides.token ?? env.LLM_SERVICE_TOKEN?.trim() ?? "",
    upstream,
    queueLimit: overrides.queueLimit ?? envInt(env, "LLM_SERVICE_QUEUE", DEFAULT_LLM_SERVICE_QUEUE),
    rateLimit: overrides.rateLimit ?? envInt(env, "LLM_SERVICE_RATE_LIMIT", DEFAULT_LLM_SERVICE_RATE_LIMIT),
    rateWindowMs: overrides.rateWindowMs ?? RATE_WINDOW_MS,
    maxContext: overrides.maxContext ?? envInt(env, "LLM_SERVICE_MAX_CONTEXT", DEFAULT_LLM_SERVICE_MAX_CONTEXT),
    maxTokens: overrides.maxTokens ?? maxTokensFrom(env),
  };
}

function lmstudioBaseUrlFrom(env) {
  if (env === process.env) return lmstudioBaseUrl();
  const raw = env.LMSTUDIO_BASE_URL?.trim();
  return (raw || "http://127.0.0.1:1234/v1").replace(/\/$/, "");
}

function maxTokensFrom(env) {
  if (env === process.env) return lmstudioMaxTokens();
  const raw = env.LMSTUDIO_MAX_TOKENS?.trim();
  if (!raw) return 512;
  return parsePositiveInt(raw, "LMSTUDIO_MAX_TOKENS");
}

export function contextUsage(messages, maxTokens) {
  const list = Array.isArray(messages) ? messages : [];
  const promptTokens = list.reduce((sum, message) => sum + estimateTokens(message?.content), 0);
  return promptTokens + maxTokens;
}

function bearerToken(header) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(String(header ?? ""));
  return match ? match[1] : "";
}

function clientIp(req) {
  return String(req.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error("Тело запроса больше 1 МБ"), { statusCode: 400 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function errorBody(message) {
  return { error: { message } };
}

function queueHeaders(ticket, waitMs) {
  return {
    "X-Queue-Wait-Ms": String(waitMs),
    "X-Queue-Depth": String(ticket.depth),
  };
}

function parseChatRequest(raw, { maxTokens: maxTokensCap, maxContext }) {
  let body;
  try {
    body = JSON.parse(raw || "");
  } catch {
    throw Object.assign(new Error("Тело запроса не JSON"), { statusCode: 400 });
  }
  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    throw Object.assign(new Error("messages должен быть непустым массивом"), { statusCode: 400 });
  }
  let maxTokens = maxTokensCap;
  if (body.max_tokens != null) {
    const n = Number(body.max_tokens);
    if (!Number.isInteger(n) || n < 1) {
      throw Object.assign(new Error("max_tokens должен быть целым числом >= 1"), { statusCode: 400 });
    }
    maxTokens = Math.min(n, maxTokensCap);
  }
  const used = contextUsage(body.messages, maxTokens);
  if (used > maxContext) {
    throw Object.assign(
      new Error(`Контекст ${used} превышает лимит ${maxContext}`),
      { statusCode: 400 },
    );
  }
  const payload = {
    model: String(body.model ?? "").trim() || DEFAULT_LMSTUDIO_MODEL,
    messages: body.messages,
    max_tokens: maxTokens,
  };
  if (body.temperature != null) payload.temperature = body.temperature;
  if (typeof body.enable_thinking === "boolean") payload.enable_thinking = body.enable_thinking;
  if (body.rag === true) payload.rag = true;
  return payload;
}

function lastUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") return i;
  }
  return -1;
}

export function applyLaw(messages, { maxContext, maxTokens, retrieve }) {
  const list = (Array.isArray(messages) ? messages : []).map((item) => ({
    role: item?.role,
    content: String(item?.content ?? ""),
  }));
  if (!list.some((item) => item.role === "system")) {
    list.unshift({ role: "system", content: FZ38_SYSTEM_PROMPT });
  }
  const index = lastUserIndex(list);
  if (index < 0) {
    throw Object.assign(new Error("Для 38-ФЗ нужно сообщение пользователя"), { statusCode: 400 });
  }
  const query = list[index].content;
  const found = retrieve(query);
  const hits = Array.isArray(found?.hits) ? found.hits : Array.isArray(found) ? found : [];
  if (isWeakLawContext(hits)) return { abstain: LAW_ABSTAIN_REPLY };
  const bare = contextUsage(list, maxTokens);
  const think = "<think>\n\n</think>\n\n";
  const budget = maxContext - bare - estimateTokens(think) - 32;
  if (budget < 64) {
    throw Object.assign(
      new Error(`Контекст ${bare} превышает лимит ${maxContext}`),
      { statusCode: 400 },
    );
  }
  const fitted = fitLawHits(hits, { budgetTokens: budget });
  if (isWeakLawContext(fitted.hits) || !fitted.law) return { abstain: LAW_ABSTAIN_REPLY };
  list[index] = { role: "user", content: `${fitted.law}\n\nВопрос: ${query}` };
  list.push({ role: "assistant", content: think });
  return { messages: list };
}

function lawReply(content) {
  return {
    choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
  };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

export function lanIpv4() {
  let nets = {};
  try {
    nets = networkInterfaces() ?? {};
  } catch {
    return [];
  }
  const found = [];
  for (const list of Object.values(nets)) {
    for (const net of list ?? []) {
      if (net.family !== "IPv4" && net.family !== 4) continue;
      if (net.internal) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(net.address)) continue;
      found.push(net.address);
    }
  }
  return found;
}

export function browserUrls(port, ips = lanIpv4()) {
  const urls = [`http://127.0.0.1:${port}/`];
  for (const ip of ips) {
    if (ip && ip !== "127.0.0.1") urls.push(`http://${ip}:${port}/`);
  }
  return urls;
}

export function chatPageHtml(phoneUrls = []) {
  const links = phoneUrls
    .filter((url) => !String(url).includes("127.0.0.1"))
    .map((url) => `<li><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></li>`)
    .join("");
  const phoneBlock = links
    ? `<p>С телефона в той же Wi-Fi откройте:</p><ul>${links}</ul>`
    : "";
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Локальная модель</title>
  <style>
    body { margin: 0; font: 16px/1.45 sans-serif; background: #f6f4ef; color: #1c1915; }
    main { max-width: 40rem; margin: 0 auto; padding: 1rem 1rem 2rem; }
    h1 { font-size: 1.4rem; margin: 0 0 0.5rem; }
    label { display: block; margin: 0.8rem 0 0.25rem; }
    input, textarea, button { font: inherit; width: 100%; box-sizing: border-box; }
    input, textarea { padding: 0.6rem; border: 1px solid #c9c2b6; border-radius: 0.4rem; background: #fff; }
    textarea { min-height: 6rem; }
    button { min-height: 3rem; margin-top: 0.6rem; border: 0; border-radius: 0.4rem; background: #245c3a; color: #fff; }
    button:disabled { opacity: 0.6; }
    .row { display: flex; gap: 0.75rem; }
    .row label { flex: 1; }
    .check { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.8rem; }
    .check input { width: 1.2rem; height: 1.2rem; }
    #log p { white-space: pre-wrap; padding: 0.75rem; margin: 0.5rem 0; border-radius: 0.5rem; }
    #log .user { background: #fff; }
    #log .assistant { background: #e7f0e4; }
    #error { color: #8a1f1f; min-height: 1.2em; }
  </style>
</head>
<body>
<main>
  <h1>Локальная модель</h1>
  ${phoneBlock}
  <form id="chat">
    <label>Секрет<input id="token" type="password" autocomplete="off"></label>
    <label>Системный текст<textarea id="system" rows="3"></textarea></label>
    <div class="row">
      <label>Температура<input id="temperature" type="number" min="0" max="2" step="0.1" value="0.2"></label>
      <label>Максимум токенов<input id="max-tokens" type="number" min="1" step="1" value="512"></label>
    </div>
    <label class="check"><input id="law" type="checkbox">Только 38-ФЗ</label>
    <label>Сообщение<textarea id="message"></textarea></label>
    <button type="submit">Спросить</button>
    <p id="error"></p>
  </form>
  <div id="log"></div>
</main>
<script>
const tokenInput = document.querySelector("#token");
const systemInput = document.querySelector("#system");
const temperatureInput = document.querySelector("#temperature");
const maxTokensInput = document.querySelector("#max-tokens");
const lawInput = document.querySelector("#law");
const messageInput = document.querySelector("#message");
const form = document.querySelector("#chat");
const log = document.querySelector("#log");
const error = document.querySelector("#error");
const button = form.querySelector("button");
const history = [];
const saved = sessionStorage.getItem("llmServiceToken");
if (saved) tokenInput.value = saved;

function escapeText(value) {
  return String(value).replace(/[&<>]/g, function (ch) {
    if (ch === "&") return "&amp;";
    if (ch === "<") return "&lt;";
    return "&gt;";
  });
}

function render() {
  log.innerHTML = history.map(function (item) {
    const kind = item.role === "user" ? "user" : "assistant";
    const title = kind === "user" ? "Вы" : "Модель";
    return "<p class=\\"" + kind + "\\"><b>" + title + "</b><br>" + escapeText(item.content) + "</p>";
  }).join("");
}

form.addEventListener("submit", async function (event) {
  event.preventDefault();
  const text = messageInput.value.trim();
  const token = tokenInput.value.trim();
  if (!text) return;
  sessionStorage.setItem("llmServiceToken", token);
  error.textContent = "";
  history.push({ role: "user", content: text });
  messageInput.value = "";
  render();
  button.disabled = true;
  const messages = [];
  const system = systemInput.value.trim();
  if (system) messages.push({ role: "system", content: system });
  history.forEach(function (item) { messages.push(item); });
  try {
    const response = await fetch("/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + token,
      },
      body: JSON.stringify({
        model: "qwen3.5-4b",
        messages: messages,
        temperature: Number(temperatureInput.value),
        max_tokens: Number(maxTokensInput.value),
        rag: lawInput.checked,
      }),
    });
    const raw = await response.text();
    let data = null;
    try { data = JSON.parse(raw); } catch (ignore) { data = null; }
    if (!response.ok) {
      history.pop();
      render();
      error.textContent = (data && data.error && data.error.message) || ("HTTP " + response.status);
      return;
    }
    const reply = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : "";
    history.push({ role: "assistant", content: reply || "Пустой ответ" });
    render();
  } catch (err) {
    history.pop();
    render();
    error.textContent = err.message || "Не удалось отправить запрос";
  } finally {
    button.disabled = false;
  }
});
</script>
</body>
</html>`;
}

function unreachable(err) {
  const code = err?.cause?.code ?? err?.code;
  return /ECONNREFUSED|ENOTFOUND|ECONNRESET|EHOSTUNREACH|EAI_AGAIN/.test(String(code ?? ""))
    || /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(String(err?.message ?? ""));
}

export async function startLlmService(options = {}) {
  const config = llmServiceConfig(process.env, options);
  if (!config.token) {
    throw new Error("Задайте LLM_SERVICE_TOKEN");
  }
  const queue = createQueue(config.queueLimit);
  const rates = createRateLimiter(config.rateLimit, config.rateWindowMs);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const retrieveLaw = options.retrieveLaw ?? ((query) => retrieveLawContext(query, {
    indexPath: options.lawIndexPath ?? defaultLawIndexPath,
    mode: "filtered",
  }));

  const server = createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    try {
      if (req.method === "GET" && path === "/health") {
        sendJson(res, 200, { ok: true, upstream: config.upstream });
        return;
      }
      if (req.method === "GET" && path === "/") {
        const pagePort = server.address()?.port ?? config.port;
        const html = chatPageHtml(browserUrls(pagePort));
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": Buffer.byteLength(html),
          "Cache-Control": "no-store",
        });
        res.end(html);
        return;
      }
      if (path !== "/v1/chat/completions") {
        sendJson(res, 404, errorBody("Неизвестный путь"));
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, errorBody("Нужен POST"));
        return;
      }
      const provided = bearerToken(req.headers.authorization);
      if (!provided || !tokensMatch(provided, config.token)) {
        sendJson(res, 401, errorBody("Нужен Authorization: Bearer"));
        req.resume();
        return;
      }

      const raw = await readBody(req);
      let payload = parseChatRequest(raw, config);
      if (payload.rag) {
        const law = applyLaw(payload.messages, {
          maxContext: config.maxContext,
          maxTokens: payload.max_tokens,
          retrieve: retrieveLaw,
        });
        if (law.abstain) {
          const rate = rates.take(clientIp(req));
          if (!rate.ok) {
            sendJson(res, 429, errorBody("Слишком много запросов"), {
              "Retry-After": String(rate.retryAfter),
            });
            return;
          }
          sendJson(res, 200, lawReply(law.abstain));
          return;
        }
        const next = {
          model: payload.model,
          messages: law.messages,
          max_tokens: payload.max_tokens,
          enable_thinking: false,
        };
        if (payload.temperature != null) next.temperature = payload.temperature;
        payload = parseChatRequest(JSON.stringify(next), config);
      }
      delete payload.rag;
      const rate = rates.take(clientIp(req));
      if (!rate.ok) {
        sendJson(res, 429, errorBody("Слишком много запросов"), {
          "Retry-After": String(rate.retryAfter),
        });
        return;
      }
      const ticket = queue.tryAdmit();
      if (!ticket) {
        sendJson(res, 429, errorBody("Очередь занята"), {
          "Retry-After": "1",
          "X-Queue-Depth": String(queue.depth),
        });
        return;
      }
      let released = false;
      const finish = () => {
        if (released) return;
        released = true;
        queue.release();
      };
      try {
        await ticket.turn;
        const waitMs = Date.now() - ticket.enqueuedAt;
        const headers = queueHeaders(ticket, waitMs);
        let response;
        try {
          response = await fetchImpl(`${config.upstream}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
        } catch (err) {
          const message = unreachable(err)
            ? lmstudioUnavailableMessage(config.upstream)
            : `Локальная LLM недоступна (${config.upstream}): ${err?.message ?? err}`;
          sendJson(res, 503, errorBody(message), headers);
          return;
        }
        const text = typeof response?.text === "function" ? await response.text() : "";
        const status = Number(response?.status) || (response?.ok ? 200 : 502);
        res.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(text),
          ...headers,
        });
        res.end(text);
      } finally {
        finish();
      }
    } catch (err) {
      if (res.headersSent) return;
      const status = err?.statusCode ?? 500;
      sendJson(res, status, errorBody(err?.message ?? "Ошибка сервиса"));
    }
  });

  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });

  const address = server.address();
  const hostname = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
  return {
    url: `http://${hostname}:${address.port}`,
    host: config.host,
    port: address.port,
    upstream: config.upstream,
    depth: () => queue.depth,
    close: () => new Promise((resolveClose, reject) => {
      server.close((err) => (err ? reject(err) : resolveClose()));
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    }),
  };
}

export async function main() {
  loadEnv(resolve(projectRoot, ".env"));
  const handle = await startLlmService();
  const pages = browserUrls(handle.port);
  console.log(pages.map((url, index) => (
    index === 0 ? `Чат на этом ноутбуке: ${url}` : `Чат с телефона: ${url}`
  )).join("\n"));
  console.log(`llm-service слушает http://${handle.host}:${handle.port} → ${handle.upstream}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}
