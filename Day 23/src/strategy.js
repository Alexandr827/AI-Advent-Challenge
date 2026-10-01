export const STRATEGY_FULL = "full";
export const STRATEGY_SLIDING = "sliding";
export const STRATEGY_FACTS = "facts";
export const STRATEGY_BRANCHING = "branching";

export const STRATEGIES = [
  STRATEGY_FULL,
  STRATEGY_SLIDING,
  STRATEGY_FACTS,
  STRATEGY_BRANCHING,
];

export const DEFAULT_WINDOW = 8;
export const MIN_WINDOW = 2;

const STRATEGY_ALIASES = {
  full: STRATEGY_FULL,
  none: STRATEGY_FULL,
  off: STRATEGY_FULL,
  sliding: STRATEGY_SLIDING,
  window: STRATEGY_SLIDING,
  "sliding-window": STRATEGY_SLIDING,
  facts: STRATEGY_FACTS,
  sticky: STRATEGY_FACTS,
  memory: STRATEGY_FACTS,
  "key-value": STRATEGY_FACTS,
  kv: STRATEGY_FACTS,
  branching: STRATEGY_BRANCHING,
  branches: STRATEGY_BRANCHING,
  branch: STRATEGY_BRANCHING,
};

const KEY_ALIASES = {
  цель: "цель",
  goal: "цель",
  задача: "цель",
  target: "цель",
  ограничения: "ограничения",
  ограничение: "ограничения",
  constraint: "ограничения",
  constraints: "ограничения",
  предпочтения: "предпочтения",
  предпочтение: "предпочтения",
  предпочитаю: "предпочтения",
  preference: "предпочтения",
  preferences: "предпочтения",
  решения: "решения",
  решение: "решения",
  decision: "решения",
  decisions: "решения",
  договорённости: "договорённости",
  договоренности: "договорённости",
  договорённость: "договорённости",
  договоренность: "договорённости",
  agreement: "договорённости",
  agreements: "договорённости",
  заметки: "заметки",
  note: "заметки",
  notes: "заметки",
};

const APPEND_KEYS = new Set([
  "ограничения",
  "предпочтения",
  "договорённости",
  "заметки",
]);

export function parseStrategy(raw, flag = "--strategy") {
  const key = String(raw ?? "")
    .trim()
    .toLowerCase();
  const strategy = STRATEGY_ALIASES[key];
  if (!strategy) {
    throw new Error(
      `${flag} должен быть sliding, facts, branching или full`,
    );
  }
  return strategy;
}

export function normalizeStrategy(value) {
  if (value == null || value === "") return STRATEGY_FULL;
  if (typeof value !== "string") return STRATEGY_FULL;
  const key = value.trim().toLowerCase();
  return STRATEGY_ALIASES[key] ?? STRATEGY_FULL;
}

export function parseWindow(raw, flag = "--window") {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_WINDOW) {
    throw new Error(`${flag} должен быть целым числом >= ${MIN_WINDOW}`);
  }
  return n;
}

export function normalizeWindow(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= MIN_WINDOW ? n : DEFAULT_WINDOW;
}

export function envStrategy() {
  const raw = process.env.CURSOR_STRATEGY?.trim();
  if (!raw) return STRATEGY_FULL;
  try {
    return parseStrategy(raw, "CURSOR_STRATEGY");
  } catch {
    return STRATEGY_FULL;
  }
}

export function envWindow() {
  const raw = process.env.CURSOR_WINDOW?.trim();
  if (!raw) return DEFAULT_WINDOW;
  const n = Number(raw);
  return Number.isInteger(n) && n >= MIN_WINDOW ? n : DEFAULT_WINDOW;
}

export function resolveStrategyConfig({ strategy, window } = {}) {
  const resolved =
    strategy != null && strategy !== ""
      ? parseStrategy(strategy)
      : envStrategy();
  const win = window != null ? normalizeWindow(window) : envWindow();
  return { strategy: resolved, window: win };
}

export function usesWindow(strategy) {
  return strategy === STRATEGY_SLIDING || strategy === STRATEGY_FACTS;
}

