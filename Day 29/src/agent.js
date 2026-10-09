import { resolve } from "node:path";
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
  emptyInvariantSet,
  formatInvariantSet,
  formatInvariantsPrompt,
  formatViolationsPrompt,
  InvariantLoader,
  invariantSnapshot,
  parseSetId,
  runInvariantPipeline,
} from "./invariant.js";
import {
  cloneTaskContext,
  formatTaskPrompt,
  isActiveTask,
  validateStageResponse,
} from "./task.js";
import { connectMcp, connectNamedMcp } from "./mcp-client.js";
import {
  formatMcpAskReply,
  parseAskMcpRequest,
  planMcpFromAsk,
  runAskMcpRequest,
} from "./mcp-pipeline.js";
import { planOrchestration, runOrchestration } from "./mcp-orchestrator.js";
import { collectRunEvents, emptyToolLog } from "./mcp-trace.js";
import { answerWithRag, fitLawHits, lawSources, retrieveLawContext } from "./doc-index/rag.js";
import { buildChatPrompt, emptyChatState, normalizeChatState, runChatTurn } from "./rag-chat.js";
import {
  completeChat,
  DEFAULT_LMSTUDIO_MODEL,
  lawGenerationProfile,
  normalizeLawProfile,
  RAG_LMSTUDIO_MAX_TOKENS,
} from "./lmstudio.js";

const WARN_RATIO = 0.8;

