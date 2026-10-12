import {
  applyTaskSignals,
  approvePlan,
  cloneTaskContext,
  completeStep,
  createTaskContext,
  emptyTaskContext,
  formatTaskReport,
  isActiveTask,
  normalizeTaskContext,
  setCurrent,
  setPlan,
  transition,
} from "./task.js";

export const MEMORY_SHORT = "short";
export const MEMORY_WORKING = "working";
export const MEMORY_LONG = "long";

export const MEMORY_LAYERS = [MEMORY_SHORT, MEMORY_WORKING, MEMORY_LONG];

export const LONG_PROFILE = "profile";
export const LONG_DECISIONS = "decisions";
export const LONG_KNOWLEDGE = "knowledge";

export const LONG_KINDS = [LONG_PROFILE, LONG_DECISIONS, LONG_KNOWLEDGE];

const LAYER_ALIASES = {
  short: MEMORY_SHORT,
  stm: MEMORY_SHORT,
  "short-term": MEMORY_SHORT,
  shortterm: MEMORY_SHORT,
  краткосрочная: MEMORY_SHORT,
  краткосрочную: MEMORY_SHORT,
  диалог: MEMORY_SHORT,
  dialogue: MEMORY_SHORT,
  dialog: MEMORY_SHORT,
  working: MEMORY_WORKING,
  wm: MEMORY_WORKING,
  "working-memory": MEMORY_WORKING,
  рабочая: MEMORY_WORKING,
  рабочую: MEMORY_WORKING,
  задача: MEMORY_WORKING,
  task: MEMORY_WORKING,
  long: MEMORY_LONG,
  ltm: MEMORY_LONG,
  "long-term": MEMORY_LONG,
  longterm: MEMORY_LONG,
  долговременная: MEMORY_LONG,
  долговременную: MEMORY_LONG,
  профиль: MEMORY_LONG,
};

const KIND_ALIASES = {
  profile: LONG_PROFILE,
  профиль: LONG_PROFILE,
  decisions: LONG_DECISIONS,
  decision: LONG_DECISIONS,
  решения: LONG_DECISIONS,
  решение: LONG_DECISIONS,
  knowledge: LONG_KNOWLEDGE,
  знания: LONG_KNOWLEDGE,
  знание: LONG_KNOWLEDGE,
};

const LAYER_TITLES = {
  [MEMORY_SHORT]: "краткосрочная (текущий диалог)",
  [MEMORY_WORKING]: "рабочая (текущая задача)",
  [MEMORY_LONG]: "долговременная (профиль, решения, знания)",
};

const KIND_TITLES = {
  [LONG_PROFILE]: "профиль",
  [LONG_DECISIONS]: "решения",
  [LONG_KNOWLEDGE]: "знания",
};

function canonicalLayer(raw) {
  const key = String(raw ?? "")
    .trim()
    .toLowerCase();
  return LAYER_ALIASES[key] ?? "";
}

function canonicalKind(raw) {
  const key = String(raw ?? "")
    .trim()
    .toLowerCase();
  return KIND_ALIASES[key] ?? "";
}

export function parseLayer(raw, flag = "слой памяти") {
  const layer = canonicalLayer(raw);
  if (!layer) {
    throw new Error(
      `${flag} должен быть short, working или long (краткосрочная / рабочая / долговременная)`,
    );
  }
  return layer;
}

export function parseKind(raw, flag = "вид долговременной памяти") {
  const kind = canonicalKind(raw);
  if (!kind) {
    throw new Error(
      `${flag} должен быть profile, decisions или knowledge (профиль / решения / знания)`,
    );
  }
  return kind;
}

export function isKindToken(raw) {
  return Boolean(canonicalKind(raw));
}

export function parseLayerToken(raw, flag = "слой памяти") {
  const text = String(raw ?? "").trim();
  const split = text.split(":");
  if (split.length === 2 && canonicalLayer(split[0]) === MEMORY_LONG) {
    return { layer: MEMORY_LONG, kind: parseKind(split[1], flag) };
  }
  return { layer: parseLayer(text, flag), kind: null };
}

export function parseRememberPayload(raw) {
  const text = String(raw ?? "").trim();
  if (!text) {
    throw new Error("Нужен текст для remember: ключ и значение");
  }
  const pair = text.match(
    /^([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9_-]{0,39})\s*[:=]\s*([\s\S]+)$/u,
  );
  if (pair) {
    return { key: pair[1].trim(), value: pair[2].trim() };
  }
  const spaced = text.match(
    /^([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё0-9_-]{0,39})\s+([\s\S]+)$/u,
  );
  if (spaced) {
    return { key: spaced[1].trim(), value: spaced[2].trim() };
  }
  return { key: "заметка", value: text };
}