export function rewritesPromptEachAsk(strategy) {
  return usesWindow(strategy);
}

export function slidingWindow(messages, windowSize = DEFAULT_WINDOW) {
  const list = Array.isArray(messages) ? messages : [];
  const n = normalizeWindow(windowSize);
  if (list.length <= n) return list;
  return list.slice(-n);
}

export function cloneMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((item) => ({
    role: item.role,
    content: item.content,
    ts: item.ts,
  }));
}

export function normalizeFacts(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return {};
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(row)) {
    const key = String(rawKey ?? "").trim();
    const value = String(rawValue ?? "").trim();
    if (key && value) out[key] = value;
  }
  return out;
}

function canonicalKey(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "";
  const alias = KEY_ALIASES[trimmed.toLowerCase()];
  return alias ?? trimmed;
}

function setFact(facts, key, value) {
  const k = canonicalKey(key);
  const v = String(value ?? "")
    .trim()
    .replace(/^[«"]|[»"]$/g, "")
    .replace(/[.?!]+$/u, "")
    .trim();
  if (!k || !v) return;
  if (APPEND_KEYS.has(k) && facts[k]) {
    if (facts[k].includes(v)) return;
    if (v.includes(facts[k])) {
      facts[k] = v;
      return;
    }
    facts[k] = `${facts[k]}; ${v}`;
    return;
  }
  facts[k] = v;
}

function applyExplicitPairs(facts, text) {
  const keyRe =
    /([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9_-]{0,39})\s*[:=]\s*/gu;
  const matches = [...text.matchAll(keyRe)];
  for (let i = 0; i < matches.length; i++) {
    const key = matches[i][1].trim();
    if (/^https?$/i.test(key)) continue;
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const value = clipCueValue(text.slice(start, end));
    setFact(facts, key, value);
  }
}

function clipCueValue(value) {
  return String(value ?? "")
    .split(/(?<=[.!?])\s+(?=[A-Za-zА-Яа-яЁё])/)[0]
    .trim();
}

function applyCues(facts, text) {
  const cues = [
    ["цель", /(?:^|[.!?]\s+)(?:моя\s+)?цель(?:\s+(?:проекта|диалога))?\s*[:—-]\s*(.+)$/imu],
    ["цель", /(?:^|[.!?]\s+)я хочу(?: бы)?\s+(.+)$/imu],
    ["цель", /(?:^|[.!?]\s+)(?:мне\s+)?нужно\s+(.+)$/imu],
    ["ограничения", /(?:^|[.!?]\s+)ограничен(?:ие|ия)\s*[:—-]\s*(.+)$/imu],
    ["ограничения", /(?:^|[.!?]\s+)не (?:используй|использовать|надо(?:\s+использовать)?)\s+(.+)$/imu],
    ["предпочтения", /(?:^|[.!?]\s+)предпочитаю\s+(.+)$/imu],
    ["решения", /(?:^|[.!?]\s+)(?:мы\s+)?(?:решили|выбрали)\s+(.+)$/imu],
    ["решения", /(?:^|[.!?]\s+)решение\s*[:—-]\s*(.+)$/imu],
    ["договорённости", /(?:^|[.!?]\s+)договорились(?:\s+что)?\s+(.+)$/imu],
  ];
  for (const [key, re] of cues) {
    const match = text.match(re);
    if (match?.[1]) setFact(facts, key, clipCueValue(match[1]));
  }

  const remember = text.match(
    /(?:^|[.!?]\s+)запомни(?:те)?(?:\s*,?\s*что)?\s+(.+)$/imu,
  );
  if (remember?.[1]) {
    const chunk = clipCueValue(remember[1]);
    if (/[:=]/.test(chunk)) applyExplicitPairs(facts, chunk);
    else setFact(facts, "заметки", chunk);
  }
}

export function updateFacts(facts, userText) {
  const next = normalizeFacts(facts);
  const text = String(userText ?? "").trim();
  if (!text) return next;
  applyCues(next, text);
  applyExplicitPairs(next, text);
  return next;
}

