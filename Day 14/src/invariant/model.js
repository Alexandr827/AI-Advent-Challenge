import { parseUserId } from "../profile/model.js";

export const TYPE_STACK = "stack";
export const TYPE_ARCH = "arch";
export const TYPE_BUDGET = "budget";
export const TYPE_MAXDEPS = "maxdeps";
export const TYPE_NOBANNED = "nobanned";
export const TYPE_DECISION = "decision";
export const TYPE_APIS = "apis";

export const INVARIANT_TYPES = [
  TYPE_STACK,
  TYPE_ARCH,
  TYPE_BUDGET,
  TYPE_MAXDEPS,
  TYPE_NOBANNED,
  TYPE_DECISION,
  TYPE_APIS,
];

const TYPE_ALIASES = {
  stack: TYPE_STACK,
  stackonly: TYPE_STACK,
  стек: TYPE_STACK,
  arch: TYPE_ARCH,
  architecture: TYPE_ARCH,
  archonly: TYPE_ARCH,
  архитектура: TYPE_ARCH,
  budget: TYPE_BUDGET,
  бюджет: TYPE_BUDGET,
  maxdeps: TYPE_MAXDEPS,
  deps: TYPE_MAXDEPS,
  dependencies: TYPE_MAXDEPS,
  зависимости: TYPE_MAXDEPS,
  nobanned: TYPE_NOBANNED,
  banned: TYPE_NOBANNED,
  запрещено: TYPE_NOBANNED,
  запрет: TYPE_NOBANNED,
  decision: TYPE_DECISION,
  решения: TYPE_DECISION,
  решение: TYPE_DECISION,
  apis: TYPE_APIS,
  api: TYPE_APIS,
  business: TYPE_APIS,
};

const TECH_CATALOG = [
  { id: "nodejs", aliases: ["nodejs", "node.js", "node js", "node", "нода"] },
  { id: "javascript", aliases: ["javascript", "js", "ecmascript"] },
  { id: "typescript", aliases: ["typescript", "ts"] },
  { id: "csharp", aliases: ["c#", "csharp", "с#", "си шарп", ".net", "dotnet"] },
  { id: "aspnet", aliases: ["asp.net", "aspnet", "asp net"] },
  { id: "python", aliases: ["python", "django", "flask", "fastapi", "питон"] },
  { id: "java", aliases: ["java", "spring", "джава"] },
  { id: "kotlin", aliases: ["kotlin", "ktor"] },
  { id: "go", aliases: ["golang", " go "] },
  { id: "rust", aliases: ["rust"] },
  { id: "php", aliases: ["php", "laravel", "symfony"] },
  { id: "ruby", aliases: ["ruby", "rails"] },
  { id: "swift", aliases: ["swift"] },
  { id: "dart", aliases: ["dart", "flutter"] },
  { id: "scala", aliases: ["scala"] },
  { id: "elixir", aliases: ["elixir", "phoenix"] },
  { id: "csharp-extra", aliases: ["asp.net core", "blazor"] },
];

const ARCH_CATALOG = [
  { id: "mvvm", aliases: ["mvvm"] },
  { id: "mvc", aliases: ["mvc"] },
  { id: "mvp", aliases: ["mvp"] },
  { id: "mvi", aliases: ["mvi"] },
  { id: "clean", aliases: ["clean architecture", "clean"] },
  { id: "hexagonal", aliases: ["hexagonal", "ports and adapters"] },
  { id: "onion", aliases: ["onion"] },
  { id: "layered", aliases: ["layered", "n-tier", "трехуровнев"] },
  { id: "microservices", aliases: ["microservices", "микросервис"] },
  { id: "soa", aliases: ["soa"] },
  { id: "viper", aliases: ["viper"] },
];

const PAID_API_MARKERS = [
  "stripe",
  "twilio",
  "openai",
  "aws ",
  "amazon web services",
  "azure",
  "google cloud",
  "gcp ",
  "auth0",
  "algolia",
  "sendgrid",
  "платный api",
  "paid api",
  "proprietary api",
];

const REFUSAL_RE =
  /запрещ|нельзя|не\s+вход|не\s+использу|не\s+бер|avoid|not allowed|forbidden|отказ|нарушен|don't use|do not use|не входят|не входит|отклон|без\s+|нельзя использовать|не подходит|нельзя предлагать/i;

