/**
 * Одна задача про 25 лошадей — способы промптинга, temperature и сравнение
 * слабой / средней / сильной моделей через Cursor SDK.
 *
 * Cursor AgentOptions не принимает sampling temperature, поэтому 0 / 0.7 / 1.2
 * задаются инструкцией в промпте.
 *
 * Переменные из .env:
 *   CURSOR_API_KEY        — ключ из Cursor Dashboard → Integrations
 *   CURSOR_MODEL          — опционально, по умолчанию composer-2.5
 *   CURSOR_RUNTIME        — local (по умолчанию) или cloud
 *   CURSOR_MODEL_WEAK     — слабая модель (иначе gpt-5.4-nano и запасные)
 *   CURSOR_MODEL_MEDIUM   — средняя модель (иначе composer-2.5)
 *   CURSOR_MODEL_STRONG   — сильная модель (иначе claude-opus-5 и запасные)
 *
 *   npm start -- --mode direct
 *   npm start -- --mode step
 *   npm start -- --mode meta
 *   npm start -- --mode experts
 *   npm start -- --compare
 *   npm start -- --mode temperature
 *   npm start -- --compare-temp
 *   npm start -- --mode models
 *   npm start -- --compare-models
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, Cursor, CursorAgentError } from "@cursor/sdk";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = resolve(projectRoot, "results");
const PROMPT_MODES = ["direct", "step", "meta", "experts"];
const MODES = [...PROMPT_MODES, "temperature", "models"];
const TEMPERATURES = [0, 0.7, 1.2];
const TEMP_IDS = TEMPERATURES.map((t) => `temp-${t}`);
const MODEL_TIERS = [
  {
    id: "model-weak",
    tier: "weak",
    label: "слабая",
    envKey: "CURSOR_MODEL_WEAK",
    defaults: ["gpt-5.4-nano", "gpt-5-mini", "gemini-2.5-flash"],
  },
  {
    id: "model-medium",
    tier: "medium",
    label: "средняя",
    envKey: "CURSOR_MODEL_MEDIUM",
    defaults: ["composer-2.5"],
  },
  {
    id: "model-strong",
    tier: "strong",
    label: "сильная",
    envKey: "CURSOR_MODEL_STRONG",
    defaults: ["claude-opus-5", "gpt-5.5", "grok-4.6"],
  },
];
const MODEL_IDS = MODEL_TIERS.map((t) => t.id);
/** USD per 1M tokens. Источник: https://cursor.com/docs/models */
const MODEL_PRICES = {
  "gpt-5.4-nano": { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0.25 },
  "gpt-5-mini": { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.3125 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cacheRead: 0.03 },
  "composer-2.5": { input: 0.5, output: 2.5, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "gpt-5.5": { input: 5, output: 30, cacheRead: 0.5 },
  "grok-4.6": { input: 2, output: 6, cacheRead: 0.5 },
};
const ETALON = 8;
const DEFAULT_PUZZLE = [
  "Есть забег из 25 лошадей. В каждом забеге могут участвовать до 5 лошадей.",
  "Какое количество забегов минимально надо устроить, чтобы найти 1, 2 и 3 место?",
].join(" ");

const EXPERTS = [
  {
    id: "analyst",
    label: "аналитик",
    system:
      "Ты аналитик. Разбери задачу на этапы: что известно, какие ограничения, какой порядок действий. Сначала структура рассуждения, потом вывод. Не называй итоговое число наугад.",
  },
  {
    id: "engineer",
    label: "инженер",
    system:
      "Ты инженер. Дай конкретную схему забегов: кто с кем бежит на каждом шаге и какое итоговое число забегов получается.",
  },
  {
    id: "critic",
    label: "критик",
    system:
      "Ты критик. Найди дыры в типичных схемах решения таких задач (лишние забеги, пропущенные претенденты на места, неверная арифметика) и назови свой итог.",
  },
];

function loadEnv(path) {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    console.error(`Не найден файл ${path}`);
    process.exit(1);
  }
}

function printUsage() {
  console.error(
    [
      "Нужен один переключатель — одна команда запускает один способ:",
      "",
      "  npm start -- --mode direct",
      "  npm start -- --mode step",
      "  npm start -- --mode meta",
      "  npm start -- --mode experts",
      "  npm start -- --compare",
      "  npm start -- --mode temperature",
      "  npm start -- --compare-temp",
      "  npm start -- --mode models",
      "  npm start -- --compare-models",
    ].join("\n"),
  );
}

