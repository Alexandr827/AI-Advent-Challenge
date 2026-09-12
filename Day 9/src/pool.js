import { LlmAgent } from "./agent.js";
import { resolveCompressConfig } from "./context.js";
import { loadState, saveState } from "./store.js";

export const MAX_AGENTS = 100;

export class AgentPool {
  #agents = new Map();
  #byName = new Map();
  #nextId = 1;
  #storePath;

  constructor({ apiKey, defaultModel, defaultRuntime, cwd, storePath }) {
    this.apiKey = apiKey;
    this.defaultModel = defaultModel;
    this.defaultRuntime = defaultRuntime;
    this.cwd = cwd;
    this.#storePath = storePath;
    if (storePath) this.#restore();
  }

  get size() {
    return this.#agents.size;
  }

  #persist() {
    if (!this.#storePath) return;
    saveState(this.#storePath, {
      nextId: this.#nextId,
      agents: [...this.#agents.values()].map((agent) => agent.toJSON()),
    });
  }

  #restore() {
    const state = loadState(this.#storePath);
    this.#nextId = state.nextId;
    for (const row of state.agents) {
      this.#createOne(row, { persist: false });
    }
  }

  spawn({
    name,
    model,
    systemPrompt,
    runtime,
    count = 1,
    contextLimit,
    compress,
    compressEvery,
  } = {}) {
    const n = count;
    if (!Number.isInteger(n) || n < 1) {
      throw new Error("--count должен быть целым числом >= 1");
    }
    if (n > MAX_AGENTS) {
      throw new Error(`Нельзя создать больше ${MAX_AGENTS} агентов за раз`);
    }
    if (this.#agents.size + n > MAX_AGENTS) {
      throw new Error(
        `Лимит пула ${MAX_AGENTS}. Свободно слотов: ${MAX_AGENTS - this.#agents.size}`,
      );
    }

    const resolvedModel = (model || this.defaultModel || "").trim();
    if (!resolvedModel) {
      throw new Error("Не задана модель: укажите --model или CURSOR_MODEL");
    }

    const resolvedRuntime = (runtime || this.defaultRuntime || "local").toLowerCase();
    if (resolvedRuntime !== "local" && resolvedRuntime !== "cloud") {
      throw new Error("runtime должен быть local или cloud");
    }

    const names = this.#allocateNames(name, n);
    const compression = resolveCompressConfig({ compress, compressEvery });
    const created = [];
    for (const agentName of names) {
      created.push(
        this.#createOne({
          name: agentName,
          model: resolvedModel,
          systemPrompt: systemPrompt ?? "",
          runtime: resolvedRuntime,
          contextLimit,
          compress: compression.compress,
          compressEvery: compression.compressEvery,
        }),
      );
    }
    return created;
  }

  #allocateNames(name, n) {
    if (n === 1) {
      const agentName = name?.trim() || `agent-${this.#nextId}`;
      this.#assertNameFree(agentName);
      return [agentName];
    }

    const base = name?.trim() || "agent";
    const names = [];
    for (let i = 1; i <= n; i++) {
      const agentName = `${base}-${i}`;
      this.#assertNameFree(agentName);
      names.push(agentName);
    }
    return names;
  }

  #assertNameFree(agentName) {
    if (!agentName) {
      throw new Error("Имя агента не может быть пустым");
    }
    if (/\s/.test(agentName)) {
      throw new Error(`Имя не должно содержать пробелы: ${agentName}`);
    }
    if (this.#byName.has(agentName) || this.#agents.has(agentName)) {
      throw new Error(`Имя уже занято: ${agentName}`);
    }
  }

  #createOne(row, { persist = true } = {}) {
    this.#assertNameFree(row.name);
    const id = row.id != null ? String(row.id) : String(this.#nextId++);
    if (this.#agents.has(id)) {
      throw new Error(`ID уже занят: ${id}`);
    }
    const agent = new LlmAgent({
      id,
      name: row.name,
      model: row.model,
      systemPrompt: row.systemPrompt ?? "",
      runtime: row.runtime,
      apiKey: this.apiKey,
      cwd: this.cwd,
      sdkAgentId: row.sdkAgentId ?? null,
      messages: row.messages ?? [],
      summary: row.summary ?? "",
      summarizedCount: row.summarizedCount ?? 0,
      compress: row.compress,
      compressEvery: row.compressEvery,
      usage: row.usage,
      lastTurn: row.lastTurn,
      contextLimit: row.contextLimit,
      onChange: () => this.#persist(),
    });
    this.#agents.set(id, agent);
    this.#byName.set(row.name, id);
    const numericId = Number(id);
    if (Number.isInteger(numericId) && numericId >= this.#nextId) {
      this.#nextId = numericId + 1;
    }
    if (persist) this.#persist();
    return agent;
  }

  get(nameOrId) {
    if (nameOrId == null) return null;
    const key = String(nameOrId);
    if (this.#agents.has(key)) return this.#agents.get(key);
    const id = this.#byName.get(key);
    return id ? this.#agents.get(id) : null;
  }

  list() {
    return [...this.#agents.values()].map((agent) => agent.snapshot);
  }

  async kill(nameOrId) {
    const agent = this.get(nameOrId);
    if (!agent) {
      throw new Error(`Агент не найден: ${nameOrId}`);
    }
    await agent.dispose();
    this.#agents.delete(agent.id);
    this.#byName.delete(agent.name);
    this.#persist();
    return agent;
  }

  async killAll() {
    const agents = [...this.#agents.values()];
    for (const agent of agents) {
      await agent.dispose();
    }
    this.#agents.clear();
    this.#byName.clear();
    this.#persist();
    return agents.length;
  }

  async disposeAll() {
    const agents = [...this.#agents.values()];
    for (const agent of agents) {
      await agent.dispose();
    }
    return agents.length;
  }
}