export function parseMemoryDirective(raw) {
  const text = String(raw ?? "").trim();
  const match = text.match(
    /^\/(short|stm|working|wm|long|ltm|краткосрочная|рабочая|долговременная)(?::([A-Za-zА-Яа-яЁё_-]+))?\s+([\s\S]+)$/iu,
  );
  if (!match) {
    return { layer: null, kind: null, text, payload: null };
  }
  const layer = parseLayer(match[1], "префикс памяти");
  const kind = match[2]
    ? parseKind(match[2], "префикс памяти")
    : layer === MEMORY_LONG
      ? LONG_KNOWLEDGE
      : null;
  if (layer !== MEMORY_LONG && match[2]) {
    throw new Error("Вид profile|decisions|knowledge задаётся только для long");
  }
  return {
    layer,
    kind,
    text: match[3].trim(),
    payload: parseRememberPayload(match[3]),
  };
}

function normalizeMap(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return {};
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(row)) {
    const key = String(rawKey ?? "").trim();
    const value = String(rawValue ?? "").trim();
    if (key && value) out[key] = value;
  }
  return out;
}

function normalizeShort(row) {
  if (Array.isArray(row?.notes)) {
    const entries = {};
    for (const item of row.notes) {
      if (typeof item === "string" && item.trim()) {
        entries[`заметка-${Object.keys(entries).length + 1}`] = item.trim();
      } else if (item && typeof item === "object") {
        const key = String(item.key ?? "").trim() || `заметка-${Object.keys(entries).length + 1}`;
        const value = String(item.value ?? item.text ?? "").trim();
        if (value) entries[key] = value;
      }
    }
    return { entries: { ...entries, ...normalizeMap(row.entries) } };
  }
  return { entries: normalizeMap(row?.entries ?? row) };
}

function normalizeWorking(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return { task: "", entries: {}, machine: emptyTaskContext() };
  }
  const task = String(row.task ?? row.machine?.task ?? "").trim();
  const entries = normalizeMap(
    row.entries ?? (row.task || row.machine ? {} : row),
  );
  const machine = normalizeTaskContext(row.machine, { task });
  return {
    task: task || machine.task,
    entries,
    machine,
  };
}

function normalizeLong(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return { profile: {}, decisions: {}, knowledge: {} };
  }
  const looksFlat =
    !row.profile && !row.decisions && !row.knowledge && Object.keys(row).length;
  return {
    profile: normalizeMap(row.profile),
    decisions: normalizeMap(row.decisions),
    knowledge: normalizeMap(looksFlat ? row : row.knowledge),
  };
}

export function emptyMemory() {
  return {
    short: { entries: {} },
    working: { task: "", entries: {}, machine: emptyTaskContext() },
    long: { profile: {}, decisions: {}, knowledge: {} },
  };
}

export function normalizeMemory(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return emptyMemory();
  }
  return {
    short: normalizeShort(row.short),
    working: normalizeWorking(row.working),
    long: normalizeLong(row.long),
  };
}

function cloneMemory(memory) {
  const src = normalizeMemory(memory);
  return {
    short: { entries: { ...src.short.entries } },
    working: {
      task: src.working.task,
      entries: { ...src.working.entries },
      machine: cloneTaskContext(src.working.machine),
    },
    long: {
      profile: { ...src.long.profile },
      decisions: { ...src.long.decisions },
      knowledge: { ...src.long.knowledge },
    },
  };
}

function mapSize(map) {
  return Object.keys(map ?? {}).length;
}

export function memoryCounts(memory) {
  const m = normalizeMemory(memory);
  return {
    short: mapSize(m.short.entries),
    working: mapSize(m.working.entries),
    long:
      mapSize(m.long.profile) +
      mapSize(m.long.decisions) +
      mapSize(m.long.knowledge),
    longProfile: mapSize(m.long.profile),
    longDecisions: mapSize(m.long.decisions),
    longKnowledge: mapSize(m.long.knowledge),
    task: m.working.task,
    taskState: isActiveTask(m.working.machine) ? m.working.machine.state : "",
    taskStep: m.working.machine?.step ?? 0,
    taskTotal: m.working.machine?.total ?? 0,
    taskCurrent: m.working.machine?.current ?? "",
  };
}

function writeEntry(map, key, value) {
  const k = String(key ?? "").trim();
  const v = String(value ?? "").trim();
  if (!k || !v) {
    throw new Error("Ключ и значение для памяти не могут быть пустыми");
  }
  map[k] = v;
  return { key: k, value: v };
}

