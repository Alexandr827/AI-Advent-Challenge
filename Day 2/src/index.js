/**
 * Вызов модели Cursor через SDK с разным уровнем контроля ответа.
 *
 * Переменные из .env:
 *   CURSOR_API_KEY  — ключ из Cursor Dashboard → Integrations
 *   CURSOR_MODEL    — опционально, по умолчанию composer-2.5
 *   CURSOR_RUNTIME  — local (по умолчанию) или cloud
 *
 *   npm start -- --mode free -- "Хочу декомпозировать требование"
 *   npm start -- --mode constrained -- "Хочу декомпозировать требование"
 *   npm start -- --compare -- "Хочу декомпозировать требование"
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, CursorAgentError } from "@cursor/sdk";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STOP_MARKER = "###END###";
const MAX_CHARS = 1000;
const MAX_USER_STORIES = 5;
const MAX_ACCEPTANCE_CRITERIA = 4;
const DEFAULT_PROMPT = "Хочу декомпозировать требование";
const OFF_TOPIC_REPLY =
  "Я не могу рассказать об этом, потому что я — Requirements AI Assistant, и я работаю только с вопросами по декомпозиции требований. Пожалуйста, задайте вопрос по теме.";

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

function parseArgs(argv) {
  let mode = "free";
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
      if (value !== "free" && value !== "constrained") {
        console.error('Ожидается --mode free или --mode constrained');
        process.exit(1);
      }
      mode = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      const value = arg.slice("--mode=".length);
      if (value !== "free" && value !== "constrained") {
        console.error('Ожидается --mode free или --mode constrained');
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

  return {
    mode,
    compare,
    prompt: positional.join(" ").trim() || DEFAULT_PROMPT,
  };
}

function buildRolePreamble(userPrompt) {
  return [
    "Ты — Requirements AI Assistant. Ты работаешь только с декомпозицией требований.",
    "",
    "Запрос пользователя:",
    userPrompt,
    "",
    "Если запрос не про декомпозицию требований (кино, еда, политика, технологии, личные вопросы и любые другие темы) — ответь строго одной фразой и ничего больше:",
    OFF_TOPIC_REPLY,
  ].join("\n");
}

function buildFreePrompt(userPrompt) {
  return [
    buildRolePreamble(userPrompt),
    "",
    "Если запрос про декомпозицию требований — декомпозируй его свободным текстом.",
  ].join("\n");
}

function buildConstrainedPrompt(userPrompt) {
  return [
    buildRolePreamble(userPrompt),
    `После этой фразы сразу напиши ${STOP_MARKER}. Никаких дополнительных пояснений, советов или переходов на другие темы.`,
    "",
    "Если запрос про декомпозицию требований — ответь строго по правилам ниже.",
    "",
    "Формат ответа — только JSON, без markdown, без пояснений, без кода в тройных кавычках.",
    "Каркас всегда один и тот же:",
    "{",
    '  "requirement": "string",',
    '  "user_stories": [',
    "    {",
    '      "id": "US-1",',
    '      "as_a": "string",',
    '      "i_want": "string",',
    '      "so_that": "string",',
    '      "acceptance_criteria": ["string"]',
    "    }",
    "  ]",
    "}",
    `Не больше ${MAX_USER_STORIES} user stories.`,
    `У каждой user story не больше ${MAX_ACCEPTANCE_CRITERIA} acceptance criteria.`,
    `Весь JSON не длиннее ${MAX_CHARS} символов.`,
    `После JSON сразу напиши ${STOP_MARKER} и ничего больше.`,
  ].join("\n");
}

function applyStop(text) {
  const index = text.indexOf(STOP_MARKER);
  if (index === -1) return text;
  return text.slice(0, index).trimEnd();
}

function analyze(text) {
  const hasStop = text.includes(STOP_MARKER);
  const truncated = applyStop(text);
  const jsonCandidate = truncated
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let parsed = null;
  let jsonOk = false;
  try {
    parsed = JSON.parse(jsonCandidate);
    jsonOk = true;
  } catch {
    jsonOk = false;
  }

  const stripped = applyStop(text).trim();
  const offTopic = stripped === OFF_TOPIC_REPLY || stripped.startsWith(OFF_TOPIC_REPLY);

  return {
    raw: text,
    truncated,
    chars: text.length,
    hasStop,
    jsonOk,
    parsed,
    offTopic,
  };
}

function printResult(label, analysis) {
  console.log(`\n===== ${label} =====`);
  console.log(analysis.raw);
  console.log("-----");
  console.log(`длина: ${analysis.chars} символов`);
  console.log(`маркер ${STOP_MARKER}: ${analysis.hasStop ? "есть" : "нет"}`);
  console.log(`оффтоп-отказ: ${analysis.offTopic ? "да" : "нет"}`);
  console.log(`JSON.parse: ${analysis.jsonOk ? "ok" : "fail"}`);
  if (analysis.jsonOk) {
    console.log("разобранный JSON:");
    console.log(JSON.stringify(analysis.parsed, null, 2));
  }
}

loadEnv(resolve(projectRoot, ".env"));

const API_KEY = process.env.CURSOR_API_KEY;
const MODEL = process.env.CURSOR_MODEL ?? "composer-2.5";
const RUNTIME = (process.env.CURSOR_RUNTIME ?? "local").toLowerCase();
const { mode, compare, prompt: userPrompt } = parseArgs(process.argv.slice(2));

if (!API_KEY) {
  console.error("В .env задайте CURSOR_API_KEY");
  process.exit(1);
}

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

  return String(result.result ?? "");
}

try {
  const modes = compare ? ["free", "constrained"] : [mode];

  console.log(`запрос: ${userPrompt}`);
  console.log(`режим: ${compare ? "compare (free + constrained)" : mode}`);

  for (const currentMode of modes) {
    const prompt =
      currentMode === "constrained"
        ? buildConstrainedPrompt(userPrompt)
        : buildFreePrompt(userPrompt);
    const text = await runPrompt(prompt);
    printResult(currentMode, analyze(text));
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