const NEGATION_RE = /вместо|instead of|а не|не\s+|без\s+|отказ/i;

const SHORT_ALIAS = new Set(["js", "ts", "go", "c#", "с#"]);

export function parseSetId(raw, flag = "set_id") {
  return parseUserId(raw, flag);
}

export function parseInvariantType(raw, flag = "тип инварианта") {
  const key = String(raw ?? "")
    .trim()
    .replace(/[:()]/g, "")
    .toLowerCase();
  const type = TYPE_ALIASES[key];
  if (!type) {
    throw new Error(
      `${flag} должен быть stack, arch, budget, maxdeps, nobanned, decision или apis`,
    );
  }
  return type;
}

export function splitValues(raw) {
  const text = Array.isArray(raw) ? raw.join(" ") : String(raw ?? "");
  return text
    .split(/[,;|+]+/)
    .flatMap((part) => part.split(/\s+/))
    .map((item) => item.replace(/^["'`]+|["'`]+$/g, "").trim())
    .filter(Boolean);
}

function parseMoney(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const compact = text
    .replace(/\s+/g, "")
    .replace(/[$\u20bd€]/g, "")
    .replace(/тыс\.?|k\b/gi, "000")
    .replace(/млн|mm?\b/gi, "000000")
    .replace(/,/g, "");
  const n = Number(compact);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseCount(raw) {
  const n = Number(String(raw ?? "").replace(/[^\d.-]/g, ""));
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("Нужно целое число >= 0");
  }
  return n;
}

function fold(text) {
  return ` ${String(text ?? "").toLowerCase()} `;
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasPhrase(haystack, phrase) {
  const needle = String(phrase ?? "").trim().toLowerCase();
  if (!needle) return false;
  const source = fold(haystack);
  if (SHORT_ALIAS.has(needle) || needle.length <= 2) {
    return new RegExp(`(?:^|[^a-zа-я0-9])${escapeRe(needle)}(?:[^a-zа-я0-9]|$)`, "i").test(
      source,
    );
  }
  if (needle === "java") {
    return /(?:^|[^a-z])java(?!script)(?:[^a-z]|$)/i.test(source);
  }
  if (needle === "node") {
    return /(?:^|[^a-z])node(?:\.?js)?(?:[^a-z]|$)/i.test(source);
  }
  return source.includes(needle);
}

function catalogHits(text, catalog) {
  return catalog.filter((item) => item.aliases.some((alias) => hasPhrase(text, alias)));
}

function resolveAllowedIds(allowed, catalog) {
  const ids = new Set();
  for (const value of allowed) {
    const hit = catalog.find((item) =>
      item.aliases.some((alias) => hasPhrase(value, alias) || alias === value.toLowerCase()),
    );
    if (hit) ids.add(hit.id);
    ids.add(String(value).trim().toLowerCase());
  }
  return ids;
}

function isRefusedNear(text, phrase) {
  const source = String(text ?? "");
  const lower = source.toLowerCase();
  const needle = String(phrase ?? "").toLowerCase();
  let from = 0;
  while (from < lower.length) {
    const at = lower.indexOf(needle, from);
    if (at === -1) break;
    const window = source.slice(Math.max(0, at - 80), at + needle.length + 80);
    if (REFUSAL_RE.test(window) || NEGATION_RE.test(window.slice(0, 80))) {
      return true;
    }
    from = at + needle.length;
  }
  return false;
}

function checkAllowlist(response, allowed, catalog) {
  if (!allowed.length) return true;
  const allowedIds = resolveAllowedIds(allowed, catalog);
  const hits = catalogHits(response, catalog);
  const allowedHits = hits.filter(
    (item) =>
      allowedIds.has(item.id) ||
      allowed.some((value) => item.aliases.some((alias) => hasPhrase(value, alias))),
  );
  const competing = hits.filter((item) => !allowedHits.includes(item));
  const allowedMentioned = allowed.some((value) => hasPhrase(response, value)) || allowedHits.length > 0;

  if (!hits.length && !allowedMentioned) {
    const unknown = allowed.filter((value) => hasPhrase(response, value));
    return unknown.length > 0 || !competing.length;
  }
  if (competing.length && !allowedMentioned) return false;
  if (!competing.length) return true;
  return competing.every((item) =>
    item.aliases.some((alias) => isRefusedNear(response, alias)),
  );
}

function checkBanned(response, banned) {
  return banned.every((item) => {
    if (!hasPhrase(response, item)) return true;
    return isRefusedNear(response, item);
  });
}

function moneyMentions(response) {
  const text = String(response ?? "");
  const found = [];
  const re =
    /(\$|usd|eur|₽|руб)?\s*(\d[\d\s,]*(?:\.\d+)?)\s*(k|тыс\.?|млн|m|mm|\$|usd|eur|₽|руб)?/gi;
  let match;
  while ((match = re.exec(text))) {
    const around = text.slice(Math.max(0, match.index - 24), match.index + match[0].length + 24);
    if (
      !/(\$|usd|eur|₽|руб|бюджет|budget|стоим|стоить|price|cost|цен[аеуы]|тыс|млн)/i.test(
        around,
      )
    ) {
      continue;
    }
    const amount = parseMoney(match[0]);
    if (amount != null) found.push({ amount, text: match[0], around });
  }
  return found;
}

function depCount(response) {
  const text = String(response ?? "");
  const labeled = [
    ...text.matchAll(
      /(\d+)\s*(?:библиотек\w*|зависимост\w*|package\w*|dependenc\w*|deps?)/gi,
    ),
  ];
  const counts = labeled.map((item) => Number(item[1])).filter((n) => Number.isInteger(n));
  const install = text.match(/npm\s+i(?:nstall)?\s+([^\n]+)/i);
  if (install) {
    counts.push(splitValues(install[1].replace(/-[A-Za-z]\S*/g, "")).length);
  }
  const jsonBlock = text.match(/"dependencies"\s*:\s*\{([^}]+)\}/i);
  if (jsonBlock) {
    counts.push([...jsonBlock[1].matchAll(/"[^"]+"\s*:/g)].length);
  }
  return counts.length ? Math.max(...counts) : 0;
}

export class Invariant {
  constructor({ id, type }) {
    this.id = String(id ?? type ?? "").trim();
    this.type = type;
  }

  get description() {
    throw new Error("Invariant.description");
  }

  check(_response) {
    throw new Error("Invariant.check");
  }

  toJSON() {
    return { id: this.id, type: this.type };
  }
}

export class StackOnly extends Invariant {
  constructor({ id, allowed = [] } = {}) {
    super({ id: id ?? TYPE_STACK, type: TYPE_STACK });
    this.allowed = [...new Set(allowed.map((item) => String(item).trim()).filter(Boolean))];
  }

  get description() {
    return `Stack: ${this.allowed.join(", ") || "(пусто)"}`;
  }

  check(response) {
    return checkAllowlist(response, this.allowed, TECH_CATALOG);
  }

  toJSON() {
    return { ...super.toJSON(), allowed: this.allowed };
  }
}

export class ArchOnly extends Invariant {
  constructor({ id, allowed = [] } = {}) {
    super({ id: id ?? TYPE_ARCH, type: TYPE_ARCH });
    this.allowed = [...new Set(allowed.map((item) => String(item).trim()).filter(Boolean))];
  }

  get description() {
    return `Architecture: ${this.allowed.join(", ") || "(пусто)"}`;
  }

  check(response) {
    return checkAllowlist(response, this.allowed, ARCH_CATALOG);
  }

  toJSON() {
    return { ...super.toJSON(), allowed: this.allowed };
  }
}

export class Budget extends Invariant {
  constructor({ id, max = 0 } = {}) {
    super({ id: id ?? TYPE_BUDGET, type: TYPE_BUDGET });
    this.max = Number(max) || 0;
  }

  get description() {
    return `Budget: ${this.max}$`;
  }

  check(response) {
    return moneyMentions(response).every(
      (item) => item.amount <= this.max || isRefusedNear(item.around, String(item.amount)),
    );
  }

  toJSON() {
    return { ...super.toJSON(), max: this.max };
  }
}

export class MaxDeps extends Invariant {
  constructor({ id, max = 0 } = {}) {
    super({ id: id ?? TYPE_MAXDEPS, type: TYPE_MAXDEPS });
    this.max = Number(max) || 0;
  }

  get description() {
    return `MaxDeps <= ${this.max}`;
  }

  check(response) {
    const count = depCount(response);
    return count <= this.max;
  }

  toJSON() {
    return { ...super.toJSON(), max: this.max };
  }
}

export class NoBanned extends Invariant {
  constructor({ id, banned = [] } = {}) {
    super({ id: id ?? TYPE_NOBANNED, type: TYPE_NOBANNED });
    this.banned = [...new Set(banned.map((item) => String(item).trim()).filter(Boolean))];
  }

  get description() {
    return `NoBanned: ${this.banned.join(", ") || "(пусто)"}`;
  }

  check(response) {
    return checkBanned(response, this.banned);
  }

  toJSON() {
    return { ...super.toJSON(), banned: this.banned };
  }
}

export class Decision extends Invariant {
  constructor({ id, text = "" } = {}) {
    super({ id: id ?? TYPE_DECISION, type: TYPE_DECISION });
    this.text = String(text ?? "").trim();
  }

  get description() {
    return `Decision: ${this.text || "(пусто)"}`;
  }

  #banned() {
    const found = [];
    const re =
      /(?:no|без|не\s+использовать|запрещ(?:ен[оа]?|ено)?)\s+([A-Za-zА-Яа-я0-9.+#-]+)/gi;
    let match;
    while ((match = re.exec(this.text))) {
      found.push(match[1]);
    }
    return found;
  }

  check(response) {
    const banned = this.#banned();
    if (!banned.length) return true;
    return checkBanned(response, banned);
  }

  toJSON() {
    return { ...super.toJSON(), text: this.text };
  }
}

export class FreeApis extends Invariant {
  constructor({ id, policy = "free" } = {}) {
    super({ id: id ?? TYPE_APIS, type: TYPE_APIS });
    this.policy = String(policy ?? "free").trim() || "free";
  }

  get description() {
    return this.policy === "free" ? "APIs: только бесплатные API" : `APIs: ${this.policy}`;
  }

  check(response) {
    if (this.policy !== "free") {
      return hasPhrase(response, this.policy) || !PAID_API_MARKERS.some((item) => hasPhrase(response, item));
    }
    return PAID_API_MARKERS.every(
      (item) => !hasPhrase(response, item) || isRefusedNear(response, item),
    );
  }

  toJSON() {
    return { ...super.toJSON(), policy: this.policy };
  }
}

const FACTORIES = {
  [TYPE_STACK]: (row) => new StackOnly(row),
  [TYPE_ARCH]: (row) => new ArchOnly(row),
  [TYPE_BUDGET]: (row) => new Budget(row),
  [TYPE_MAXDEPS]: (row) => new MaxDeps(row),
  [TYPE_NOBANNED]: (row) => new NoBanned(row),
  [TYPE_DECISION]: (row) => new Decision(row),
  [TYPE_APIS]: (row) => new FreeApis(row),
};

export function createInvariant(row) {
  if (!row || typeof row !== "object") {
    throw new Error("Некорректный инвариант");
  }
  const type = parseInvariantType(row.type ?? row.kind);
  const factory = FACTORIES[type];
  return factory({
    id: row.id,
    allowed: row.allowed ?? row.values,
    banned: row.banned ?? row.values,
    max: row.max,
    text: row.text ?? row.value,
    policy: row.policy ?? row.value,
  });
}

export function parseInvariantSpec(typeToken, argTokens = []) {
  const joined = [typeToken, ...argTokens].filter(Boolean).join(" ").trim();
  const call = joined.match(/^([A-Za-zА-Яа-я_]+)\s*\((.*)\)\s*$/);
  const rawType = call ? call[1] : typeToken;
  const type = parseInvariantType(rawType);
  const rest = call ? splitValues(call[2]) : splitValues(argTokens);
  if (type === TYPE_STACK || type === TYPE_ARCH) {
    if (!rest.length) throw new Error(`Для ${type} нужно указать разрешённые значения`);
    return createInvariant({ type, allowed: rest });
  }
  if (type === TYPE_NOBANNED) {
    if (!rest.length) throw new Error("Для nobanned нужно указать запрещённые значения");
    return createInvariant({ type, banned: rest });
  }
  if (type === TYPE_BUDGET) {
    const max = parseMoney(rest.join(" "));
    if (max == null) throw new Error("Для budget нужно число, например 100000");
    return createInvariant({ type, max });
  }
  if (type === TYPE_MAXDEPS) {
    return createInvariant({ type, max: parseCount(rest[0]) });
  }
  if (type === TYPE_DECISION) {
    const text = argTokens.join(" ").trim() || rest.join(" ");
    if (!text) throw new Error("Для decision нужно описание решения");
    return createInvariant({ type, text });
  }
  if (type === TYPE_APIS) {
    return createInvariant({ type, policy: rest.join(" ") || "free" });
  }
  throw new Error(`Неизвестный тип инварианта: ${type}`);
}

export function emptyInvariantSet(id = "") {
  return { id: id ? String(id) : "", items: [] };
}

export function normalizeInvariantSet(row, fallbackId = "") {
  const id = String(row?.id ?? row?.setId ?? fallbackId ?? "").trim();
  const items = Array.isArray(row?.items)
    ? row.items.map((item) => createInvariant(item))
    : [];
  return { id, items };
}

export function cloneInvariantSet(set) {
  const src = normalizeInvariantSet(set);
  return {
    id: src.id,
    items: src.items.map((item) => createInvariant(item.toJSON())),
  };
}

export function invariantSnapshot(set) {
  const src = normalizeInvariantSet(set);
  return {
    id: src.id,
    count: src.items.length,
    types: src.items.map((item) => item.type),
    active: src.items.length > 0,
  };
}

function nextItemId(items, type) {
  if (!items.some((item) => item.id === type)) return type;
  let n = 2;
  while (items.some((item) => item.id === `${type}-${n}`)) n += 1;
  return `${type}-${n}`;
}

export function addInvariant(set, spec) {
  const next = cloneInvariantSet(set);
  const item = spec instanceof Invariant ? spec : createInvariant(spec);
  if (!item.id) item.id = nextItemId(next.items, item.type);
  else if (next.items.some((row) => row.id === item.id)) {
    item.id = nextItemId(next.items, item.id);
  }
  next.items.push(item);
  return { set: next, item };
}

export function removeInvariant(set, idOrType) {
  const next = cloneInvariantSet(set);
  const key = String(idOrType ?? "").trim();
  if (!key) {
    const count = next.items.length;
    next.items = [];
    return { set: next, count, item: null };
  }
  const index = next.items.findIndex(
    (item) => item.id === key || item.type === key,
  );
  if (index === -1) {
    throw new Error(`Инвариант не найден: ${key}`);
  }
  const [item] = next.items.splice(index, 1);
  return { set: next, count: 1, item };
}

export function formatInvariantSet(set) {
  const src = normalizeInvariantSet(set);
  const lines = [`Инварианты ${src.id || "(без id)"} (${src.items.length}):`];
  if (!src.items.length) {
    lines.push("  (пусто)");
    return lines.join("\n");
  }
  for (const item of src.items) {
    lines.push(`  - ${item.id}: ${item.description}`);
  }
  return lines.join("\n");
}

export function formatInvariantsPrompt(set) {
  const src = normalizeInvariantSet(set);
  if (!src.items.length) return "";
  const who = src.id ? ` (${src.id})` : "";
  return [
    `[INVARIANTS]${who}`,
    "Жёсткие инварианты. Нарушение любого — ЗАПРЕЩЕНО.",
    "В рассуждениях явно сверяй каждое предложение с этим списком.",
    "Если запрос требует нарушения — откажись и предложи совместимое решение. Не предлагай запрещённое даже как альтернативу.",
    ...src.items.map((item) => `- ${item.description}`),
  ].join("\n");
}

export function formatViolationsPrompt(violations) {
  const list = Array.isArray(violations) ? violations : [];
  if (!list.length) return "";
  return [
    "[VIOLATIONS]",
    "Предыдущий черновик ответа нарушил инварианты:",
    ...list.map((item) => `- ${item.description ?? item}`),
    "Перепиши ответ. Нарушение ЗАПРЕЩЕНО. Если запрос требует нарушения — откажись и предложи совместимый вариант.",
  ].join("\n");
}
