import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isMainModule, serveStdio } from "./mcp-serve.js";
import { isPathInsideRoot } from "./path-utils.js";

const execFileAsync = promisify(execFile);

export const FILE_LIST_LIMIT = 200;
export const DIFF_LIMIT = 8000;

const SKIP_DIRS = new Set(["node_modules", ".git", "data"]);
const LIST_EXT = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".md",
  ".txt",
  ".markdown",
  ".json",
  ".yml",
  ".yaml",
  ".sql",
  ".prisma",
  ".graphql",
  ".gql",
]);

const repoSchema = z
  .string()
  .min(1)
  .optional()
  .describe("Путь внутри каталога проекта. Если не указан — cwd MCP-сервера");

export async function gitBranch(repo = process.cwd(), options = {}) {
  const target = resolveInside(repo, options);
  if (!target.ok) return target;
  try {
    const text = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], target.path);
    return { ok: true, text: text || "HEAD" };
  } catch (error) {
    return { ok: false, text: gitError(error) };
  }
}

export function listFiles(repo = process.cwd(), options = {}) {
  const target = resolveInside(repo, options);
  if (!target.ok) return target;
  const files = [];
  walk(target.path, target.path, files);
  files.sort();
  const shown = files.slice(0, FILE_LIST_LIMIT);
  const lines = [...shown];
  if (files.length > shown.length) {
    lines.push(`… ещё ${files.length - shown.length}`);
  }
  return { ok: true, text: lines.join("\n") || "Файлов нет" };
}

export async function gitDiff(repo = process.cwd(), options = {}) {
  const target = resolveInside(repo, options);
  if (!target.ok) return target;
  try {
    const unstaged = await runGit(["diff", "--"], target.path);
    const staged = await runGit(["diff", "--cached", "--"], target.path);
    const parts = [];
    if (unstaged) parts.push(`unstaged:\n${unstaged}`);
    if (staged) parts.push(`staged:\n${staged}`);
    let text = parts.join("\n\n") || "Изменений нет.";
    if (text.length > DIFF_LIMIT) {
      text = `${text.slice(0, DIFF_LIMIT)}\n… обрезано`;
    }
    return { ok: true, text };
  } catch (error) {
    return { ok: false, text: gitError(error) };
  }
}

export function createProjectMcpServer() {
  const server = new McpServer({
    name: "project-mcp",
    version: "1.0.0",
  });

  const asTool = (result) => ({
    content: [{ type: "text", text: result.text }],
    ...(result.ok ? {} : { isError: true }),
  });

  server.registerTool(
    "git_branch",
    {
      description: "Текущая git-ветка репозитория (git rev-parse --abbrev-ref HEAD)",
      inputSchema: z.object({ repo: repoSchema }),
    },
    async ({ repo }) => asTool(await gitBranch(repo)),
  );

  server.registerTool(
    "list_files",
    {
      description:
        "Список файлов проекта: исходники и документация, без node_modules, .git и data",
      inputSchema: z.object({ repo: repoSchema }),
    },
    async ({ repo }) => asTool(listFiles(repo)),
  );

  server.registerTool(
    "git_diff",
    {
      description: "Незакоммиченные изменения: git diff и git diff --cached, вывод обрезан",
      inputSchema: z.object({ repo: repoSchema }),
    },
    async ({ repo }) => asTool(await gitDiff(repo)),
  );

  return server;
}

function resolveInside(repo, options) {
  const projectRoot = resolve(options.root ?? process.cwd());
  const target = resolve(repo ?? projectRoot);
  if (!isPathInsideRoot(projectRoot, target)) {
    return {
      ok: false,
      text: "Путь repo должен быть внутри каталога проекта (корень — cwd MCP-сервера)",
    };
  }
  return { ok: true, path: target };
}

function walk(root, dir, files) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    if (entry.name === "package-lock.json") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(root, abs, files);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!LIST_EXT.has(extname(entry.name).toLowerCase())) continue;
    const rel = relative(root, abs).split(sep).join("/");
    if (rel) files.push(rel);
  }
}

async function runGit(args, cwd) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout.replace(/\s+$/u, "");
}

function gitError(error) {
  const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
  return stderr || error.message || "git failed";
}

if (isMainModule(import.meta.url)) {
  await serveStdio(createProjectMcpServer, "project-mcp");
}