function isMcpKeyExchangeError(err) {
  const message = String(err?.message ?? err);
  return /key exchange/i.test(message) || /mcp tool \[unknown\]/i.test(message);
}

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
  #invariantLoader;
  #invariants;
  #retrieveLaw;
  #lawIndexPath;
  #chat;
  #chatComplete;
  #callOverride;

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
    invariantSetId,
    invariantLoader,
    onChange,
    retrieveLaw,
    lawIndexPath,
    chat,
    chatComplete,
    lawProfile,
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
    this.invariantSetId = String(invariantSetId ?? "").trim();
    this.#invariantLoader =
      invariantLoader instanceof InvariantLoader ? invariantLoader : null;
    this.#invariants =
      this.#invariantLoader?.tryLoad(this.invariantSetId) ?? emptyInvariantSet();
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
    this.#retrieveLaw = typeof retrieveLaw === "function" ? retrieveLaw : null;
    this.#lawIndexPath =
      lawIndexPath ?? resolve(cwd, "data", "doc-index", "law.sqlite");
    this.#chat = normalizeChatState(chat);
    this.#chatComplete = typeof chatComplete === "function" ? chatComplete : completeChat;
    this.lawProfile = normalizeLawProfile(lawProfile);
    this.finishReason = null;
    this.retried = false;
    this.#callOverride = null;
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

  get chatState() {
    return normalizeChatState(this.#chat);
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
      invariants: invariantSnapshot(this.#invariants),
      invariantSetId: this.invariantSetId,
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
      invariants: report.invariants,
      invariantSetId: this.invariantSetId,
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
      invariantSetId: this.invariantSetId,
      checkpoint: this.#checkpoint,
      branches: this.#branches,
      currentBranch: this.#currentBranch,
      chat: this.#chat,
      lawProfile: this.lawProfile,
    };
  }

  #persist() {
    this.#onChange?.();
  }

  #beginCall(options = {}) {
    const temperature = options?.temperature;
    const maxTokens = options?.maxTokens;
    const contextWindow = options?.contextWindow;
    const set = temperature != null || maxTokens != null || contextWindow != null;
    if (!set) {
      this.#callOverride = null;
      return;
    }
    if (this.runtime !== "lmstudio") {
      throw new Error(
        "--temperature, --max-tokens и --context задаются только для локальной модели (runtime=lmstudio)",
      );
    }
    this.#callOverride = {
      temperature: temperature ?? null,
      maxTokens: maxTokens ?? null,
      contextWindow: contextWindow ?? null,
    };
  }

  #resolvedLimit() {
    const fromCall = normalizeContextLimit(this.#callOverride?.contextWindow);
    if (fromCall != null) return fromCall;
    return contextLimit(this.model, this.contextLimitOverride);
  }

  #limitLabel() {
    if (normalizeContextLimit(this.#callOverride?.contextWindow) != null) return "окно запроса";
    return contextLimitLabel(this.model, this.contextLimitOverride);
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

  #contextText(extraUserText = "", extra = {}) {
    return this.#buildPrompt(extraUserText, { occupancy: true, ...extra });
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

  #buildPrompt(userText, { occupancy = false, violations = [], law = "" } = {}) {
    const started =
      this.runtime !== "lmstudio" && this.#conversationStarted && !occupancy;
    return buildPrompt({
      system: this.systemPrompt,
      invariants: formatInvariantsPrompt(this.#invariants),
      profile: this.#profile,
      task: formatTaskPrompt(this.#memory.taskContext()),
      memory: this.#memory.promptBlock(),
      facts: this.#factsBlock(),
      summary: this.#summaryBlock(),
      history: occupancy ? this.#historyLines() : this.#historyBlock(),
      query: userText,
      violations: formatViolationsPrompt(violations),
      law,
      includeSystem: occupancy || !started,
      includeMemory: occupancy || !started,
      includeHistory: occupancy || !started,
    });
  }

  #collectLawHits(text, { mode = "filtered" } = {}) {
    try {
      const hits = this.#retrieveLaw
        ? this.#retrieveLaw(text)
        : retrieveLawContext(text, { indexPath: this.#lawIndexPath, mode }).hits;
      return Array.isArray(hits) ? hits : [];
    } catch (err) {
      console.error(`Индекс закона недоступен: ${err.message}`);
      return [];
    }
  }

  #estimateHistoryTokens() {
    return estimateTokens(this.#contextText());
  }

  #estimateRequestTokens(userText, extra = {}) {
    if (extra.chatPrompt) return estimateTokens(String(userText ?? ""));
    return estimateTokens(this.#contextText(userText, extra));
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
    const base = {
      apiKey: this.apiKey,
      model: { id: this.model },
      name: this.name,
    };
    if (this.runtime === "cloud") {
      return { ...base, tools: [], cloud: { repos: [] } };
    }
    return {
      ...base,
      tools: [],
      local: { cwd: this.cwd },
    };
  }

  async start() {
    if (this.runtime === "lmstudio") {
      if (this.status !== "busy") this.status = "ready";
      return null;
    }
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
    if (this.invariantSetId) return false;
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

  #composePrompt(userText, extra = {}) {
    if (extra.chatPrompt) return String(userText ?? "");
    return this.#buildPrompt(userText, { occupancy: false, ...extra });
  }

  #assertFits(requestTokens) {
    const limit = this.#resolvedLimit();
    if (requestTokens > limit) {
      throw new ContextOverflowError(
        `Переполнение контекста: запрос ~${requestTokens} токенов > лимит ${limit}` +
          ` (${this.#limitLabel()})`,
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

  async #reloadInvariants() {
    if (!this.invariantSetId || !this.#invariantLoader) {
      this.#invariants = emptyInvariantSet();
      return this.#invariants;
    }
    this.#invariants = await this.#invariantLoader.load(this.invariantSetId);
    return this.#invariants;
  }

  async attachInvariants(setId) {
    this.#assertIdle("подключить инварианты");
    if (!this.#invariantLoader) {
      throw new Error("Хранилище инвариантов не подключено");
    }
    const id = parseSetId(setId, "set_id");
    this.invariantSetId = id;
    this.#invariants = await this.#invariantLoader.load(id);
    await this.#resetSession();
    this.#syncBranch();
    this.#persist();
    return this.#invariants;
  }

  async detachInvariants() {
    this.#assertIdle("отключить инварианты");
    this.invariantSetId = "";
    this.#invariants = emptyInvariantSet();
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

  invariantReport() {
    return formatInvariantSet(this.#invariants);
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

  async #sendOnce(userText, extra = {}) {
    const requestEstimated = this.#estimateRequestTokens(userText, extra);
    this.#assertFits(requestEstimated);
    if (this.runtime === "lmstudio") {
      return this.#sendLocal(userText, extra, requestEstimated);
    }
    let result;
    let tools = emptyToolLog();
    try {
      const run = await this.#sdk.send(this.#composePrompt(userText, extra));
      try {
        tools = await collectRunEvents(run);
      } catch (streamErr) {
        if (run.supports("wait")) {
          try {
            await run.wait();
          } catch {
            // терминальный статус уже недоступен, наружу уходит ошибка потока
          }
        }
        throw streamErr;
      }
      result = await run.wait();
      tools.runId = result.id ?? run.id ?? null;
    } catch (err) {
      if (!extra.mcpRetried && isMcpKeyExchangeError(err)) {
        await this.#dropSdkSession();
        return this.#sendOnce(userText, { ...extra, mcpRetried: true });
      }
      throw this.#wrapOverflow(err, requestEstimated);
    }
    if (!extra.chatPrompt) this.#conversationStarted = true;
    if (result.status === "error") {
      const failure = new Error(result.error?.message ?? "unknown");
      if (!extra.mcpRetried && isMcpKeyExchangeError(failure)) {
        await this.#dropSdkSession();
        return this.#sendOnce(userText, { ...extra, mcpRetried: true });
      }
      throw this.#wrapOverflow(failure, requestEstimated);
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
      reasoningTokens: billed ? billed.reasoningTokens : 0,
    };
    this.#usage = addUsage(this.#usage, turnUsage);
    return { result, reply, tools };
  }

  #lawTokenBudget(bareTokens) {
    return this.#resolvedLimit() - RAG_LMSTUDIO_MAX_TOKENS - bareTokens - 32;
  }

  #fitLocalLaw(query, hits) {
    const bare = Math.max(
      estimateTokens(this.#composePrompt(query, { law: "" })),
      this.#estimateRequestTokens(query, { law: "" }),
    );
    return fitLawHits(hits, { budgetTokens: this.#lawTokenBudget(bare) });
  }

  #fitChatLaw(hits, { state, history, query }) {
    const shell = buildChatPrompt({ state, history, query, hits: [] });
    return fitLawHits(hits, { budgetTokens: this.#lawTokenBudget(estimateTokens(shell)) });
  }

  async #completeLaw(prompt) {
    const profile = lawGenerationProfile(this.lawProfile);
    const temperature = this.#callOverride?.temperature ?? profile.temperature;
    const maxTokens = this.#callOverride?.maxTokens ?? profile.maxTokens;
    const messages = [{ role: "user", content: prompt }];
    const system = String(this.systemPrompt ?? "").trim() || profile.systemPrompt;
    if (system) messages.unshift({ role: "system", content: system });
    const once = (limit) =>
      this.#chatComplete({
        model: this.model || DEFAULT_LMSTUDIO_MODEL,
        messages,
        temperature,
        maxTokens: limit,
        enableThinking: false,
      });
    const explicitCap = this.#callOverride?.maxTokens != null;
    const canRetry =
      !explicitCap &&
      Number.isInteger(profile.retryMaxTokens) &&
      profile.retryMaxTokens > maxTokens;
    try {
      const first = await once(maxTokens);
      if (first?.finishReason === "length" && canRetry) {
        const second = await once(profile.retryMaxTokens);
        return { ...second, retried: true };
      }
      return { ...first, retried: false };
    } catch (err) {
      if (canRetry && /max_tokens|бюджет/.test(String(err?.message ?? ""))) {
        const second = await once(profile.retryMaxTokens);
        return { ...second, retried: true };
      }
      throw err;
    }
  }

  async #sendLocal(userText, extra, requestEstimated) {
    const rag = Boolean(String(extra.law ?? "").trim()) || extra.chatPrompt === true;
    const savedSystem = this.systemPrompt;
    const liftSystem = rag && String(savedSystem ?? "").trim();
    if (liftSystem) this.systemPrompt = "";
    let prompt;
    try {
      prompt = this.#composePrompt(userText, extra);
    } finally {
      if (liftSystem) this.systemPrompt = savedSystem;
    }
    let completion;
    try {
      completion = rag
        ? await this.#completeLaw(prompt)
        : await this.#chatComplete({
            model: this.model || DEFAULT_LMSTUDIO_MODEL,
            prompt,
            ...(this.#callOverride?.temperature != null
              ? { temperature: this.#callOverride.temperature }
              : {}),
            ...(this.#callOverride?.maxTokens != null
              ? { maxTokens: this.#callOverride.maxTokens }
              : {}),
          });
    } catch (err) {
      throw this.#wrapOverflow(err, requestEstimated);
    }
    const reply = String(completion?.content ?? "");
    const responseEstimated = estimateTokens(reply);
    const billed = fromSdkUsage(completion?.usage);
    const turnUsage = billed ?? {
      ...emptyUsage(),
      inputTokens: requestEstimated,
      outputTokens: responseEstimated,
      totalTokens: requestEstimated + responseEstimated,
    };
    this.finishReason = completion?.finishReason ?? null;
    this.retried = Boolean(completion?.retried);
    this.#lastTurn = {
      requestEstimated,
      requestBilled: billed ? billed.inputTokens : null,
      responseEstimated,
      responseBilled: billed ? billed.outputTokens : null,
      billedReported: Boolean(billed),
      reasoningTokens: billed ? billed.reasoningTokens : 0,
    };
    this.#usage = addUsage(this.#usage, turnUsage);
    return {
      result: { status: "finished", result: reply },
      reply,
      tools: emptyToolLog(),
      finishReason: this.finishReason,
      retried: Boolean(completion?.retried),
    };
  }

  async #dropSdkSession() {
    await this.dispose();
    this.sdkAgentId = null;
    await this.start();
  }

  async #answerWithMcpSteps(text, { failMessage, run }) {
    if (this.runtime === "cloud") {
      throw new Error("mcp-tool в ask доступен только при runtime=local");
    }
    this.status = "busy";
    const toolLog = emptyToolLog();
    let cleanup;
    try {
      const outcome = await run();
      cleanup = outcome.cleanup;
      const runResult = outcome.result;
      for (const step of runResult.steps) {
        toolLog.calls.push({
          name: "mcp",
          server: step.server,
          tool: step.name,
          arguments: step.arguments,
          status: step.isError ? "error" : "completed",
          resultText: step.text,
          isError: step.isError,
        });
      }
      const reply = formatMcpAskReply(runResult.steps);
      if (!runResult.ok) {
        throw new Error(reply.trim() || failMessage);
      }
      this.#messages.push(
        { role: "user", content: text, ts: Date.now() },
        { role: "assistant", content: reply, ts: Date.now() },
      );
      this.#persist();
      this.status = "ready";
      const before = cloneTaskContext(this.#memory.taskContext());
      return {
        reply,
        tokens: this.tokenReport,
        task: this.#taskAskResult(before, {
          context: before,
          applied: [],
          changed: false,
        }),
        invariants: null,
        tools: toolLog,
      };
    } finally {
      await cleanup?.();
      if (this.status === "busy") this.status = this.#sdk ? "ready" : "idle";
    }
  }

  async #answerWithMcpTools(text, request) {
    return this.#answerWithMcpSteps(text, {
      failMessage: "mcp-tool завершился с ошибкой",
      run: async () => {
        const client = await connectMcp({ cwd: this.cwd });
        try {
          const result = await runAskMcpRequest(request, (req) =>
            client.callTool(req),
          );
          return {
            result,
            cleanup: async () => {
              await client.close();
            },
          };
        } catch (err) {
          await client.close();
          throw err;
        }
      },
    });
  }

  async #answerWithOrchestration(text, plan) {
    const clients = new Map();
    return this.#answerWithMcpSteps(text, {
      failMessage: "оркестрация MCP завершилась с ошибкой",
      run: async () => {
        const callTool = async (req) => {
          let client = clients.get(req.server);
          if (!client) {
            client = await connectNamedMcp(req.server, this.cwd);
            clients.set(req.server, client);
          }
          return client.callTool({ name: req.name, arguments: req.arguments });
        };
        const result = await runOrchestration(plan, callTool);
        return {
          result,
          cleanup: async () => {
            for (const client of clients.values()) {
              await client.close();
            }
          },
        };
      },
    });
  }

  clearChat() {
    this.#assertIdle("очистить мини-чат");
    this.#chat = emptyChatState();
    this.#persist();
    return this.chatState;
  }

  async #generateChat(prompt) {
    await this.#resetSession();
    await this.start();
    try {
      const sent = await this.#sendOnce(prompt, { chatPrompt: true });
      return sent.reply;
    } finally {
      await this.#resetSession();
    }
  }

  async chat(userText, options = {}) {
    const text = String(userText ?? "").trim();
    if (!text) throw new Error("Пустой запрос");
    this.#assertIdle("продолжить мини-чат");
    this.#beginCall(options);
    this.status = "busy";
    try {
      const result = await runChatTurn(this.#chat, text, {
        retrieve: (query) => this.#collectLawHits(query, { mode: "filtered" }),
        fitHits:
          this.runtime === "lmstudio"
            ? (hits, ctx) => this.#fitChatLaw(hits, ctx)
            : undefined,
        generate: ({ prompt }) => this.#generateChat(prompt),
      });
      this.#chat = result.state;
      this.#persist();
      this.status = "ready";
      return {
        reply: result.reply,
        state: result.state,
        sources: result.sources,
        quotes: result.quotes,
        abstained: result.abstained,
        tokens: this.tokenReport,
        finishReason: this.finishReason,
        retried: this.retried,
      };
    } finally {
      this.#callOverride = null;
      if (this.status === "busy") this.status = this.#sdk ? "ready" : "idle";
    }
  }

  /**
   * Порядок обработки одного ask (если не сработал более ранний путь):
   * 1) префикс /short|/working|/long — запись в память;
   * 2) оркестрация (погода, часы, brief) — без флага --mcp, если текст подходит;
   * 3) MCP-пайплайн фичи (--mcp или «mcp-tool» в тексте);
   * 4) RAG по 38-ФЗ при options.rag (--filter включает rewrite + rerank);
   * 5) ответ модели: runtime=lmstudio — локальный POST /v1/chat/completions, иначе Cursor SDK (tools: []).
   */
  async ask(userText, options = {}) {
    const incoming = String(userText ?? "").trim();
    if (!incoming) {
      throw new Error("Пустой запрос");
    }
    if (this.status === "busy") {
      throw new Error(`Агент ${this.name} уже обрабатывает запрос`);
    }
    this.#beginCall(options);
    try {
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

    const mcpOn =
      options.mcp === true || (options.mcp !== false && Boolean(parseAskMcpRequest(text)));
    if (options.mcp !== false && !parseAskMcpRequest(text)) {
      const orchestration = planOrchestration(text);
      if (orchestration?.steps?.length) {
        return await this.#answerWithOrchestration(text, orchestration);
      }
      if (options.mcp === true && orchestration?.error) {
        throw new Error(orchestration.error);
      }
    }
    const mcpRequest = planMcpFromAsk(text, { mcp: mcpOn });
    if (mcpRequest?.error) {
      throw new Error(mcpRequest.error);
    }
    if (mcpRequest?.tools?.length) {
      return await this.#answerWithMcpTools(text, mcpRequest);
    }

    if (options.rag === true) {
      const mode = options.ragMode === "plain" ? "plain" : "filtered";
      let payload;
      const rawHits = this.#collectLawHits(text, { mode });
      const fitted =
        this.runtime === "lmstudio"
          ? this.#fitLocalLaw(text, rawHits)
          : { hits: rawHits, dropped: 0, shortened: false };
      const fit = { dropped: fitted.dropped ?? 0, shortened: Boolean(fitted.shortened) };
      const result = await answerWithRag(text, {
        retrieve: () => fitted.hits,
        generate: async ({ query, law, hits }) => {
          payload = await this.#answerFromModel(query, { law, lawHits: hits, directive });
          return payload.reply;
        },
      });
      if (result.abstained) {
        return this.#lawTurn(text, result.reply, {
          sources: [],
          quotes: [],
          abstained: true,
          fit,
        });
      }
      payload.reply = result.reply;
      payload.law = {
        sources: result.sources,
        quotes: result.quotes,
        abstained: false,
        fit,
      };
      this.#replaceLastAssistant(result.reply);
      return payload;
    }
    return await this.#answerFromModel(text, { law: "", lawHits: [], directive });
    } finally {
      this.#callOverride = null;
    }
  }

  #replaceLastAssistant(reply) {
    const last = this.#messages[this.#messages.length - 1];
    if (last?.role === "assistant") last.content = reply;
  }

  #lawTurn(text, reply, law) {
    this.#messages.push(
      { role: "user", content: text, ts: Date.now() },
      { role: "assistant", content: reply, ts: Date.now() },
    );
    this.#trimWindow();
    this.#syncBranch();
    this.#persist();
    const before = cloneTaskContext(this.#memory.taskContext());
    return {
      reply,
      tokens: this.tokenReport,
      task: this.#taskAskResult(before, {
        context: before,
        applied: [],
        changed: false,
      }),
      invariants: null,
      tools: emptyToolLog(),
      law,
    };
  }

  async #answerFromModel(text, { law = "", lawHits = [], directive }) {
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
    if (this.invariantSetId) {
      await this.#reloadInvariants();
    }
    const requestEstimated = this.#estimateRequestTokens(text, { law });
    this.#assertFits(requestEstimated);

    await this.start();
    this.status = "busy";
    try {
      const beforeTask = cloneTaskContext(this.#memory.taskContext());
      const toolLog = emptyToolLog();
      let finishReason = null;
      let retried = false;
      const pipeline = await runInvariantPipeline({
        invariants: this.#invariants?.items ?? [],
        extraValidate: (response) => validateStageResponse(response, beforeTask),
        query: text,
        buildPrompt: ({ query, violations }) => ({ query, violations }),
        generate: async ({ query, violations }) => {
          if (violations?.length) {
            await this.#resetSession();
            await this.start();
          }
          const sent = await this.#sendOnce(query, { violations, law });
          finishReason = sent.finishReason ?? null;
          retried = Boolean(sent.retried);
          if (sent.tools.offered?.length) toolLog.offered = sent.tools.offered;
          toolLog.calls.push(...sent.tools.calls);
          toolLog.runId = sent.tools.runId ?? toolLog.runId;
          return sent.reply;
        },
      });
      const reply = pipeline.response;
      const applied = pipeline.refused
        ? { context: beforeTask, applied: [], changed: false }
        : this.#memory.applyTaskSignal(reply);
      this.#messages.push(
        { role: "user", content: text, ts: Date.now() },
        { role: "assistant", content: reply, ts: Date.now() },
      );
      this.#trimWindow();
      this.#syncBranch();
      const payload = {
        reply,
        tokens: this.tokenReport,
        task: this.#taskAskResult(beforeTask, applied),
        invariants: pipeline,
        tools: toolLog,
        law: lawHits.length
          ? { sources: lawSources(lawHits), quotes: [], abstained: false }
          : null,
        finishReason,
        retried,
      };
      if (this.strategy === STRATEGY_FULL && (await this.#compactAndReset())) {
        this.status = "ready";
        return payload;
      }
      this.#persist();
      this.status = "ready";
      return payload;
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