function resultPath(id) {
  return resolve(resultsDir, `${id}.json`);
}

function saveResult(result) {
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(resultPath(result.id), JSON.stringify(result, null, 2), "utf8");
}

function loadResult(id) {
  try {
    const result = JSON.parse(readFileSync(resultPath(id), "utf8"));
    if (MODEL_IDS.includes(id) && result.combinedText) {
      const extracted = extractRaceCount(result.combinedText);
      result.answer = extracted;
      if (result.parts?.[0] && !result.parts[0].skipAnswer) {
        result.parts[0].answer = extractRaceCount(
          result.parts[0].text || result.combinedText,
        );
      }
    }
    return result;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  let mode = null;
  let compare = false;
  let compareTemp = false;
  let compareModels = false;
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg === "--compare") {
      compare = true;
      continue;
    }
    if (arg === "--compare-temp") {
      compareTemp = true;
      continue;
    }
    if (arg === "--compare-models") {
      compareModels = true;
      continue;
    }
    if (arg === "--mode") {
      const value = argv[i + 1];
      if (!MODES.includes(value)) {
        console.error(`Ожидается --mode ${MODES.join("|")}`);
        process.exit(1);
      }
      mode = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      if (!MODES.includes(value)) {
        console.error(`Ожидается --mode ${MODES.join("|")}`);
        process.exit(1);
      }
      mode = value;
      continue;
    }
    if (arg.startsWith("-")) {
      console.error(`Неизвестный флаг: ${arg}`);
      process.exit(1);
    }
    positional.push(arg);
  }

  const switches = [Boolean(mode), compare, compareTemp, compareModels].filter(Boolean).length;
  if (switches > 1) {
    console.error(
      "Не совмещайте --mode, --compare, --compare-temp и --compare-models. Запускайте по одному.",
    );
    process.exit(1);
  }
  if (switches === 0) {
    printUsage();
    process.exit(1);
  }

  return {
    mode,
    compare,
    compareTemp,
    compareModels,
    puzzle: positional.join(" ").trim() || DEFAULT_PUZZLE,
  };
}

function composePrompt(system, user) {
  if (!system) return user;
  return `${system}\n\nЗадача:\n${user}`;
}

function temperatureInstruction(t) {
  if (t === 0) {
    return [
      "Параметр генерации: temperature=0.",
      "Отвечай детерминированно: один канонический ход рассуждения, без альтернатив, без украшений, без шуток.",
      "Формулировки максимально сухие и однозначные.",
    ].join(" ");
  }
  if (t === 0.7) {
    return [
      "Параметр генерации: temperature=0.7.",
      "Допустима умеренная вариативность формулировок и пояснений, но держись фактов.",
      "Можно добавить краткую аналогию, если она помогает понять схему.",
    ].join(" ");
  }
  return [
    "Параметр генерации: temperature=1.2.",
    "Будь креативным: разнообразный стиль, неожиданные метафоры, несколько гипотез.",
    "Можно предлагать альтернативные схемы и спорные идеи, даже если они расходятся с каноном.",
  ].join(" ");
}

function wordCount(text) {
  return String(text).trim().split(/\s+/).filter(Boolean).length;
}

function creativityFlags(text) {
  const t = String(text).toLowerCase();
  return {
    analogy: /аналог|метафор|как если|словно|представь/.test(t),
    alternatives: /вариант|гипотез|альтернатив|предположим|другая схем|другой способ/.test(t),
    flourish: /шутк|образн|поэтич|красок|неожидан/.test(t),
  };
}

function creativityMetrics(result) {
  const text = result.combinedText || "";
  const flags = creativityFlags(text);
  const words = wordCount(text);
  let score = 0;
  if (flags.analogy) score += 1;
  if (flags.alternatives) score += 1;
  if (flags.flourish) score += 1;
  if (words > 400) score += 1;
  const label = score >= 3 ? "высокая" : score >= 1 ? "средняя" : "низкая";
  return { words, flags, score, label };
}

function formatCreativity(metrics) {
  const extras = [];
  if (metrics.flags.analogy) extras.push("аналогия");
  if (metrics.flags.alternatives) extras.push("альтернативы");
  if (metrics.flags.flourish) extras.push("вольный стиль");
  const extra = extras.length > 0 ? `, ${extras.join(", ")}` : "";
  return `${metrics.label} (${metrics.words} слов${extra})`;
}

function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    reasoningTokens: 0,
    known: false,
  };
}

function fromSdkUsage(usage) {
  if (!usage) return emptyUsage();
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
    known: true,
  };
}

