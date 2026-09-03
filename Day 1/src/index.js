/**
 * Вызов модели Cursor через SDK.
 *
 * Переменные из .env:
 *   CURSOR_API_KEY  — ключ из Cursor Dashboard → Integrations
 *   CURSOR_MODEL    — опционально, по умолчанию composer-2.5
 *   CURSOR_RUNTIME  — local (по умолчанию) или cloud
 *
 *   npm start -- "Привет! Кто ты?"
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, CursorAgentError } from "@cursor/sdk";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

loadEnv(resolve(projectRoot, ".env"));

const API_KEY = process.env.CURSOR_API_KEY;
const MODEL = process.env.CURSOR_MODEL ?? "composer-2.5";
const RUNTIME = (process.env.CURSOR_RUNTIME ?? "local").toLowerCase();
const prompt = process.argv.slice(2).join(" ") || "Скажи одно короткое приветствие.";

if (!API_KEY) {
  console.error("В .env задайте CURSOR_API_KEY");
  process.exit(1);
}

const agentOptions = {
  apiKey: API_KEY,
  model: { id: MODEL },
  ...(RUNTIME === "cloud"
    ? { cloud: { repos: [] } }
    : { local: { cwd: projectRoot } }),
};

try {
  const result = await Agent.prompt(prompt, agentOptions);

  if (result.status === "error") {
    console.error("Ошибка Cursor:", result.error?.message ?? "unknown");
    process.exit(2);
  }

  console.log(result.result ?? "");
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
