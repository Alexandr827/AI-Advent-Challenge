import { Agent } from "@cursor/sdk";
import {
  addUsage,
  contextLimit,
  contextLimitLabel,
  ContextOverflowError,
  emptyUsage,
  estimateTokens,
  fromSdkUsage,
  isContextOverflowMessage,
  normalizeContextLimit,
  normalizeLastTurn,
  normalizeUsage,
  occupancyPercent,
} from "./tokens.js";

function formatHistory(messages) {
  return messages
    .map((item) => `${item.role === "user" ? "User" : "Assistant"}: ${item.content}`)
    .join("\n\n");
}

const WARN_RATIO = 0.8;

export class LlmAgent {
  #sdk = null;
  #startPromise = null;
  #conversationStarted = false;
  #messages;
  #onChange;
  #usage;
  #lastTurn;

  constructor({
    id,
    name,
    model,
    systemPrompt,
    runtime,
    apiKey,
    cwd,
    sdkAgentId,
    messages,
    usage,
    lastTurn,
    contextLimit: contextLimitOverride,
    onChange,
  }) {
    this.id = id;
    this.name = name;
    this.model = model;
    this.systemPrompt = systemPrompt ?? "";
    this.runtime = runtime;
    this.apiKey = apiKey;
    this.cwd = cwd;
    this.sdkAgentId = sdkAgentId ?? null;
    this.status = "idle";
    this.contextLimitOverride = normalizeContextLimit(contextLimitOverride);
    this.#messages = Array.isArray(messages) ? [...messages] : [];
    this.#usage = normalizeUsage(usage);
    this.#lastTurn = normalizeLastTurn(lastTurn);
    this.#onChange = typeof onChange === "function" ? onChange : null;
  }

  get messages() {
    return this.#messages;
  }

  get tokenReport() {
    const historyEstimated = this.#estimateHistoryTokens();
    const limit = this.#resolvedLimit();
    const occupancy = historyEstimated;
    return {
      id: this.id,
      name: this.name,
      model: this.model,
      historyEstimated,
      messageCount: this.#messages.length,
      last: this.#lastTurn,
      usage: { ...this.#usage },
      contextLimit: limit,
      occupancy,
      percent: occupancyPercent(occupancy, limit),
    };
  }

  get snapshot() {
    const report = this.tokenReport;
    return {
      id: this.id,
      name: this.name,
      model: this.model,
      systemPrompt: this.systemPrompt,
      runtime: this.runtime,
      status: this.status,
      messages: this.#messages.length,
      tokens: report.usage.totalTokens,
      occupancy: report.occupancy,
      contextLimit: report.contextLimit,
    };
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      model: this.model,
      systemPrompt: this.systemPrompt,
      runtime: this.runtime,
      sdkAgentId: this.sdkAgentId,
      messages: this.#messages,
      usage: { ...this.#usage },
      lastTurn: this.#lastTurn,
      contextLimit: this.contextLimitOverride,
    };
  }

  #persist() {
    this.#onChange?.();
  }

