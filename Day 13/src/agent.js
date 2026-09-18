import { Agent } from "@cursor/sdk";
import {
  foldSummary,
  formatHistory,
  normalizeCompress,
  normalizeCompressEvery,
  normalizeSummarizedCount,
  pendingToSummarize,
  promptMessages,
} from "./context.js";
import {
  AgentMemory,
  MEMORY_SHORT,
  parseMemoryDirective,
} from "./memory.js";
import {
  cloneMessages,
  extractFactsFromMessages,
  formatFacts,
  hydrateBranching,
  normalizeFacts,
  normalizeStrategy,
  normalizeWindow,
  parseBranchName,
  rewritesPromptEachAsk,
  slidingWindow,
  STRATEGY_BRANCHING,
  STRATEGY_FACTS,
  STRATEGY_FULL,
  strategyLabel,
  updateFacts,
  usesWindow,
} from "./strategy.js";
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
import {
  emptyProfile,
  formatProfile,
  ProfileLoader,
  buildPrompt,
  parseUserId,
  profileSnapshot,
} from "./profile.js";
import {
  cloneTaskContext,
  formatTaskPrompt,
  isActiveTask,
} from "./task.js";

const WARN_RATIO = 0.8;

export class LlmAgent {
  #sdk = null;
  #startPromise = null;
  #conversationStarted = false;
  #messages;
  #summary;
  #summarizedCount;
  #onChange;
  #usage;
  #lastTurn;
  #facts;
  #memory;
  #checkpoint;
  #branches;
  #currentBranch;
  #loader;
  #profile;

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
    summary,
    summarizedCount,
    compress,
    compressEvery,
    usage,
    lastTurn,
    contextLimit: contextLimitOverride,
    strategy,
    window,
    facts,
    memory,
    checkpoint,
    branches,
    currentBranch,
    profileId,
    profileLoader,
    onChange,
  }) {
    this.id = id;
    this.name = name;
    this.model = model;
    this.systemPrompt = systemPrompt ?? "";
    this.runtime = runtime;
    this.apiKey = apiKey;
    this.cwd = cwd;
    this.status = "idle";
    this.contextLimitOverride = normalizeContextLimit(contextLimitOverride);
    this.compress = normalizeCompress(compress);
    this.compressEvery = normalizeCompressEvery(compressEvery);
    this.strategy = normalizeStrategy(strategy);
    this.window = normalizeWindow(window);
    this.profileId = String(profileId ?? "").trim();
    this.#loader = profileLoader instanceof ProfileLoader ? profileLoader : null;
    this.#profile = this.#loader?.tryLoad(this.profileId) ?? emptyProfile();
    this.#messages = Array.isArray(messages) ? [...messages] : [];
    this.#summary = typeof summary === "string" ? summary : "";
    this.#facts = normalizeFacts(facts);
    this.#memory = new AgentMemory(memory);
    if (this.strategy === STRATEGY_FACTS) {
      this.#facts = extractFactsFromMessages(this.#messages, this.#facts);
    }
    this.#summarizedCount =
      this.compress && this.#summary && this.strategy === STRATEGY_FULL
        ? normalizeSummarizedCount(summarizedCount, this.#messages.length)
        : 0;
    if (
      this.strategy === STRATEGY_FULL &&
      this.compress &&
      this.#summary &&
      this.#summarizedCount === 0
    ) {
      const extra = Math.max(0, this.#messages.length - this.compressEvery);
      this.#summarizedCount = extra - (extra % this.compressEvery);
    }
    this.#compact();
    this.sdkAgentId =
      (this.strategy === STRATEGY_FULL && this.compress && this.#summary) ||
      rewritesPromptEachAsk(this.strategy)
        ? null
        : (sdkAgentId ?? null);
    this.#usage = normalizeUsage(usage);
    this.#lastTurn = normalizeLastTurn(lastTurn);
    this.#onChange = typeof onChange === "function" ? onChange : null;
    this.#initManagedState({ checkpoint, branches, currentBranch, sdkAgentId });
  }

  #initManagedState({ checkpoint, branches, currentBranch, sdkAgentId }) {
    if (this.strategy === STRATEGY_BRANCHING) {
      const hydrated = hydrateBranching({
        messages: this.#messages,
        sdkAgentId: this.sdkAgentId ?? sdkAgentId,
        branches,
        currentBranch,
        checkpoint,
      });
      this.#branches = hydrated.branches;
      this.#currentBranch = hydrated.currentBranch;
      this.#checkpoint = hydrated.checkpoint;
      this.#messages = this.#branches[this.#currentBranch].messages;
      this.sdkAgentId = this.#branches[this.#currentBranch].sdkAgentId;
      return;
    }
    this.#branches = null;
    this.#currentBranch = null;
    this.#checkpoint = null;
    if (usesWindow(this.strategy)) {
      this.#messages = slidingWindow(this.#messages, this.window);
      this.sdkAgentId = null;
    }
  }

  get messages() {
    return this.#messages;
  }

  get summary() {
    return this.#summary;
  }

  get facts() {
    return { ...this.#facts };
  }

  get memory() {
    return this.#memory.toJSON();
  }

  get currentBranch() {
    return this.#currentBranch;
  }

  get tokenReport() {
    const historyEstimated = this.#estimateHistoryTokens();
    const limit = this.#resolvedLimit();
    const occupancy = historyEstimated;
    const prompt = this.#promptTail();
    const factsCount = Object.keys(this.#facts).length;
    return {
      id: this.id,
      name: this.name,
      model: this.model,
      historyEstimated,
      messageCount: this.#messages.length,
      promptMessageCount: prompt.length,
      summarizedCount:
        this.strategy === STRATEGY_FULL && this.compress ? this.#summarizedCount : 0,
      hasSummary:
        this.strategy === STRATEGY_FULL && this.compress && Boolean(this.#summary),
      compress: this.compress,
      compressEvery: this.compressEvery,
      strategy: this.strategy,
      window: this.window,
      factsCount,
      memory: this.#memory.counts(),
      task: this.#memory.taskContext(),
      profile: profileSnapshot(this.#profile),
      profileId: this.profileId,
      currentBranch: this.#currentBranch,
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
      compress: this.compress,
      compressEvery: this.compressEvery,
      summarizedCount:
        this.strategy === STRATEGY_FULL && this.compress ? this.#summarizedCount : 0,
      strategy: this.strategy,
      window: this.window,
      factsCount: report.factsCount,
      memory: report.memory,
      task: report.task,
      profile: report.profile,
      profileId: this.profileId,
      currentBranch: this.#currentBranch,
      tokens: report.usage.totalTokens,
      occupancy: report.occupancy,
      contextLimit: report.contextLimit,
    };
  }

  branchReport() {
    this.#syncBranch();
    const branches = Object.entries(this.#branches ?? {}).map(([name, branch]) => ({
      name,
      messages: branch.messages.length,
      current: name === this.#currentBranch,
    }));
    return {
      name: this.name,
      current: this.#currentBranch,
      checkpointCount: this.#checkpoint?.messages?.length ?? 0,
      branches,
    };
  }

  toJSON() {
    this.#syncBranch();
    return {
      id: this.id,
      name: this.name,
      model: this.model,
      systemPrompt: this.systemPrompt,
      runtime: this.runtime,
      sdkAgentId: this.sdkAgentId,
      messages: this.#messages,
      compress: this.compress,
      compressEvery: this.compressEvery,
      summary: this.#summary,
      summarizedCount: this.#summarizedCount,
      usage: { ...this.#usage },
      lastTurn: this.#lastTurn,
      contextLimit: this.contextLimitOverride,
      strategy: this.strategy,
      window: this.window,
      facts: this.#facts,
      memory: this.#memory.toJSON(),
      profileId: this.profileId,
      checkpoint: this.#checkpoint,
      branches: this.#branches,
      currentBranch: this.#currentBranch,
    };
  }

  #persist() {
    this.#onChange?.();
  }

  #resolvedLimit() {
    return contextLimit(this.model, this.contextLimitOverride);
  }

  #promptTail() {
    if (usesWindow(this.strategy)) {
      return slidingWindow(this.#messages, this.window);
    }
    if (this.strategy === STRATEGY_FULL && this.compress) {
      return promptMessages(this.#messages, this.#summarizedCount);
    }
    return this.#messages;
  }

  #contextText(extraUserText = "") {
    return this.#buildPrompt(extraUserText, { occupancy: true });
  }

  #factsBlock() {
    if (this.strategy !== STRATEGY_FACTS) return "";
    return formatFacts(this.#facts);
  }

  #summaryBlock() {
    if (this.strategy === STRATEGY_FULL && this.compress && this.#summary) {
      return `Краткое содержание предыдущего диалога:\n${this.#summary}`;
    }
    return "";
  }

  #historyLines() {
    return this.#promptTail()
      .map(
        (item) =>
          `${item.role === "user" ? "User" : "Assistant"}: ${item.content}`,
      )
      .join("\n");
  }

  #historyBlock() {
    const recent = this.#promptTail();
    if (!recent.length) return "";
    return (
      "Предыдущий диалог (продолжай с учётом этой истории, не пересказывай её):\n\n" +
      formatHistory(recent)
    );
  }

  #buildPrompt(userText, { occupancy = false } = {}) {
    const started = this.#conversationStarted && !occupancy;
    return buildPrompt({
      system: this.systemPrompt,
      profile: this.#profile,
      task: formatTaskPrompt(this.#memory.taskContext()),
      memory: this.#memory.promptBlock(),
      facts: this.#factsBlock(),
      summary: this.#summaryBlock(),
      history: occupancy ? this.#historyLines() : this.#historyBlock(),
      query: userText,
      includeSystem: occupancy || !started,
      includeMemory: occupancy || !started,
      includeHistory: occupancy || !started,
    });
  }

  #estimateHistoryTokens() {
    return estimateTokens(this.#contextText());
  }

  #estimateRequestTokens(userText) {
    return estimateTokens(this.#contextText(userText));
  }

  #compact() {
    if (this.strategy !== STRATEGY_FULL) return false;
    if (!this.compress) return false;
    const batch = pendingToSummarize(
      this.#messages,
      this.#summarizedCount,
      this.compressEvery,
    );
    if (!batch.length) return false;
    this.#summary = foldSummary(this.#summary, batch);
    this.#summarizedCount += batch.length;
    return true;
  }

  async #resetSession() {
    await this.dispose();
    this.sdkAgentId = null;
  }

  async #compactAndReset() {
    if (!this.#compact()) return false;
    await this.#resetSession();
    this.#persist();
    return true;
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

  #canResume() {
    if (!this.sdkAgentId) return false;
    if (rewritesPromptEachAsk(this.strategy)) return false;
    if (this.profileId) return false;
    if (this.#memory.hasPromptContent()) return false;
    if (isActiveTask(this.#memory.taskContext())) return false;
    if (this.strategy === STRATEGY_FULL && this.compress && this.#summary) {
      return false;
    }
    return true;
  }

  async #connect() {
    if (this.#canResume()) {
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
    this.#syncBranch();
    this.#persist();
    return this.#sdk;
  }

  async #create() {
    this.#sdk = await Agent.create(this.#sdkOptions());
    this.sdkAgentId = this.#sdk.agentId ?? null;
    this.status = "ready";
    this.#syncBranch();
    this.#persist();
    return this.#sdk;
  }

  #composePrompt(userText) {
    return this.#buildPrompt(userText, { occupancy: false });
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

  #assertIdle(action = "изменить агента") {
    if (this.status === "busy") {
      throw new Error(`Агент ${this.name} уже обрабатывает запрос, нельзя ${action}`);
    }
  }

  #syncBranch() {
    if (this.strategy !== STRATEGY_BRANCHING || !this.#currentBranch || !this.#branches) {
      return;
    }
    this.#branches[this.#currentBranch] = {
      messages: this.#messages,
      sdkAgentId: this.sdkAgentId,
    };
  }

  #trimWindow() {
    if (!usesWindow(this.strategy)) return false;
    const trimmed = slidingWindow(this.#messages, this.window);
    if (trimmed === this.#messages || trimmed.length === this.#messages.length) {
      return false;
    }
    this.#messages = trimmed;
    return true;
  }

  async setStrategy(next, { window } = {}) {
    this.#assertIdle("сменить стратегию");
    const strategy = normalizeStrategy(next);
    if (window != null) this.window = normalizeWindow(window);
    this.#syncBranch();

    if (strategy === STRATEGY_FACTS) {
      this.#facts = extractFactsFromMessages(this.#messages, this.#facts);
    }

    if (strategy === STRATEGY_BRANCHING) {
      if (this.strategy !== STRATEGY_BRANCHING) {
        this.#branches = {
          main: { messages: this.#messages, sdkAgentId: this.sdkAgentId },
        };
        this.#currentBranch = "main";
        this.#checkpoint = null;
      }
    } else {
      this.#branches = null;
      this.#currentBranch = null;
      this.#checkpoint = null;
    }

    this.strategy = strategy;
    if (usesWindow(this.strategy)) {
      this.#messages = slidingWindow(this.#messages, this.window);
    }
    await this.#resetSession();
    this.#syncBranch();
    this.#persist();
    return strategyLabel(this.strategy, {
      window: this.window,
      factsCount: Object.keys(this.#facts).length,
      currentBranch: this.#currentBranch,
    });
  }

  async setWindow(next) {
    this.#assertIdle("сменить окно");
    this.window = normalizeWindow(next);
    if (usesWindow(this.strategy) && this.#trimWindow()) {
      await this.#resetSession();
    }
    this.#syncBranch();
    this.#persist();
    return this.window;
  }

  async remember(layer, payload) {
    this.#assertIdle("записать в память");
    const result = this.#memory.remember(layer, payload);
    await this.#resetSession();
    this.#syncBranch();
    this.#persist();
    return result;
  }

  async forget(layer, opts = {}) {
    this.#assertIdle("очистить память");
    const result = this.#memory.forget(layer, opts);
    if (result.layer === MEMORY_SHORT && result.cleared === "layer") {
      this.#messages = [];
      this.#summary = "";
      this.#summarizedCount = 0;
      if (this.strategy === STRATEGY_BRANCHING && this.#currentBranch && this.#branches) {
        this.#branches[this.#currentBranch] = {
          messages: this.#messages,
          sdkAgentId: null,
        };
      }
    }
    await this.#resetSession();
    this.#syncBranch();
    this.#persist();
    return result;
  }

  async startTask(title) {
    this.#assertIdle("начать задачу");
    const result = this.#memory.startTask(title);
    await this.#resetSession();
    this.#persist();
    return result;
  }

  async setTaskPlan(items) {
    this.#assertIdle("задать план задачи");
    const context = this.#memory.setTaskPlan(items);
    await this.#resetSession();
    this.#persist();
    return context;
  }

  async approveTask() {
    this.#assertIdle("утвердить план задачи");
    const previous = this.#memory.taskContext();
    const context = this.#memory.approveTask();
    await this.#resetSession();
    this.#persist();
    return { previous, context };
  }

  async nextTaskStep(current) {
    this.#assertIdle("завершить шаг задачи");
    const context = this.#memory.nextTaskStep(current);
    await this.#resetSession();
    this.#persist();
    return context;
  }

  async transitionTask(state) {
    this.#assertIdle("сменить этап задачи");
    const previous = this.#memory.taskContext();
    const context = this.#memory.transitionTask(state);
    await this.#resetSession();
    this.#persist();
    return { previous, context };
  }

  async setTaskCurrent(current) {
    this.#assertIdle("задать текущий шаг задачи");
    const context = this.#memory.setTaskCurrent(current);
    await this.#resetSession();
    this.#persist();
    return context;
  }

  get taskContext() {
    return this.#memory.taskContext();
  }

  #taskAskResult(before, applied) {
    const context = applied?.context ?? this.#memory.taskContext();
    return {
      active: isActiveTask(before) || isActiveTask(context),
      before,
      context,
      applied: applied?.applied ?? [],
      changed: Boolean(applied?.changed),
    };
  }

  async #reloadProfile() {
    if (!this.profileId || !this.#loader) {
      this.#profile = emptyProfile();
      return this.#profile;
    }
    this.#profile = await this.#loader.load(this.profileId);
    return this.#profile;
  }

  async attachProfile(userId) {
    this.#assertIdle("подключить профиль");
    if (!this.#loader) {
      throw new Error("Хранилище профилей не подключено");
    }
    const id = parseUserId(userId, "user_id");
    this.profileId = id;
    this.#profile = await this.#loader.load(id);
    await this.#resetSession();
    this.#syncBranch();
    this.#persist();
    return this.#profile;
  }

  async detachProfile() {
    this.#assertIdle("отключить профиль");
    this.profileId = "";
    this.#profile = emptyProfile();
    await this.#resetSession();
    this.#syncBranch();
    this.#persist();
  }

  memoryReport(layer) {
    return this.#memory.format(layer);
  }

  profileReport() {
    return formatProfile(this.#profile);
  }

  checkpoint() {
    this.#assertIdle("сохранить чекпоинт");
    if (this.strategy !== STRATEGY_BRANCHING) {
      throw new Error(
        `Чекпоинт доступен при strategy=branching (сейчас ${this.strategy}). Смените: strategy ${this.name} branching`,
      );
    }
    this.#syncBranch();
    this.#checkpoint = {
      messages: cloneMessages(this.#messages),
      ts: Date.now(),
      fromBranch: this.#currentBranch,
    };
    this.#persist();
    return this.#checkpoint.messages.length;
  }

  async createBranches(nameA, nameB) {
    this.#assertIdle("создать ветки");
    if (this.strategy !== STRATEGY_BRANCHING) {
      throw new Error(
        `Ветки доступны при strategy=branching (сейчас ${this.strategy}). Смените: strategy ${this.name} branching`,
      );
    }
    const a = parseBranchName(nameA, "ветки");
    const b = parseBranchName(nameB, "ветки");
    if (a === b) {
      throw new Error("Имена веток должны различаться");
    }
    this.#syncBranch();
    const extra = Object.keys(this.#branches).filter((name) => name !== "main");
    if (extra.length) {
      throw new Error(
        `Ветки уже есть: ${extra.join(", ")}. Переключайтесь командой use.`,
      );
    }
    if (!this.#checkpoint) {
      this.#checkpoint = {
        messages: cloneMessages(this.#messages),
        ts: Date.now(),
        fromBranch: this.#currentBranch,
      };
    }
    const base = this.#checkpoint.messages;
    this.#branches[a] = { messages: cloneMessages(base), sdkAgentId: null };
    this.#branches[b] = { messages: cloneMessages(base), sdkAgentId: null };
    await this.dispose();
    this.#currentBranch = a;
    this.#messages = this.#branches[a].messages;
    this.sdkAgentId = null;
    this.#persist();
    return { current: a, branches: [a, b], checkpointCount: base.length };
  }

  async useBranch(name) {
    this.#assertIdle("переключить ветку");
    if (this.strategy !== STRATEGY_BRANCHING) {
      throw new Error(
        `Переключение веток доступно при strategy=branching (сейчас ${this.strategy})`,
      );
    }
    const branchName = parseBranchName(name, "ветки");
    this.#syncBranch();
    if (!this.#branches[branchName]) {
      const available = Object.keys(this.#branches).join(", ");
      throw new Error(`Ветка не найдена: ${branchName}. Доступны: ${available}`);
    }
    if (branchName === this.#currentBranch) {
      return branchName;
    }
    await this.dispose();
    this.#currentBranch = branchName;
    this.#messages = this.#branches[branchName].messages;
    this.sdkAgentId = this.#branches[branchName].sdkAgentId;
    this.#persist();
    return branchName;
  }

  async ask(userText) {
    const incoming = String(userText ?? "").trim();
    if (!incoming) {
      throw new Error("Пустой запрос");
    }
    if (this.status === "busy") {
      throw new Error(`Агент ${this.name} уже обрабатывает запрос`);
    }

    const directive = parseMemoryDirective(incoming);
    const text = directive.text;
    if (!text) {
      throw new Error("Пустой запрос");
    }
    if (directive.layer) {
      this.#memory.remember(directive.layer, {
        ...directive.payload,
        kind: directive.kind,
      });
      this.#persist();
    }

    if (this.strategy === STRATEGY_FACTS) {
      this.#facts = updateFacts(this.#facts, text);
    }

    if (rewritesPromptEachAsk(this.strategy) || directive.layer) {
      await this.#resetSession();
    } else {
      await this.#compactAndReset();
    }
    if (this.profileId) {
      await this.#reloadProfile();
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
      const beforeTask = cloneTaskContext(this.#memory.taskContext());
      const applied = this.#memory.applyTaskSignal(reply);
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
      this.#trimWindow();
      this.#syncBranch();
      if (this.strategy === STRATEGY_FULL && (await this.#compactAndReset())) {
        this.status = "ready";
        return { reply, tokens: this.tokenReport, task: this.#taskAskResult(beforeTask, applied) };
      }
      this.#persist();
      this.status = "ready";
      return { reply, tokens: this.tokenReport, task: this.#taskAskResult(beforeTask, applied) };
    } finally {
      if (this.status === "busy") {
        this.status = this.#sdk ? "ready" : "idle";
      }
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
