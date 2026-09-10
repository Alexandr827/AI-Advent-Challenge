import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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

function normalizeAgent(row) {
  if (!row || row.id == null || !row.name) return null;
  return {
    id: String(row.id),
    name: String(row.name),
    model: String(row.model ?? ""),
    systemPrompt: String(row.systemPrompt ?? ""),
    runtime: row.runtime === "cloud" ? "cloud" : "local",
    sdkAgentId: row.sdkAgentId ? String(row.sdkAgentId) : null,
    messages: Array.isArray(row.messages)
      ? row.messages.map(normalizeMessage).filter(Boolean)
      : [],
    usage: normalizeUsage(row.usage),
    lastTurn: normalizeLastTurn(row.lastTurn),
    contextLimit: normalizeContextLimit(row.contextLimit),
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
