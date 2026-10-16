import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const templateRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_REL = ".github/workflows/ai-review.yml";

export function assistantRepoRef() {
  const repo = process.env.DEV_ASSISTANT_GITHUB_REPO?.trim() || "Alexandr827/AI-Advent-Challenge";
  const ref = process.env.DEV_ASSISTANT_GITHUB_REF?.trim() || "main";
  return { repo, ref };
}

export async function resolveAssistantRepo(projectRoot) {
  if (process.env.DEV_ASSISTANT_GITHUB_REPO?.trim()) {
    return assistantRepoRef();
  }
  try {
    const url = await runGit(templateRoot, ["remote", "get-url", "origin"]);
    const parsed = parseGithubRemote(url);
    if (parsed) return { repo: parsed, ref: assistantRepoRef().ref };
  } catch {
    // ignore
  }
  return assistantRepoRef();
}

export function renderProjectWorkflow({ repo, ref }) {
  const templatePath = join(templateRoot, "templates", "project-pr-review.yml");
  const template = readFileSync(templatePath, "utf8");
  return template
    .replaceAll("{{ASSISTANT_REPO}}", repo)
    .replaceAll("{{ASSISTANT_REF}}", ref);
}

export async function gitRemoteRepo(projectRoot) {
  try {
    const url = await runGit(projectRoot, ["remote", "get-url", "origin"]);
    return parseGithubRemote(url);
  } catch {
    return null;
  }
}

export function parseGithubRemote(url) {
  const raw = String(url ?? "").trim();
  const ssh = /^git@github\.com:(.+?)(?:\.git)?$/i.exec(raw);
  if (ssh) return ssh[1];
  const https = /^https:\/\/github\.com\/(.+?)(?:\.git)?$/i.exec(raw);
  if (https) return https[1];
  return null;
}

export function installPrWorkflow(projectRoot, options = {}) {
  const root = resolve(projectRoot);
  const assistant = options.assistant ?? assistantRepoRef();
  const body = renderProjectWorkflow(assistant);
  const target = join(root, WORKFLOW_REL);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
  return { target, assistant };
}

async function runGit(cwd, args) {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