function mergeUsage(a, b) {
  if (!a?.known && !b?.known) return emptyUsage();
  if (!a?.known) return { ...b };
  if (!b?.known) return { ...a };
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0),
    known: true,
  };
}

function formatUsage(usage) {
  if (!usage?.known) return "неизвестно";
  const reasoning =
    usage.reasoningTokens > 0 ? ` reasoning=${usage.reasoningTokens}` : "";
  return `in=${usage.inputTokens} out=${usage.outputTokens} total=${usage.totalTokens}${reasoning}`;
}

function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return "неизвестно";
  if (ms < 1000) return `${Math.round(ms)} мс`;
  return `${(ms / 1000).toFixed(1)} с`;
}

function formatCost(cost) {
  if (!cost || cost.usd == null) return "неизвестно";
  const usd =
    cost.usd < 0.0001 && cost.usd > 0 ? cost.usd.toExponential(2) : cost.usd.toFixed(6);
  const src =
    cost.source === "billed"
      ? "billed"
      : cost.source === "estimate"
        ? "оценка"
        : cost.source;
  return `$${usd} (${src})`;
}

function estimateCostUsd(modelId, usage) {
  const prices = MODEL_PRICES[modelId];
  if (!prices || !usage?.known) return null;
  return (
    (usage.inputTokens * prices.input +
      usage.outputTokens * prices.output +
      usage.cacheReadTokens * (prices.cacheRead ?? 0) +
      usage.cacheWriteTokens * (prices.cacheWrite ?? 0)) /
    1e6
  );
}

function fromBilledCost(agentUsage, modelId, tokenUsage) {
  const billed = agentUsage?.cost;
  if (billed && typeof billed.rawCostCents === "number" && billed.rawCostCents > 0) {
    return {
      usd: billed.rawCostCents / 100,
      source: "billed",
      rawCostCents: billed.rawCostCents,
      chargedCents: billed.chargedCents ?? null,
    };
  }
  const estimated = estimateCostUsd(modelId, tokenUsage);
  if (estimated != null) {
    return {
      usd: estimated,
      source: "estimate",
      rawCostCents: billed?.rawCostCents ?? null,
      chargedCents: billed?.chargedCents ?? null,
    };
  }
  return {
    usd: null,
    source: billed ? "included" : "unknown",
    rawCostCents: billed?.rawCostCents ?? null,
    chargedCents: billed?.chargedCents ?? null,
  };
}

