import { Agent } from "@cursor/sdk";

export class LlmAgent {
  #sdk = null;
  #startPromise = null;
  #conversationStarted = false;

  constructor({ id, name, model, systemPrompt, runtime, apiKey, cwd }) {
    this.id = id;
    this.name = name;
    this.model = model;
    this.systemPrompt = systemPrompt ?? "";
    this.runtime = runtime;
    this.apiKey = apiKey;
    this.cwd = cwd;
    this.status = "idle";
  }

  get snapshot() {
    return {
      id: this.id,
      name: this.name,
      model: this.model,
      systemPrompt: this.systemPrompt,
      runtime: this.runtime,
      status: this.status,
    };
  }

  async start() {
    if (this.#sdk) return this.#sdk;
    if (this.#startPromise) return this.#startPromise;

    this.#startPromise = this.#create();
    try {
      return await this.#startPromise;
    } finally {
      this.#startPromise = null;
    }
  }

  async #create() {
    const options = {
      apiKey: this.apiKey,
      model: { id: this.model },
      tools: [],
      ...(this.runtime === "cloud"
        ? { cloud: { repos: [] } }
        : { local: { cwd: this.cwd } }),
    };
    this.#sdk = await Agent.create(options);
    this.status = "ready";
    return this.#sdk;
  }

  #composePrompt(userText) {
    if (this.#conversationStarted || !this.systemPrompt) return userText;
    return `${this.systemPrompt}\n\n${userText}`;
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

      return String(result.result ?? "");
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