export function extractFactsFromMessages(messages, facts = {}) {
  let next = normalizeFacts(facts);
  for (const item of Array.isArray(messages) ? messages : []) {
    if (item?.role === "user") {
      next = updateFacts(next, item.content);
    }
  }
  return next;
}

export function formatFacts(facts) {
  const entries = Object.entries(normalizeFacts(facts));
  if (!entries.length) return "";
  const lines = entries.map(([key, value]) => `- ${key}: ${value}`);
  return (
    "Известные факты диалога (придерживайся их; не противоречь без новой договорённости):\n" +
    lines.join("\n")
  );
}

export function formatFactsList(facts) {
  const entries = Object.entries(normalizeFacts(facts));
  if (!entries.length) return "Факты пусты.";
  return entries.map(([key, value]) => `  ${key}: ${value}`).join("\n");
}

export function parseBranchName(raw, label = "ветки") {
  const name = String(raw ?? "").trim();
  if (!name) {
    throw new Error(`Имя ${label} не может быть пустым`);
  }
  if (/\s/.test(name)) {
    throw new Error(`Имя ${label} не должно содержать пробелы: ${name}`);
  }
  if (name.startsWith("--")) {
    throw new Error(`Недопустимое имя ${label}: ${name}`);
  }
  return name;
}

export function normalizeCheckpoint(row) {
  if (!row || typeof row !== "object") return null;
  const messages = Array.isArray(row.messages) ? cloneMessages(row.messages) : [];
  if (!messages.length && row.messages != null && !Array.isArray(row.messages)) {
    return null;
  }
  return {
    messages,
    ts: Number.isFinite(row.ts) ? row.ts : Date.now(),
    fromBranch: row.fromBranch ? String(row.fromBranch) : null,
  };
}

export function hydrateBranching({
  messages = [],
  sdkAgentId = null,
  branches = null,
  currentBranch = null,
  checkpoint = null,
} = {}) {
  const normalized = {};
  if (branches && typeof branches === "object" && !Array.isArray(branches)) {
    for (const [name, branch] of Object.entries(branches)) {
      const key = String(name ?? "").trim();
      if (!key) continue;
      normalized[key] = {
        messages: cloneMessages(branch?.messages),
        sdkAgentId: branch?.sdkAgentId ? String(branch.sdkAgentId) : null,
      };
    }
  }
  if (!Object.keys(normalized).length) {
    normalized.main = {
      messages: cloneMessages(messages),
      sdkAgentId: sdkAgentId ? String(sdkAgentId) : null,
    };
  }
  const current =
    currentBranch && normalized[currentBranch]
      ? currentBranch
      : Object.keys(normalized)[0];
  return {
    branches: normalized,
    currentBranch: current,
    checkpoint: normalizeCheckpoint(checkpoint),
    messages: normalized[current].messages,
    sdkAgentId: normalized[current].sdkAgentId,
  };
}

export function formatBranches(report) {
  const lines = [];
  const cp = report.checkpointCount ?? 0;
  lines.push(
    `Ветки ${report.name}` +
      (cp ? ` (чекпоинт: ${cp} сообщ.)` : " (чекпоинт не сохранён)") +
      `  текущая: ${report.current ?? "—"}`,
  );
  if (!report.branches?.length) {
    lines.push("  (нет веток)");
    return lines.join("\n");
  }
  for (const branch of report.branches) {
    const mark = branch.current ? "*" : " ";
    lines.push(`  ${mark} ${branch.name}  ${branch.messages} сообщ.`);
  }
  return lines.join("\n");
}

export function strategyLabel(strategy, { window, factsCount, currentBranch } = {}) {
  const s = normalizeStrategy(strategy);
  if (s === STRATEGY_SLIDING) return `sliding, окно ${window ?? DEFAULT_WINDOW}`;
  if (s === STRATEGY_FACTS) {
    const n = factsCount ?? 0;
    return `facts, окно ${window ?? DEFAULT_WINDOW}, фактов ${n}`;
  }
  if (s === STRATEGY_BRANCHING) {
    return currentBranch ? `branching, ветка ${currentBranch}` : "branching";
  }
  return "full";
}
