/**
 * Одна задача про 25 лошадей — четыре способа промптинга через Cursor SDK.
 * Одна команда = один способ. Сравнение — отдельный флаг по сохранённым ответам.
 *
 * Переменные из .env:
 *   CURSOR_API_KEY  — ключ из Cursor Dashboard → Integrations
 *   CURSOR_MODEL    — опционально, по умолчанию composer-2.5
 *   CURSOR_RUNTIME  — local (по умолчанию) или cloud
 *
 *   npm start -- --mode direct
 *   npm start -- --mode step
 *   npm start -- --mode meta
 *   npm start -- --mode experts
 *   npm start -- --compare
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, CursorAgentError } from "@cursor/sdk";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resultsDir = resolve(projectRoot, "results");
const MODES = ["direct", "step", "meta", "experts"];
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
    return JSON.parse(readFileSync(resultPath(id), "utf8"));
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  let mode = null;
  let compare = false;
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

  if (compare && mode) {
    console.error("Не совмещайте --mode и --compare. Сначала прогоните каждый режим, затем --compare.");
    process.exit(1);
  }
  if (!compare && !mode) {
    printUsage();
    process.exit(1);
  }

  return {
    mode,
    compare,
    puzzle: positional.join(" ").trim() || DEFAULT_PUZZLE,
  };
}

function composePrompt(system, user) {
  if (!system) return user;
  return `${system}\n\nЗадача:\n${user}`;
}

function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
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
    known: true,
  };
}

function formatUsage(usage) {
  if (!usage?.known) return "неизвестно";
  return `in=${usage.inputTokens} out=${usage.outputTokens} total=${usage.totalTokens}`;
}

function extractRaceCount(text) {
  if (!text) return null;
  const found = [];
  const patterns = [
    /(\d+)\s*(?:забег|race)/gi,
    /(?:ответ|итого|минимум|минимальн\w*|нужно|потребуется|достаточно|итогом)[:\s—-]*(\d+)/gi,
  ];

  for (const re of patterns) {
    for (const match of text.matchAll(re)) {
      const n = Number(match[1]);
      if (Number.isInteger(n) && n >= 1 && n <= 20) found.push(n);
    }
  }

  if (found.length > 0) return found[found.length - 1];

  const tail = text.slice(-500);
  const loose = [...tail.matchAll(/\b(\d+)\b/g)]
    .map((m) => Number(m[1]))
    .filter((n) => n >= 1 && n <= 20 && n !== 5 && n !== 25);
  return loose.length > 0 ? loose[loose.length - 1] : null;
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
  if (part.skipAnswer) {
    console.log(`  токены: ${formatUsage(part.usage)}`);
    return;
  }
  console.log(`  ответ: ${formatAnswer(part.answer)} | токены: ${formatUsage(part.usage)}`);
}

loadEnv(resolve(projectRoot, ".env"));

const API_KEY = process.env.CURSOR_API_KEY;
const MODEL = process.env.CURSOR_MODEL ?? "composer-2.5";
const RUNTIME = (process.env.CURSOR_RUNTIME ?? "local").toLowerCase();
const { mode, compare, puzzle } = parseArgs(process.argv.slice(2));

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

try {
  if (compare) {
    const missing = MODES.filter((id) => !loadResult(id));
    if (missing.length > 0) {
      console.error(
        `Для сравнения сначала прогоните недостающие режимы: ${missing
          .map((id) => `--mode ${id}`)
          .join(", ")}`,
      );
      process.exit(1);
    }
    const results = MODES.map((id) => loadResult(id));
    printSolutions(results);
    printComparison(results);
  } else {
    if (!API_KEY) {
      console.error("В .env задайте CURSOR_API_KEY");
      process.exit(1);
    }

    console.log(`задача: ${puzzle}`);
    console.log(`режим: ${mode}`);
    console.log(`модель: ${MODEL}`);
    console.log(`\n--- запрос: ${mode} ---`);

    const result = await runners[mode](puzzle);
    saveResult(result);
    console.log("");
    printSolutions([result]);
    console.log(`\nРезультат сохранён в results/${mode}.json`);
    console.log("Когда прогоните все четыре режима: npm start -- --compare");
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
