export const DEFAULT_LMSTUDIO_BASE_URL = "http://127.0.0.1:1234/v1";
export const DEFAULT_LMSTUDIO_MODEL = "qwen3.5-4b";
export const DEFAULT_LMSTUDIO_MAX_TOKENS = 512;
export const DEFAULT_LMSTUDIO_TEMPERATURE = 0.2;
/** Отдельный потолок RAG: цитаты не должны упираться в общий LMSTUDIO_MAX_TOKENS. */
export const RAG_LMSTUDIO_MAX_TOKENS = 1024;
/** Загруженное окно qwen3.5-4b. Больше не ставим: в день 28 фрагменты и так влезали. */
export const FZ38_CONTEXT_WINDOW = 4096;
export const FZ38_TEMPERATURE = 0;
export const FZ38_MAX_TOKENS = 512;
/** Если ответ обрезался по length, тот же запрос повторяется с этим потолком. */
export const FZ38_MAX_TOKENS_RETRY = 768;

export const BASELINE_LAW_SYSTEM =
  "Отвечай по-русски только по фрагментам закона. Нужны три блока: ответ, источники и дословные цитаты. Не выдумывай норму.";

export const FZ38_SYSTEM_PROMPT = [
  "Отвечай только по фрагментам Федерального закона «О рекламе» (38-ФЗ). Другие законы не используй.",
  "Если нормы во фрагментах нет — напиши «не знаю» и не придумывай цитату.",
  "Формат строго из трёх блоков: Ответ, Источники, Цитаты.",
  "В «Ответ» — одно-два предложения: номер статьи и формулировка нормы дословно, как во фрагменте.",
  "Не заменяй слова закона синонимами: если в тексте «в течение года», так и пиши, а не «один год».",
  "Если вопрос про индивидуального предпринимателя, не называй сведения юридического лица обязательными для ИП.",
  "Источники: только статья, которая отвечает на вопрос (38-ФЗ | секция | chunk_id).",
  "Цитаты: одна короткая дословная цитата из этой статьи, без соседних статей и без всего чанка.",
].join("\n");

const LAW_PROFILES = new Set(["baseline", "fz38"]);

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

export function storedLawProfile(value) {
  const profile = String(value ?? "").trim().toLowerCase();
  return profile === "fz38" ? "fz38" : "baseline";
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

export function parseLmstudioTemperature(raw, flag = "--temperature") {
  const n = Number(String(raw ?? "").trim());
  if (!Number.isFinite(n) || n < 0 || n > 2) {
    throw new Error(`${flag} должен быть числом от 0 до 2`);
  }
  return n;
}

export function parseLmstudioMaxTokens(raw, flag = "--max-tokens") {
  const n = Number(String(raw ?? "").trim());
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${flag} должен быть целым числом >= 1`);
  }
  return n;
}

export function normalizeLawProfile(value, fallback = "baseline") {
  const profile = String(value ?? "").trim().toLowerCase() || fallback;
  if (!LAW_PROFILES.has(profile)) {
    throw new Error("lawProfile должен быть baseline или fz38");
  }
  return profile;
}

export function lawGenerationProfile(value) {
  const id = normalizeLawProfile(value);
  if (id === "baseline") {
    return {
      id,
      temperature: DEFAULT_LMSTUDIO_TEMPERATURE,
      maxTokens: RAG_LMSTUDIO_MAX_TOKENS,
      contextWindow: FZ38_CONTEXT_WINDOW,
      systemPrompt: "",
      retryMaxTokens: null,
    };
  }
  return {
    id,
    temperature: FZ38_TEMPERATURE,
    maxTokens: FZ38_MAX_TOKENS,
    contextWindow: FZ38_CONTEXT_WINDOW,
    systemPrompt: FZ38_SYSTEM_PROMPT,
    retryMaxTokens: FZ38_MAX_TOKENS_RETRY,
  };
}

export function modelsUrl(baseUrl = lmstudioBaseUrl()) {
  const root = String(baseUrl ?? "").replace(/\/$/, "").replace(/\/v1$/, "");
  return `${root}/api/v0/models`;
}

export function parseLoadedModels(body) {
  const list = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.models)
      ? body.models
      : Array.isArray(body)
        ? body
        : [];
  return list.map((item) => {
    const loaded = Number(item?.loaded_context_length);
    const max = Number(item?.max_context_length);
    const contextLength =
      Number.isFinite(loaded) && loaded > 0
        ? loaded
        : Number.isFinite(max) && max > 0
          ? max
          : null;
    const size = Number(item?.size_bytes ?? item?.size);
    return {
      id: item?.id ?? item?.model ?? null,
      state: item?.state ?? null,
      quantization: item?.quantization ?? null,
      contextLength,
      maxContextLength: Number.isFinite(max) && max > 0 ? max : null,
      arch: item?.arch ?? null,
      sizeBytes: Number.isFinite(size) && size > 0 ? size : null,
    };
  });
}

export function pickLoadedModel(models, modelId = DEFAULT_LMSTUDIO_MODEL) {
  const list = Array.isArray(models) ? models : [];
  const id = String(modelId ?? "").trim();
  return (
    list.find((item) => item.id === id && item.state === "loaded") ??
    list.find((item) => item.id === id) ??
    list.find((item) => item.state === "loaded") ??
    null
  );
}

export async function inspectLoadedModel({
  baseUrl,
  model,
  fetchImpl = globalThis.fetch,
} = {}) {
  const url = modelsUrl(baseUrl);
  let response;
  try {
    response = await fetchImpl(url);
  } catch (err) {
    if (isUnreachable(err)) throw new Error(lmstudioUnavailableMessage(baseUrl || lmstudioBaseUrl()));
    throw new Error(`Не удалось прочитать модели LM Studio (${url}): ${err?.message ?? err}`);
  }
  if (!response?.ok) {
    throw new Error(`LM Studio models ответил HTTP ${response?.status ?? "?"}`);
  }
  const body = await response.json();
  const models = parseLoadedModels(body);
  const loaded = pickLoadedModel(models, model || DEFAULT_LMSTUDIO_MODEL);
  const quantizationsSeen = [...new Set(models.map((item) => item.quantization).filter(Boolean))];
  return {
    url,
    catalog: models.map((item) => ({
      id: item.id,
      state: item.state,
      quantization: item.quantization,
    })),
    loaded,
    quantization: loaded?.quantization ?? null,
    contextLength: loaded?.contextLength ?? null,
    expectedContext: FZ38_CONTEXT_WINDOW,
    contextMatches: loaded?.contextLength === FZ38_CONTEXT_WINDOW,
    quantizationConfigurable: false,
    quantizationsSeen,
    note: "Квантование задаётся файлом GGUF при загрузке модели. В chat/completions такого поля нет.",
  };
}

export function parseLmsPs(text) {
  const rows = [];
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || /^IDENTIFIER\b/i.test(trimmed)) continue;
    const match = trimmed.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\d+(?:\.\d+)?\s*\S+)\s+(\d+)/);
    if (!match) continue;
    rows.push({
      identifier: match[1],
      model: match[2],
      status: match[3],
      size: match[4],
      context: Number(match[5]),
    });
  }
  return rows;
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
