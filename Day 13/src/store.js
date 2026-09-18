import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { normalizeCompress, normalizeCompressEvery, normalizeSummarizedCount } from "./context.js";
import { normalizeMemory } from "./memory.js";
import {
  hydrateBranching,
  normalizeCheckpoint,
  normalizeFacts,
  normalizeStrategy,
  normalizeWindow,
  rewritesPromptEachAsk,
  slidingWindow,
  STRATEGY_BRANCHING,
} from "./strategy.js";
import { normalizeContextLimit, normalizeLastTurn, normalizeUsage } from "./tokens.js";

const EMPTY = { nextId: 1, agents: [] };

function normalizeMessage(item) {
  if (!item || (item.role !== "user" && item.role !== "assistant")) return null;
  const content = String(item.content ?? "");
  if (!content) return null;
  return {
    role: item.role,
    content,
    ts: Number.isFinite(item.ts) ? item.ts : Date.now(),
  };
}

function normalizeMessages(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeMessage).filter(Boolean);
}

function normalizeBranchMap(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  const out = {};
  for (const [name, branch] of Object.entries(row)) {
    const key = String(name ?? "").trim();
    if (!key) continue;
    out[key] = {
      messages: normalizeMessages(branch?.messages),
      sdkAgentId: branch?.sdkAgentId ? String(branch.sdkAgentId) : null,
    };
  }
  return Object.keys(out).length ? out : null;
}

function normalizeAgent(row) {
  if (!row || row.id == null || !row.name) return null;
  const messages = normalizeMessages(row.messages);
  const summary = typeof row.summary === "string" ? row.summary : "";
  const compress = normalizeCompress(row.compress, {
    legacy: row.compress === undefined,
  });
  const strategy = normalizeStrategy(row.strategy);
  const windowSize = normalizeWindow(row.window);
  const facts = normalizeFacts(row.facts);
  let sdkAgentId =
    (compress && summary) || rewritesPromptEachAsk(strategy)
      ? null
      : row.sdkAgentId
        ? String(row.sdkAgentId)
        : null;
  let storedMessages = messages;
  let branches = null;
  let currentBranch = null;
  let checkpoint = normalizeCheckpoint(
    row.checkpoint
      ? { ...row.checkpoint, messages: normalizeMessages(row.checkpoint.messages) }
      : null,
  );

  if (strategy === STRATEGY_BRANCHING) {
    const hydrated = hydrateBranching({
      messages,
      sdkAgentId,
      branches: normalizeBranchMap(row.branches),
      currentBranch: row.currentBranch,
      checkpoint,
    });
    storedMessages = hydrated.messages;
    sdkAgentId = hydrated.sdkAgentId;
    branches = hydrated.branches;
    currentBranch = hydrated.currentBranch;
    checkpoint = hydrated.checkpoint;
  } else if (rewritesPromptEachAsk(strategy)) {
    storedMessages = slidingWindow(messages, windowSize);
  }

  return {
    id: String(row.id),
    name: String(row.name),
    model: String(row.model ?? ""),
    systemPrompt: String(row.systemPrompt ?? ""),
    runtime: row.runtime === "cloud" ? "cloud" : "local",
    sdkAgentId,
    messages: storedMessages,
    compress,
    compressEvery: normalizeCompressEvery(row.compressEvery),
    summary,
    summarizedCount:
      compress && summary
        ? normalizeSummarizedCount(row.summarizedCount, storedMessages.length)
        : 0,
    usage: normalizeUsage(row.usage),
    lastTurn: normalizeLastTurn(row.lastTurn),
    contextLimit: normalizeContextLimit(row.contextLimit),
    strategy,
    window: windowSize,
    facts,
    memory: normalizeMemory(row.memory),
    profileId: String(row.profileId ?? "").trim(),
    checkpoint,
    branches,
    currentBranch,
  };
}

export function loadState(filePath) {
  try {
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    const agents = Array.isArray(data?.agents)
      ? data.agents.map(normalizeAgent).filter(Boolean)
      : [];
    let nextId = Number.isInteger(data?.nextId) && data.nextId >= 1 ? data.nextId : 1;
    for (const agent of agents) {
      const n = Number(agent.id);
      if (Number.isInteger(n) && n >= nextId) nextId = n + 1;
    }
    return { nextId, agents };
  } catch (err) {
    if (err?.code === "ENOENT") return { ...EMPTY, agents: [] };
    throw new Error(`Не удалось прочитать историю ${filePath}: ${err.message}`);
  }
}

export function saveState(filePath, state) {
  mkdirSync(dirname(filePath), { recursive: true });
  const payload = {
    nextId: state.nextId,
    agents: state.agents,
  };
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tmp, filePath);
}