  #resolvedLimit() {
    return contextLimit(this.model, this.contextLimitOverride);
  }

  #contextText(extraUserText = "") {
    const parts = [];
    if (this.systemPrompt) parts.push(this.systemPrompt);
    for (const item of this.#messages) {
      parts.push(`${item.role === "user" ? "User" : "Assistant"}: ${item.content}`);
    }
    if (extraUserText) parts.push(extraUserText);
    return parts.join("\n\n");
  }

  #estimateHistoryTokens() {
    return estimateTokens(this.#contextText());
  }

  #estimateRequestTokens(userText) {
    return estimateTokens(this.#contextText(userText));
  }

  #sdkOptions() {
    return {
      apiKey: this.apiKey,
      model: { id: this.model },
      tools: [],
      name: this.name,
      ...(this.runtime === "cloud"
        ? { cloud: { repos: [] } }
        : { local: { cwd: this.cwd } }),
    };
  }

  async start() {
    if (this.#sdk) return this.#sdk;
    if (this.#startPromise) return this.#startPromise;

    this.#startPromise = this.#connect();
    try {
      return await this.#startPromise;
    } finally {
      this.#startPromise = null;
    }
  }

  async #connect() {
    if (this.sdkAgentId) {
      try {
        return await this.#resume();
      } catch (err) {
        console.error(
          `Не удалось возобновить SDK-сессию ${this.name}: ${err.message}. Восстанавливаю контекст из сохранённой истории.`,
        );
        this.sdkAgentId = null;
      }
    }
    return this.#create();
  }

  async #resume() {
    this.#sdk = await Agent.resume(this.sdkAgentId, this.#sdkOptions());
    this.sdkAgentId = this.#sdk.agentId ?? this.sdkAgentId;
    this.#conversationStarted = true;
    this.status = "ready";
    this.#persist();
    return this.#sdk;
  }

  async #create() {
    this.#sdk = await Agent.create(this.#sdkOptions());
    this.sdkAgentId = this.#sdk.agentId ?? null;
    this.status = "ready";
    this.#persist();
    return this.#sdk;
  }

  #composePrompt(userText) {
    if (this.#conversationStarted) return userText;

    const parts = [];
    if (this.systemPrompt) parts.push(this.systemPrompt);
    if (this.#messages.length) {
      parts.push(
        "Предыдущий диалог (продолжай с учётом этой истории, не пересказывай её):\n\n" +
          formatHistory(this.#messages),
      );
    }
    if (!parts.length) return userText;
    return `${parts.join("\n\n")}\n\n${userText}`;
  }

  #assertFits(requestTokens) {
    const limit = this.#resolvedLimit();
    if (requestTokens > limit) {
      throw new ContextOverflowError(
        `Переполнение контекста: запрос ~${requestTokens} токенов > лимит ${limit}` +
          ` (${contextLimitLabel(this.model, this.contextLimitOverride)})`,
        { requestTokens, limit },
      );
    }
    if (requestTokens >= Math.ceil(limit * WARN_RATIO)) {
      const pct = occupancyPercent(requestTokens, limit);
      console.error(
        `Предупреждение: контекст ${this.name} заполнен на ${pct}% (~${requestTokens}/${limit})`,
      );
    }
  }

  #wrapOverflow(err, requestTokens) {
    if (err instanceof ContextOverflowError) return err;
    const message = err?.message ?? String(err);
    if (!isContextOverflowMessage(message)) return err;
    const limit = this.#resolvedLimit();
    return new ContextOverflowError(
      `Переполнение контекста модели (~${requestTokens} / ${limit}): ${message}`,
      { requestTokens, limit },
    );
  }

  async ask(userText) {
    const text = String(userText ?? "").trim();
    if (!text) {
      throw new Error("Пустой запрос");
    }
    if (this.status === "busy") {
      throw new Error(`Агент ${this.name} уже обрабатывает запрос`);
    }

    const requestEstimated = this.#estimateRequestTokens(text);
    this.#assertFits(requestEstimated);

    await this.start();
    this.status = "busy";
    try {
      let result;
      try {
        const run = await this.#sdk.send(this.#composePrompt(text));
        result = await run.wait();
      } catch (err) {
        throw this.#wrapOverflow(err, requestEstimated);
      }
      this.#conversationStarted = true;

      if (result.status === "error") {
        throw this.#wrapOverflow(
          new Error(result.error?.message ?? "unknown"),
          requestEstimated,
        );
      }

      const reply = String(result.result ?? "");
      const responseEstimated = estimateTokens(reply);
      const billed = fromSdkUsage(result.usage);
      const turnUsage = billed ?? {
        ...emptyUsage(),
        inputTokens: requestEstimated,
        outputTokens: responseEstimated,
        totalTokens: requestEstimated + responseEstimated,
      };

      this.#lastTurn = {
        requestEstimated,
        requestBilled: billed ? billed.inputTokens : null,
        responseEstimated,
        responseBilled: billed ? billed.outputTokens : null,
        billedReported: Boolean(billed),
      };
      this.#usage = addUsage(this.#usage, turnUsage);
      this.#messages.push(
        { role: "user", content: text, ts: Date.now() },
        { role: "assistant", content: reply, ts: Date.now() },
      );
      this.#persist();
      return { reply, tokens: this.tokenReport };
    } finally {
      this.status = this.#sdk ? "ready" : "idle";
    }
  }

  async billedUsage() {
    if (!this.#sdk || typeof this.#sdk.getUsage !== "function") return null;
    try {
      return await this.#sdk.getUsage();
    } catch {
      return null;
    }
  }

  async dispose() {
    const agent = this.#sdk;
    this.#sdk = null;
    this.#startPromise = null;
    this.#conversationStarted = false;
    this.status = "idle";
    if (!agent) return;
    if (typeof agent.close === "function") {
      agent.close();
      return;
    }
    if (typeof agent[Symbol.asyncDispose] === "function") {
      await agent[Symbol.asyncDispose]();
    }
  }
}