function extractRaceCount(text) {
  if (!text) return null;
  const normalized = String(text)
    .replace(/\*\*/g, "")
    .replace(/[_*`#]/g, "")
    .replace(/‑/g, "-")
    .trim();
  const inRange = (n) => Number.isInteger(n) && n >= 1 && n <= 20;

  const head = normalized.slice(0, 500);
  const headRace = [...head.matchAll(/(\d+)\s*(?:забег|race)/gi)]
    .map((m) => Number(m[1]))
    .filter(inRange);
  if (headRace.length > 0) return headRace[0];

  const headClaim = head.match(
    /(?:ответ|итого|итог|минимум|минимальн\w*|нужно)[:\s—-]*(\d+)/i,
  );
  if (headClaim) {
    const n = Number(headClaim[1]);
    if (inRange(n)) return n;
  }

  const found = [];
  for (const match of normalized.matchAll(/(\d+)\s*(?:забег|race)/gi)) {
    const n = Number(match[1]);
    if (inRange(n)) found.push(n);
  }
  if (found.length > 0) return found[found.length - 1];

  const tail = [...normalized.slice(-500).matchAll(/\d+/g)]
    .map((m) => Number(m[0]))
    .filter((n) => inRange(n) && n !== 5 && n !== 25);
  return tail.length > 0 ? tail[tail.length - 1] : null;
}

function describesTop3Selection(text) {
  const t = String(text).toLowerCase();
  const place = /2\s*[–\-и,]\s*3|втор|треть|top\s*3|2nd|3rd/.test(t);
  const leftover = /претендент|кандидат|оставш|remaining|eliminat/.test(t);
  const groups = /групп|group|победител|winner/.test(t);
  return (place && leftover) || (place && groups);
}

function formatAnswer(n) {
  return n == null ? "не извлечено" : String(n);
}

function majorityAnswer(values) {
  const counts = new Map();
  for (const n of values) {
    if (n == null) continue;
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  if (counts.size === 0) return { answer: null, disputed: true };
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) {
    return { answer: null, disputed: true };
  }
  return { answer: ranked[0][0], disputed: false };
}

function printPart(title, part) {
  console.log(`\n[${title}]`);
  console.log(part.text.trim() || "(пусто)");
  const extras = [`токены: ${formatUsage(part.usage)}`];
  if (part.durationMs != null) extras.push(`время: ${formatDuration(part.durationMs)}`);
  if (part.cost) extras.push(`стоимость: ${formatCost(part.cost)}`);
  if (part.skipAnswer) {
    console.log(`  ${extras.join(" | ")}`);
    return;
  }
  console.log(`  ответ: ${formatAnswer(part.answer)} | ${extras.join(" | ")}`);
}

loadEnv(resolve(projectRoot, ".env"));

const API_KEY = process.env.CURSOR_API_KEY;
const MODEL = process.env.CURSOR_MODEL ?? "composer-2.5";
const RUNTIME = (process.env.CURSOR_RUNTIME ?? "local").toLowerCase();
const { mode, compare, compareTemp, compareModels, puzzle } = parseArgs(
  process.argv.slice(2),
);

const agentOptions = {
  apiKey: API_KEY,
  model: { id: MODEL },
  tools: [],
  ...(RUNTIME === "cloud"
    ? { cloud: { repos: [] } }
    : { local: { cwd: projectRoot } }),
};

async function runPrompt(prompt) {
  const result = await Agent.prompt(prompt, agentOptions);

  if (result.status === "error") {
    console.error("Ошибка Cursor:", result.error?.message ?? "unknown");
    process.exit(2);
  }

  const text = String(result.result ?? "");
  const usage = fromSdkUsage(result.usage);
  return { text, usage, answer: extractRaceCount(text) };
}

async function runDirect(task) {
  const part = await runPrompt(task);
  return {
    id: "direct",
    parts: [{ label: "direct", ...part }],
    answer: part.answer,
    disputed: false,
    usage: part.usage,
    combinedText: part.text,
  };
}

async function runStep(task) {
  const part = await runPrompt(`${task}\n\nРешай пошагово.`);
  return {
    id: "step",
    parts: [{ label: "step", ...part }],
    answer: part.answer,
    disputed: false,
    usage: part.usage,
    combinedText: part.text,
  };
}

async function runMeta(task) {
  const drafted = await runPrompt(
    [
      "Составь промпт для решения задачи ниже.",
      "Верни только текст промпта, без пояснений и без решения самой задачи.",
      "",
      task,
    ].join("\n"),
  );
  const solved = await runPrompt(
    `${drafted.text.trim()}\n\nЗадача:\n${task}`,
  );
  return {
    id: "meta",
    parts: [
      { label: "meta / составленный промпт", ...drafted, answer: null, skipAnswer: true },
      { label: "meta / решение", ...solved },
    ],
    answer: solved.answer,
    disputed: false,
    usage: mergeUsage(drafted.usage, solved.usage),
    combinedText: solved.text,
  };
}

async function runExperts(task) {
  const parts = [];
  for (const expert of EXPERTS) {
    const part = await runPrompt(composePrompt(expert.system, task));
    parts.push({ label: `experts / ${expert.label}`, ...part });
  }
  const { answer, disputed } = majorityAnswer(parts.map((p) => p.answer));
  return {
    id: "experts",
    parts,
    answer,
    disputed,
    usage: parts.reduce((acc, p) => mergeUsage(acc, p.usage), emptyUsage()),
    combinedText: parts.map((p) => p.text).join("\n"),
  };
}

async function runTemperature(task) {
  const results = [];
  for (const t of TEMPERATURES) {
    console.log(`\n--- запрос: temperature=${t} ---`);
    const part = await runPrompt(composePrompt(temperatureInstruction(t), task));
    const result = {
      id: `temp-${t}`,
      temperature: t,
      parts: [{ label: `temperature=${t}`, ...part }],
      answer: part.answer,
      disputed: false,
      usage: part.usage,
      combinedText: part.text,
    };
    saveResult(result);
    results.push(result);
  }
  return results;
}

function catalogHas(catalog, id) {
  const needle = String(id).toLowerCase();
  return catalog.some((m) => {
    if (String(m.id || "").toLowerCase() === needle) return true;
    return (m.aliases || []).some((alias) => String(alias).toLowerCase() === needle);
  });
}

function pickCandidates(tier) {
  const fromEnv = process.env[tier.envKey]?.trim();
  if (fromEnv) return [fromEnv, ...tier.defaults.filter((id) => id !== fromEnv)];
  return [...tier.defaults];
}

function selectionFor(id) {
  const model = { id };
  if (id === "composer-2.5") {
    model.params = [{ id: "fast", value: "false" }];
  }
  return model;
}

async function loadCatalog() {
  try {
    const models = await Cursor.models.list({ apiKey: API_KEY });
    return Array.isArray(models) ? models : [];
  } catch (err) {
    console.error(`Не удалось получить каталог моделей: ${err.message}`);
    return null;
  }
}

async function disposeAgent(agent) {
  if (!agent) return;
  if (typeof agent.close === "function") {
    agent.close();
    return;
  }
  if (typeof agent[Symbol.asyncDispose] === "function") {
    await agent[Symbol.asyncDispose]();
  }
}

async function runPromptOnModel(prompt, modelSelection) {
  const options = {
    ...agentOptions,
    model: modelSelection,
  };
  const wallStart = Date.now();
  let agent;
  try {
    agent = await Agent.create(options);
    const run = await agent.send(prompt);
    const result = await run.wait();
    const wallMs = Date.now() - wallStart;
    const durationMs = result.durationMs ?? wallMs;

    if (result.status === "error") {
      return { ok: false, error: result.error?.message ?? "unknown" };
    }

    const text = String(result.result ?? "");
    const usage = fromSdkUsage(result.usage);
    let billed = null;
    try {
      billed = await agent.getUsage();
    } catch {
      billed = null;
    }

    return {
      ok: true,
      text,
      usage,
      answer: extractRaceCount(text),
      durationMs,
      wallMs,
      cost: fromBilledCost(billed, modelSelection.id, usage),
      agentId: agent.agentId,
      runId: result.id,
    };
  } finally {
    await disposeAgent(agent);
  }
}

async function runModelTier(tier, catalog, task) {
  const candidates = pickCandidates(tier);
  const tried = [];
  for (const id of candidates) {
    const fromEnv = process.env[tier.envKey]?.trim();
    const envOverride = Boolean(fromEnv && id === fromEnv);
    if (catalog && !envOverride && !catalogHas(catalog, id)) {
      console.log(`  ${id}: нет в каталоге, пропуск`);
      tried.push({ id, error: "нет в каталоге" });
      continue;
    }
    console.log(`  пробую ${id}...`);
    try {
      const part = await runPromptOnModel(task, selectionFor(id));
      if (!part.ok) {
        console.log(`  ${id}: ошибка — ${part.error}`);
        tried.push({ id, error: part.error });
        continue;
      }
      return { modelId: id, tried, part };
    } catch (err) {
      const message =
        err instanceof CursorAgentError ? err.message : String(err.message || err);
      console.log(`  ${id}: ошибка — ${message}`);
      tried.push({ id, error: message });
    }
  }
  return { modelId: null, tried, part: null };
}

async function runModels(task) {
  console.log("каталог моделей: запрашиваю Cursor.models.list()...");
  const catalogRaw = await loadCatalog();
  const catalog = catalogRaw && catalogRaw.length > 0 ? catalogRaw : null;
  if (catalog) {
    const ids = catalog.map((m) => m.id).filter(Boolean);
    console.log(`каталог: ${catalog.length} моделей (${ids.slice(0, 15).join(", ")}${ids.length > 15 ? ", ..." : ""})`);
  } else {
    console.log("каталог недоступен — пробую id по умолчанию");
  }

  const results = [];
  for (const tier of MODEL_TIERS) {
    console.log(`\n--- запрос: ${tier.label} ---`);
    const { modelId, tried, part } = await runModelTier(tier, catalog, task);
    if (!part) {
      console.error(
        `Не удалось прогнать ${tier.label} модель. Пробовали: ${tried
          .map((t) => `${t.id} (${t.error})`)
          .join("; ")}`,
      );
      continue;
    }
    const result = {
      id: tier.id,
      tier: tier.tier,
      label: tier.label,
      modelId,
      tried,
      durationMs: part.durationMs,
      wallMs: part.wallMs,
      cost: part.cost,
      parts: [
        {
          label: `${tier.label} (${modelId})`,
          text: part.text,
          usage: part.usage,
          answer: part.answer,
          durationMs: part.durationMs,
          cost: part.cost,
        },
      ],
      answer: part.answer,
      disputed: false,
      usage: part.usage,
      combinedText: part.text,
    };
    saveResult(result);
    results.push(result);
  }
  return results;
}

const runners = {
  direct: runDirect,
  step: runStep,
  meta: runMeta,
  experts: runExperts,
};

function printSolutions(results) {
  console.log("===== РЕШЕНИЯ =====");
  for (const result of results) {
    for (const part of result.parts) {
      printPart(part.label, part);
    }
    if (result.id === "experts") {
      const detail = result.parts
        .map((p) => `${p.label.replace("experts / ", "")}=${formatAnswer(p.answer)}`)
        .join(", ");
      console.log(
        `  канон experts: ${result.disputed ? "спор" : formatAnswer(result.answer)} (${detail}) | токены сумма: ${formatUsage(result.usage)}`,
      );
    }
    if (result.id === "meta") {
      console.log(`  канон meta: ${formatAnswer(result.answer)} | токены сумма: ${formatUsage(result.usage)}`);
    }
  }
}

function answersDiffer(results) {
  const values = results.map((r) => (r.disputed ? "спор" : formatAnswer(r.answer)));
  return new Set(values).size > 1;
}

function closestToEtalon(results) {
  const scored = results
    .filter((r) => r.answer != null && !r.disputed)
    .map((r) => ({ id: r.id, answer: r.answer, dist: Math.abs(r.answer - ETALON) }))
    .sort((a, b) => a.dist - b.dist || a.id.localeCompare(b.id));
  if (scored.length === 0) return [];
  return scored.filter((s) => s.dist === scored[0].dist);
}

function mostAccurate(results) {
  const exact = results.filter((r) => !r.disputed && r.answer === ETALON);
  if (exact.length === 1) {
    return `Наиболее точный способ: ${exact[0].id}.`;
  }
  if (exact.length > 1) {
    const explained = exact.filter((r) => describesTop3Selection(r.combinedText));
    const winners = explained.length > 0 ? explained : exact;
    if (winners.length === 1) {
      return `Наиболее точный способ: ${winners[0].id}.`;
    }
    return `Наиболее точный способ: ничья (${winners.map((r) => r.id).join(", ")}).`;
  }
  const closest = closestToEtalon(results);
  if (closest.length === 0) {
    return "Наиболее точный способ: ни один не дал эталон; число забегов не извлечено.";
  }
  if (closest.length === 1) {
    return `Наиболее точный способ: ни один не дал эталон; ближе всех ${closest[0].answer} у способа ${closest[0].id}.`;
  }
  return `Наиболее точный способ: ни один не дал эталон; ближе всех ${closest[0].answer} у ${closest.map((c) => c.id).join(", ")}.`;
}

function tokenVerdict(results) {
  const known = results.filter((r) => r.usage.known);
  if (known.length === 0) {
    return "Токены: usage не пришёл ни у одного способа.";
  }
  const byTotal = [...known].sort((a, b) => b.usage.totalTokens - a.usage.totalTokens);
  const most = byTotal[0];
  const least = byTotal[byTotal.length - 1];
  const exactCheap = [...known]
    .filter((r) => !r.disputed && r.answer === ETALON)
    .sort((a, b) => a.usage.totalTokens - b.usage.totalTokens);
  const cheapExact =
    exactCheap.length > 0
      ? `; среди точных дешевле всех ${exactCheap[0].id} (${exactCheap[0].usage.totalTokens})`
      : "";
  return `Токены: больше всех ${most.id} (${most.usage.totalTokens}), меньше всех ${least.id} (${least.usage.totalTokens})${cheapExact}.`;
}

function printComparison(results) {
  const numbers = results
    .map((r) => {
      if (r.id === "experts") {
        const inner = r.parts
          .map((p) => `${p.label.replace("experts / ", "")}=${formatAnswer(p.answer)}`)
          .join(", ");
        const canon = r.disputed ? "спор" : formatAnswer(r.answer);
        return `${r.id}=${canon} (${inner})`;
      }
      return `${r.id}=${formatAnswer(r.answer)}`;
    })
    .join(" | ");
  const tokens = results
    .map((r) => `${r.id}=${r.usage.known ? r.usage.totalTokens : "неизвестно"}`)
    .join(" | ");

  const differ = answersDiffer(results);
  let differText;
  if (!differ) {
    differText = `Отличаются ли ответы: нет. Все способы дали ${formatAnswer(results[0].answer)}.`;
  } else {
    const detail = results
      .map((r) => `${r.id}=${r.disputed ? "спор" : formatAnswer(r.answer)}`)
      .join(", ");
    const expertSplit = results.find((r) => r.id === "experts" && r.disputed)
      ? " Роли experts внутри разошлись."
      : results.find((r) => r.id === "experts")
        ? ` Роли experts: ${results
            .find((r) => r.id === "experts")
            .parts.map((p) => `${p.label.replace("experts / ", "")}=${formatAnswer(p.answer)}`)
            .join(", ")}.`
        : "";
    differText = `Отличаются ли ответы: да. ${detail}.${expertSplit}`;
  }

  console.log("\n===== СРАВНЕНИЕ =====");
  console.log(`числа: ${numbers}`);
  console.log(`эталон: ${ETALON}`);
  console.log(`токены: ${tokens}`);
  console.log(differText);
  console.log(mostAccurate(results));
  console.log(tokenVerdict(results));
}

function accuracyLine(results) {
  return results
    .map((r) => {
      if (r.answer == null) return `${r.id} число не извлечено`;
      return r.answer === ETALON
        ? `${r.id} совпал`
        : `${r.id} ошибка (${r.answer})`;
    })
    .join(", ");
}

function diversityLine(results) {
  const numbersDiffer = answersDiffer(results);
  const texts = results.map((r) => (r.combinedText || "").trim());
  const textsDiffer = new Set(texts).size > 1;
  const wordCounts = results.map((r) => wordCount(r.combinedText || ""));
  const wordSpread = Math.max(...wordCounts) - Math.min(...wordCounts);
  const parts = [];
  parts.push(textsDiffer ? "тексты отличаются" : "тексты совпали");
  parts.push(numbersDiffer ? "числа разошлись" : "числа совпали");
  if (wordSpread >= 80) parts.push(`разброс длины ${wordSpread} слов`);
  return parts.join("; ");
}

function temperatureVerdict(results) {
  const exact = results.filter((r) => r.answer === ETALON);
  const accuracyNote =
    exact.length === 0
      ? "Ни одна настройка не попала в эталон 8."
      : exact.length === results.length
        ? "Все настройки попали в эталон 8."
        : `Ближе к эталону: ${exact.map((r) => r.id).join(", ")}.`;
  return [
    accuracyNote,
    "temperature=0 лучше для фактов, классификации, извлечения, математики и JSON.",
    "temperature=0.7 лучше для объяснений, чата и учебных ответов.",
    "temperature=1.2 лучше для мозгового штурма, нейминга и черновиков — ценой риска галлюцинаций.",
  ].join(" ");
}

function printTemperatureComparison(results) {
  const numbers = results
    .map((r) => `${r.id}=${formatAnswer(r.answer)}`)
    .join(" | ");
  const creativity = results
    .map((r) => `${r.id} ${formatCreativity(creativityMetrics(r))}`)
    .join(" | ");

  console.log("\n===== СРАВНЕНИЕ TEMPERATURE =====");
  console.log(`числа: ${numbers}`);
  console.log(`эталон: ${ETALON}`);
  console.log(`точность: ${accuracyLine(results)}`);
  console.log(`креативность: ${creativity}`);
  console.log(`разнообразие: ${diversityLine(results)}`);
  console.log(temperatureVerdict(results));
}

function qualityLabel(result) {
  if (result.answer == null) return "число не извлечено";
  const exact = result.answer === ETALON ? "эталон" : `ошибка (${result.answer})`;
  const scheme = describesTop3Selection(result.combinedText)
    ? "схема top-3 есть"
    : "схема top-3 слабая";
  return `${exact}, ${scheme}`;
}

function modelsVerdict(results) {
  const exact = results.filter((r) => r.answer === ETALON);
  const quality =
    exact.length === 0
      ? "Ни одна модель не попала в эталон 8."
      : exact.length === results.length
        ? "Все модели попали в эталон 8."
        : `Точнее: ${exact.map((r) => `${r.label} (${r.modelId})`).join(", ")}.`;

  const withTime = results.filter((r) => r.durationMs != null);
  let speed = "";
  if (withTime.length > 0) {
    const fastest = [...withTime].sort((a, b) => a.durationMs - b.durationMs)[0];
    speed = `Быстрее всех ${fastest.label} (${formatDuration(fastest.durationMs)}).`;
  }

  const withCost = results.filter((r) => r.cost?.usd != null);
  const withTokens = results.filter((r) => r.usage?.known);
  let resources = "";
  if (withCost.length > 0) {
    const cheapest = [...withCost].sort((a, b) => a.cost.usd - b.cost.usd)[0];
    resources = `Дешевле всех ${cheapest.label} (${formatCost(cheapest.cost)}).`;
  } else if (withTokens.length > 0) {
    const leanest = [...withTokens].sort(
      (a, b) => a.usage.totalTokens - b.usage.totalTokens,
    )[0];
    resources = `Меньше токенов у ${leanest.label} (${leanest.usage.totalTokens}).`;
  }

  return [quality, speed, resources].filter(Boolean).join(" ");
}

function printModelComparison(results) {
  const numbers = results
    .map((r) => `${r.label}=${formatAnswer(r.answer)} (${r.modelId})`)
    .join(" | ");
  const times = results
    .map((r) => `${r.label}=${formatDuration(r.durationMs)}`)
    .join(" | ");
  const tokens = results
    .map((r) => `${r.label}=${r.usage?.known ? r.usage.totalTokens : "неизвестно"}`)
    .join(" | ");
  const costs = results.map((r) => `${r.label}=${formatCost(r.cost)}`).join(" | ");
  const quality = results.map((r) => `${r.label}: ${qualityLabel(r)}`).join(" | ");

  console.log("\n===== СРАВНЕНИЕ МОДЕЛЕЙ =====");
  console.log(`числа: ${numbers}`);
  console.log(`эталон: ${ETALON}`);
  console.log(`качество: ${quality}`);
  console.log(`скорость: ${times}`);
  console.log(`токены: ${tokens}`);
  console.log(`стоимость: ${costs}`);
  console.log(modelsVerdict(results));
}

try {
  if (compareTemp) {
    const missing = TEMP_IDS.filter((id) => !loadResult(id));
    if (missing.length > 0) {
      console.error(
        `Для сравнения temperature сначала прогоните: npm start -- --mode temperature (нет ${missing.join(", ")})`,
      );
      process.exit(1);
    }
    const results = TEMP_IDS.map((id) => loadResult(id));
    printSolutions(results);
    printTemperatureComparison(results);
  } else if (compareModels) {
    const missing = MODEL_IDS.filter((id) => !loadResult(id));
    if (missing.length > 0) {
      console.error(
        `Для сравнения моделей сначала прогоните: npm start -- --mode models (нет ${missing.join(", ")})`,
      );
      process.exit(1);
    }
    const results = MODEL_IDS.map((id) => loadResult(id));
    printSolutions(results);
    printModelComparison(results);
  } else if (compare) {
    const missing = PROMPT_MODES.filter((id) => !loadResult(id));
    if (missing.length > 0) {
      console.error(
        `Для сравнения сначала прогоните недостающие режимы: ${missing
          .map((id) => `--mode ${id}`)
          .join(", ")}`,
      );
      process.exit(1);
    }
    const results = PROMPT_MODES.map((id) => loadResult(id));
    printSolutions(results);
    printComparison(results);
  } else {
    if (!API_KEY) {
      console.error("В .env задайте CURSOR_API_KEY");
      process.exit(1);
    }

    console.log(`задача: ${puzzle}`);
    console.log(`режим: ${mode}`);
    if (mode === "models") {
      console.log("модели: слабая / средняя / сильная");
    } else {
      console.log(`модель: ${MODEL}`);
    }

    if (mode === "temperature") {
      const results = await runTemperature(puzzle);
      console.log("");
      printSolutions(results);
      printTemperatureComparison(results);
      console.log("\nРезультаты сохранены в results/temp-0.json, temp-0.7.json, temp-1.2.json");
      console.log("Повторить сравнение без API: npm start -- --compare-temp");
    } else if (mode === "models") {
      const results = await runModels(puzzle);
      if (results.length === 0) {
        console.error("Ни одна модель не ответила.");
        process.exit(2);
      }
      console.log("");
      printSolutions(results);
      printModelComparison(results);
      console.log(
        "\nРезультаты сохранены в results/model-weak.json, model-medium.json, model-strong.json",
      );
      console.log("Повторить сравнение без API: npm start -- --compare-models");
    } else {
      console.log(`\n--- запрос: ${mode} ---`);
      const result = await runners[mode](puzzle);
      saveResult(result);
      console.log("");
      printSolutions([result]);
      console.log(`\nРезультат сохранён в results/${mode}.json`);
      console.log("Когда прогоните все четыре режима: npm start -- --compare");
    }
  }
} catch (err) {
  if (err instanceof CursorAgentError) {
    const hint =
      RUNTIME === "cloud"
        ? "\nДля cloud включите Storage mode в настройках Cursor или задайте CURSOR_RUNTIME=local"
        : "";
    console.error(`Не удалось запустить агента: ${err.message}${hint}`);
    process.exit(1);
  }
  throw err;
}
