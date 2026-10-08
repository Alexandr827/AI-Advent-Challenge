import { readFileSync } from "node:fs";

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function loadEnv(path) {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim().replace(/\r$/, "");
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!ENV_KEY_PATTERN.test(key)) continue;
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (err) {
    if (err?.code === "ENOENT") {
      console.error(`Не найден файл ${path}`);
    } else {
      console.error(`Не удалось прочитать ${path}: ${err.message}`);
    }
    process.exit(1);
  }
}

export const PLACEHOLDER_CURSOR_API_KEY = "cursor_your-key-here";

export function assertCursorApiKey(apiKey, { exit = true } = {}) {
  const key = apiKey?.trim();
  if (!key || key === PLACEHOLDER_CURSOR_API_KEY) {
    const message =
      "Задайте реальный CURSOR_API_KEY в .env (не cursor_your-key-here)";
    if (exit) {
      console.error(message);
      process.exit(1);
    }
    throw new Error(message);
  }
  return key;
}
