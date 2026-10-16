import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertCursorApiKey, loadEnv } from "../../src/env.js";
import { indexLaw } from "../../src/doc-index/pipeline.js";
import { writeJsonAtomic } from "../../src/fs-utils.js";

export function initBenchEnv(callerImportMetaUrl) {
  const projectRoot = resolve(dirname(fileURLToPath(callerImportMetaUrl)), "..");
  loadEnv(resolve(projectRoot, ".env"));
  const apiKey = assertCursorApiKey(process.env.CURSOR_API_KEY);
  const model = process.env.CURSOR_MODEL ?? "composer-2.5";
  const runtime = (process.env.CURSOR_RUNTIME ?? "local").toLowerCase();
  return { projectRoot, apiKey, model, runtime };
}

export function ensureLawIndex(projectRoot) {
  const lawPath = resolve(projectRoot, "data", "doc-index", "law.sqlite");
  if (!existsSync(lawPath)) indexLaw(projectRoot);
  return lawPath;
}

export function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function askWithRetry(agent, text, options, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await agent.ask(text, options);
    } catch (err) {
      lastErr = err;
      console.error(
        `  retry ${i}/${attempts} ${agent.name}: ${err.message ?? err}`,
      );
      await sleep(2000 * i);
    }
  }
  throw lastErr;
}

export function writeBenchJson(filePath, data) {
  writeJsonAtomic(filePath, data);
}

export function expectHit(pattern, text) {
  return new RegExp(pattern, "i").test(String(text ?? ""));
}

export function articleHit(article, sources) {
  return (sources ?? []).some((source) =>
    String(source.section ?? "").startsWith(article),
  );
}
