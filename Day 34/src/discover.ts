import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT } from "./paths.js";

const MAX_DEPTH = 2;
const MAX_VISITED = 8000;

const WALK_SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".turbo",
  "out",
  "Library",
  "Applications",
  "Movies",
  "Music",
  "Pictures",
  "Public",
]);

export function projectRoots(envValue = process.env.PROJECTS_ROOT): string[] {
  const raw = envValue?.trim();
  if (!raw) {
    return [os.homedir()];
  }
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
}

function isInsideRepo(candidate: string): boolean {
  const root = path.resolve(REPO_ROOT);
  return candidate === root || candidate.startsWith(root + path.sep);
}

export async function findProjectDirs(name: string, roots: string[]): Promise<string[]> {
  const needle = name.toLowerCase();
  const matches: string[] = [];
  let visited = 0;
  let truncated = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || truncated) {
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) {
        return;
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue;
      }
      if (entry.name.startsWith(".") || WALK_SKIP.has(entry.name)) {
        continue;
      }
      visited += 1;
      if (visited > MAX_VISITED) {
        truncated = true;
        return;
      }
      const abs = path.join(dir, entry.name);
      if (isInsideRepo(abs)) {
        continue;
      }
      if (entry.name.toLowerCase() === needle) {
        matches.push(abs);
        continue;
      }
      if (depth < MAX_DEPTH) {
        await walk(abs, depth + 1);
      }
    }
  }

  for (const root of roots) {
    let rootStat;
    try {
      rootStat = await fs.stat(root);
    } catch {
      continue;
    }
    if (!rootStat.isDirectory()) {
      continue;
    }
    const realRoot = await fs.realpath(root);
    if (path.basename(realRoot).toLowerCase() === needle && !isInsideRepo(realRoot)) {
      matches.push(realRoot);
      continue;
    }
    await walk(realRoot, 1);
  }

  if (truncated && matches.length !== 1) {
    throw new Error(
      `Project search stopped after ${MAX_VISITED} directories. Set PROJECTS_ROOT to the folder that contains ${name}.`,
    );
  }

  return matches;
}

export async function resolveProjectSource(name: string, roots: string[]): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Project name is required.");
  }
  if (trimmed.split(/[/\\]/).includes("..")) {
    throw new Error(`Project name must be a single folder name: ${trimmed}`);
  }

  if (path.isAbsolute(trimmed) || trimmed.includes("/") || trimmed.includes("\\")) {
    const abs = path.resolve(trimmed);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      throw new Error(`Project not found: ${abs}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${abs}`);
    }
    return fs.realpath(abs);
  }

  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error(`Project name must be a single folder name: ${trimmed}`);
  }

  const matches = await findProjectDirs(trimmed, roots);
  if (matches.length === 0) {
    throw new Error(
      `No project named ${trimmed} under ${roots.join(", ")}. Set PROJECTS_ROOT to the directory that contains it.`,
    );
  }
  if (matches.length > 1) {
    throw new Error(`Several projects named ${trimmed}:\n${matches.join("\n")}`);
  }
  return matches[0] ?? trimmed;
}
