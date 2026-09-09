import { Agent } from "@cursor/sdk";

function formatHistory(messages) {
  return messages
    .map((item) => `${item.role === "user" ? "User" : "Assistant"}: ${item.content}`)
    .join("\n\n");
}

export class LlmAgent {
  #sdk = null;
  #startPromise = null;
  #conversationStarted = false;
  #messages;
  #onChange;

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
    this.#messages = Array.isArray(messages) ? [...messages] : [];
    this.#onChange = typeof onChange === "function" ? onChange : null;
  }

  get messages() {
    return this.#messages;
  }

  get snapshot() {
    return {
      id: this.id,
      name: this.name,
      model: this.model,
      systemPrompt: this.systemPrompt,
      runtime: this.runtime,
      status: this.status,
      messages: this.#messages.length,
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
    };
  }

  #persist() {
    this.#onChange?.();
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

  async ask(userText) {
    const text = String(userText ?? "").trim();
    if (!text) {
      throw new Error("Пустой запрос");
    }
    if (this.status === "busy") {
      throw new Error(`Агент ${this.name} уже обрабатывает запрос`);
    }

    await this.start();
    this.status = "busy";
    try {
      const run = await this.#sdk.send(this.#composePrompt(text));
      const result = await run.wait();
      this.#conversationStarted = true;

      if (result.status === "error") {
        throw new Error(result.error?.message ?? "unknown");
      }

      const reply = String(result.result ?? "");
      this.#messages.push(
        { role: "user", content: text, ts: Date.now() },
        { role: "assistant", content: reply, ts: Date.now() },
      );
      this.#persist();
      return reply;
    } finally {
      this.status = this.#sdk ? "ready" : "idle";
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
