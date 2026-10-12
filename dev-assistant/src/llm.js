const DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
const DEFAULT_MODEL = "qwen3.5-4b";

export function lmstudioBaseUrl() {
  const raw = process.env.LMSTUDIO_BASE_URL?.trim();
  return (raw || DEFAULT_BASE_URL).replace(/\/$/, "");
}

function llmServiceToken() {
  return process.env.LLM_SERVICE_TOKEN?.trim() ?? "";
}

function unavailableMessage(baseUrl) {
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
  if (!content) throw new Error("Локальная LLM вернула пустой ответ");
  return { content, finishReason: finish };
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
  const resolvedModel = String(model || process.env.LMSTUDIO_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const resolvedMax = maxTokens ?? 512;
  const resolvedTemp = temperature ?? 0;
  const chatMessages = Array.isArray(messages)
    ? messages.map((item) => ({ ...item }))
    : [{ role: "user", content: String(prompt ?? "") }];
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
  const headers = { "Content-Type": "application/json" };
  const token = llmServiceToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetchImpl(`${urlBase}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  } catch (err) {
    if (isUnreachable(err)) throw new Error(unavailableMessage(urlBase));
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
    throw new Error(`Локальная LLM ответила HTTP ${status}${snippet ? `: ${snippet}` : ""}`);
  }
  let body;
  try {
    body = await response.json();
  } catch (err) {
    throw new Error(`Локальная LLM вернула не JSON: ${err?.message ?? err}`);
  }
  return parseChatCompletion(body, { maxTokens: resolvedMax });
}
