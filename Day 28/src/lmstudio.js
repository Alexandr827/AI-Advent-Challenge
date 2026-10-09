export const DEFAULT_LMSTUDIO_BASE_URL = "http://127.0.0.1:1234/v1";
export const DEFAULT_LMSTUDIO_MODEL = "qwen3.5-4b";
export const DEFAULT_LMSTUDIO_MAX_TOKENS = 512;
export const DEFAULT_LMSTUDIO_TEMPERATURE = 0.2;
/** Отдельный потолок RAG: цитаты не должны упираться в общий LMSTUDIO_MAX_TOKENS. */
export const RAG_LMSTUDIO_MAX_TOKENS = 1024;

const RUNTIMES = new Set(["local", "cloud", "lmstudio"]);

export function normalizeRuntime(value, fallback = "local") {
  const runtime = String(value ?? "").trim().toLowerCase() || fallback;
  if (!RUNTIMES.has(runtime)) {
    throw new Error("runtime должен быть local, cloud или lmstudio");
  }
  return runtime;
}

export function storedRuntime(value) {
  const runtime = String(value ?? "").trim().toLowerCase();
  if (runtime === "cloud" || runtime === "lmstudio") return runtime;
  return "local";
}

export function lmstudioBaseUrl() {
  const raw = process.env.LMSTUDIO_BASE_URL?.trim();
  return (raw || DEFAULT_LMSTUDIO_BASE_URL).replace(/\/$/, "");
}

export function lmstudioMaxTokens() {
  const raw = process.env.LMSTUDIO_MAX_TOKENS?.trim();
  if (!raw) return DEFAULT_LMSTUDIO_MAX_TOKENS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error("LMSTUDIO_MAX_TOKENS должен быть целым числом >= 1");
  }
  return n;
}

export function lmstudioTemperature() {
  const raw = process.env.LMSTUDIO_TEMPERATURE?.trim();
  if (!raw) return DEFAULT_LMSTUDIO_TEMPERATURE;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error("LMSTUDIO_TEMPERATURE должен быть числом");
  }
  return n;
}

export function lmstudioUnavailableMessage(baseUrl = lmstudioBaseUrl()) {
  return (
    `Локальная LLM недоступна (${baseUrl}). ` +
    "Запустите: lms server start -p 1234 и lms load qwen3.5-4b"
  );
}

function isUnreachable(err) {
  const codes = new Set();
  const visit = (value, depth) => {
    if (!value || depth > 5 || typeof value !== "object") return;
    if (value.code) codes.add(value.code);
    if (Array.isArray(value.errors)) {
      for (const item of value.errors) visit(item, depth + 1);
    }
    if (value.cause) visit(value.cause, depth + 1);
  };
  visit(err, 0);
  if ([...codes].some((code) => /ECONNREFUSED|ENOTFOUND|ECONNRESET|EHOSTUNREACH|EAI_AGAIN/.test(code))) {
    return true;
  }
  return /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(String(err?.message ?? ""));
}

export function parseChatCompletion(body, { maxTokens } = {}) {
  const choice = body?.choices?.[0];
  const content = String(choice?.message?.content ?? "").trim();
  const finish = choice?.finish_reason ?? null;
  if (!content && finish === "length") {
    const limit = maxTokens ?? "max_tokens";
    throw new Error(
      `Ответ пустой: бюджет max_tokens (${limit}) ушёл в рассуждение модели. Увеличьте LMSTUDIO_MAX_TOKENS.`,
    );
  }
  if (!content) {
    throw new Error("Локальная LLM вернула пустой ответ");
  }
  const raw = body?.usage;
  const hasUsage =
    raw &&
    typeof raw === "object" &&
    (raw.prompt_tokens != null || raw.completion_tokens != null || raw.total_tokens != null);
  let usage = null;
  if (hasUsage) {
    const inputTokens = Number(raw.prompt_tokens) || 0;
    const outputTokens = Number(raw.completion_tokens) || 0;
    const reasoningTokens =
      Number(raw.reasoning_tokens) ||
      Number(raw.completion_tokens_details?.reasoning_tokens) ||
      0;
    const totalTokens = Number(raw.total_tokens) || inputTokens + outputTokens;
    usage = {
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens,
      reasoningTokens,
    };
  }
  return { content, finishReason: finish, usage };
}

export async function completeChat({
  model,
  prompt,
  messages,
  maxTokens,
  temperature,
  baseUrl,
  enableThinking,
  fetchImpl = globalThis.fetch,
} = {}) {
  const urlBase = (baseUrl || lmstudioBaseUrl()).replace(/\/$/, "");
  const resolvedModel = String(model || DEFAULT_LMSTUDIO_MODEL).trim() || DEFAULT_LMSTUDIO_MODEL;
  const resolvedMax = maxTokens ?? lmstudioMaxTokens();
  const resolvedTemp = temperature ?? lmstudioTemperature();
  const chatMessages = Array.isArray(messages)
    ? messages.map((item) => ({ ...item }))
    : [{ role: "user", content: String(prompt ?? "") }];
  const endpoint = `${urlBase}/chat/completions`;
  const payload = {
    model: resolvedModel,
    messages: chatMessages,
    temperature: resolvedTemp,
    max_tokens: resolvedMax,
  };
  if (enableThinking === false) {
    payload.enable_thinking = false;
    const last = chatMessages[chatMessages.length - 1];
    if (last?.role !== "assistant") {
      chatMessages.push({ role: "assistant", content: "<think>\n\n</think>\n\n" });
    }
  }

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    if (isUnreachable(err)) throw new Error(lmstudioUnavailableMessage(urlBase));
    throw new Error(`Локальная LLM недоступна (${urlBase}): ${err?.message ?? err}`);
  }

  if (!response?.ok) {
    let detail = "";
    try {
      detail = typeof response?.text === "function" ? await response.text() : "";
    } catch {
      detail = "";
    }
    const status = response?.status ?? "?";
    const snippet = String(detail ?? "").trim().slice(0, 300);
    throw new Error(
      `Локальная LLM ответила HTTP ${status}${snippet ? `: ${snippet}` : ""}`,
    );
  }

  let body;
  try {
    body = await response.json();
  } catch (err) {
    throw new Error(`Локальная LLM вернула не JSON: ${err?.message ?? err}`);
  }
  return parseChatCompletion(body, { maxTokens: resolvedMax });
}