export class AgentMemory {
  #short;
  #working;
  #long;

  constructor(raw) {
    const normalized = normalizeMemory(raw);
    this.#short = normalized.short;
    this.#working = normalized.working;
    this.#long = normalized.long;
  }

  get short() {
    return { entries: { ...this.#short.entries } };
  }

  get working() {
    return {
      task: this.#working.task,
      entries: { ...this.#working.entries },
      machine: cloneTaskContext(this.#working.machine),
    };
  }

  taskContext() {
    return cloneTaskContext(this.#working.machine);
  }

  #setMachine(ctx) {
    this.#working.machine = cloneTaskContext(ctx);
    this.#working.task = this.#working.machine.task;
    return this.taskContext();
  }

  get long() {
    return {
      profile: { ...this.#long.profile },
      decisions: { ...this.#long.decisions },
      knowledge: { ...this.#long.knowledge },
    };
  }

  counts() {
    return memoryCounts(this.toJSON());
  }

  hasPromptContent() {
    const c = this.counts();
    return c.short > 0 || c.working > 0 || c.long > 0 || Boolean(this.#working.task);
  }

  remember(layer, { key, value, kind } = {}) {
    const target = parseLayer(layer);
    if (target === MEMORY_SHORT) {
      const written = writeEntry(this.#short.entries, key, value);
      return { layer: MEMORY_SHORT, kind: null, ...written };
    }
    if (target === MEMORY_WORKING) {
      const written = writeEntry(this.#working.entries, key, value);
      return { layer: MEMORY_WORKING, kind: null, ...written };
    }
    const bucket = kind ? parseKind(kind) : LONG_KNOWLEDGE;
    const written = writeEntry(this.#long[bucket], key, value);
    return { layer: MEMORY_LONG, kind: bucket, ...written };
  }

  forget(layer, { key, kind } = {}) {
    const target = parseLayer(layer);
    if (target === MEMORY_SHORT) {
      if (key) {
        const k = String(key).trim();
        if (!(k in this.#short.entries)) {
          throw new Error(`В краткосрочной памяти нет ключа: ${k}`);
        }
        delete this.#short.entries[k];
        return { layer: MEMORY_SHORT, cleared: "key", key: k };
      }
      const n = mapSize(this.#short.entries);
      this.#short.entries = {};
      return { layer: MEMORY_SHORT, cleared: "layer", count: n };
    }
    if (target === MEMORY_WORKING) {
      if (key) {
        const k = String(key).trim();
        if (!(k in this.#working.entries)) {
          throw new Error(`В рабочей памяти нет ключа: ${k}`);
        }
        delete this.#working.entries[k];
        return { layer: MEMORY_WORKING, cleared: "key", key: k };
      }
      const n = mapSize(this.#working.entries);
      this.#working.entries = {};
      this.#working.task = "";
      this.#working.machine = emptyTaskContext();
      return { layer: MEMORY_WORKING, cleared: "layer", count: n };
    }
    if (kind && key) {
      const bucket = parseKind(kind);
      const k = String(key).trim();
      if (!(k in this.#long[bucket])) {
        throw new Error(`В долговременной памяти (${KIND_TITLES[bucket]}) нет ключа: ${k}`);
      }
      delete this.#long[bucket][k];
      return { layer: MEMORY_LONG, kind: bucket, cleared: "key", key: k };
    }
    if (kind) {
      const bucket = parseKind(kind);
      const n = mapSize(this.#long[bucket]);
      this.#long[bucket] = {};
      return { layer: MEMORY_LONG, kind: bucket, cleared: "kind", count: n };
    }
    if (key) {
      const k = String(key).trim();
      for (const bucket of LONG_KINDS) {
        if (k in this.#long[bucket]) {
          delete this.#long[bucket][k];
          return { layer: MEMORY_LONG, kind: bucket, cleared: "key", key: k };
        }
      }
      throw new Error(`В долговременной памяти нет ключа: ${k}`);
    }
    const n =
      mapSize(this.#long.profile) +
      mapSize(this.#long.decisions) +
      mapSize(this.#long.knowledge);
    this.#long = { profile: {}, decisions: {}, knowledge: {} };
    return { layer: MEMORY_LONG, cleared: "layer", count: n };
  }

  startTask(title) {
    const task = String(title ?? "").trim();
    this.#working.entries = {};
    this.#working.task = task;
    this.#working.machine = task
      ? createTaskContext({ task })
      : emptyTaskContext();
    return { task, cleared: true, context: this.taskContext() };
  }

  setTaskPlan(items) {
    return this.#setMachine(setPlan(this.#working.machine, items));
  }

  approveTask() {
    return this.#setMachine(approvePlan(this.#working.machine));
  }

  nextTaskStep(current) {
    return this.#setMachine(completeStep(this.#working.machine, current));
  }

  transitionTask(state, opts) {
    return this.#setMachine(transition(this.#working.machine, state, opts));
  }

  setTaskCurrent(current) {
    return this.#setMachine(setCurrent(this.#working.machine, current));
  }

  applyTaskSignal(text) {
    const result = applyTaskSignals(this.#working.machine, text);
    this.#setMachine(result.context);
    return result;
  }

  toJSON() {
    return cloneMemory({
      short: this.#short,
      working: this.#working,
      long: this.#long,
    });
  }

  format(layer) {
    if (layer) return formatLayer(this.toJSON(), parseLayer(layer));
    return formatMemory(this.toJSON());
  }

  promptBlock() {
    return formatMemoryForPrompt(this.toJSON());
  }
}

function formatEntries(entries, indent = "  ") {
  const list = Object.entries(entries ?? {});
  if (!list.length) return `${indent}(пусто)`;
  return list.map(([key, value]) => `${indent}${key}: ${value}`).join("\n");
}

function formatLayer(memory, layer) {
  const m = normalizeMemory(memory);
  if (layer === MEMORY_SHORT) {
    return `Краткосрочная память (заметки текущего диалога):\n${formatEntries(m.short.entries)}`;
  }
  if (layer === MEMORY_WORKING) {
    const title = m.working.task ? ` задача «${m.working.task}»` : "";
    const machine = isActiveTask(m.working.machine)
      ? `\n${formatTaskReport(m.working.machine)}`
      : "";
    return `Рабочая память${title}:\n${formatEntries(m.working.entries)}${machine}`;
  }
  return [
    "Долговременная память:",
    `  [профиль]`,
    formatEntries(m.long.profile, "    "),
    `  [решения]`,
    formatEntries(m.long.decisions, "    "),
    `  [знания]`,
    formatEntries(m.long.knowledge, "    "),
  ].join("\n");
}

export function formatMemory(memory) {
  const m = normalizeMemory(memory);
  return MEMORY_LAYERS.map((layer) => formatLayer(m, layer)).join("\n\n");
}

function promptEntries(title, entries) {
  const list = Object.entries(entries ?? {});
  if (!list.length) return "";
  const lines = list.map(([key, value]) => `- ${key}: ${value}`);
  return `${title}\n${lines.join("\n")}`;
}

export function formatMemoryForPrompt(memory) {
  const m = normalizeMemory(memory);
  const parts = [];
  const profile = promptEntries("[профиль]", m.long.profile);
  const decisions = promptEntries("[решения]", m.long.decisions);
  const knowledge = promptEntries("[знания]", m.long.knowledge);
  const longParts = [profile, decisions, knowledge].filter(Boolean);
  if (longParts.length) {
    parts.push(
      "Долговременная память (профиль, решения, знания — придерживайся; не противоречь без новой явной записи):\n" +
        longParts.join("\n"),
    );
  }
  const workingTitle = m.working.task
    ? `Рабочая память текущей задачи «${m.working.task}»`
    : "Рабочая память текущей задачи";
  const working = promptEntries(
    `${workingTitle} (данные задачи, не путай с прошлыми диалогами):`,
    m.working.entries,
  );
  if (working) parts.push(working);
  const short = promptEntries(
    "Заметки текущего диалога (краткосрочная память):",
    m.short.entries,
  );
  if (short) parts.push(short);
  return parts.join("\n\n");
}

export function layerTitle(layer) {
  return LAYER_TITLES[parseLayer(layer)] ?? layer;
}

export function kindTitle(kind) {
  return KIND_TITLES[parseKind(kind)] ?? kind;
}

export function formatRememberResult(result) {
  const where =
    result.layer === MEMORY_LONG
      ? `${layerTitle(result.layer)} / ${kindTitle(result.kind)}`
      : layerTitle(result.layer);
  return `Сохранено в ${where}: ${result.key}: ${result.value}`;
}

export function formatForgetResult(result) {
  const where =
    result.kind
      ? `${layerTitle(result.layer)} / ${kindTitle(result.kind)}`
      : layerTitle(result.layer);
  if (result.cleared === "key") {
    return `Удалено из ${where}: ${result.key}`;
  }
  if (result.cleared === "kind") {
    return `Очищена ${where} (${result.count} записей)`;
  }
  return `Очищена ${where} (${result.count} записей)`;
}
