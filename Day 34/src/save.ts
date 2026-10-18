import fs from "node:fs/promises";
import path from "node:path";
import { hashFile, listRelativeFiles } from "./files.js";
import { BASELINE_DIR, SOURCE_FILE, WORKSPACE_DIR } from "./paths.js";

export interface OriginRecord {
  path: string;
  kind: "file" | "directory";
}

export interface SaveResult {
  origin: string;
  written: string[];
  removed: string[];
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === "ENOENT"
  );
}

export async function writeOrigin(record: OriginRecord, file = SOURCE_FILE): Promise<void> {
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
}

export async function readOrigin(file = SOURCE_FILE): Promise<OriginRecord | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if (isEnoent(err)) {
      return null;
    }
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("path" in parsed) ||
    !("kind" in parsed) ||
    typeof parsed.path !== "string" ||
    (parsed.kind !== "file" && parsed.kind !== "directory")
  ) {
    throw new Error("Origin record is invalid.");
  }
  return { path: parsed.path, kind: parsed.kind };
}

export async function forgetOrigin(file = SOURCE_FILE): Promise<void> {
  await fs.rm(file, { force: true });
}

async function sameFile(left: string, right: string): Promise<boolean> {
  try {
    const [leftHash, rightHash] = await Promise.all([hashFile(left), hashFile(right)]);
    return leftHash === rightHash;
  } catch (err) {
    if (isEnoent(err)) {
      return false;
    }
    throw err;
  }
}

function assertInside(root: string, target: string): void {
  const rel = path.relative(root, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Refusing to write outside the original project: ${target}`);
  }
}

async function copyOver(from: string, to: string, originRoot: string): Promise<void> {
  try {
    const current = await fs.lstat(to);
    if (current.isSymbolicLink()) {
      throw new Error(`Refusing to follow a symlink in the original project: ${to}`);
    }
  } catch (err) {
    if (!isEnoent(err)) {
      throw err;
    }
  }
  await fs.mkdir(path.dirname(to), { recursive: true });
  const parent = await fs.realpath(path.dirname(to));
  const root = await fs.realpath(originRoot);
  if (parent !== root && !parent.startsWith(root + path.sep)) {
    throw new Error(`Refusing to write outside the original project: ${to}`);
  }
  assertInside(root, path.join(parent, path.basename(to)));
  await fs.copyFile(from, to);
}

async function removeFile(target: string, originRoot: string): Promise<void> {
  let current;
  try {
    current = await fs.lstat(target);
  } catch (err) {
    if (isEnoent(err)) {
      return;
    }
    throw err;
  }
  if (current.isSymbolicLink() || !current.isFile()) {
    throw new Error(`Refusing to remove ${target}`);
  }
  const root = await fs.realpath(originRoot);
  assertInside(root, target);
  await fs.rm(target);
}

export async function saveChanges(input: {
  workspaceDir: string;
  originPath: string;
  kind: "file" | "directory";
  baselineDir?: string;
}): Promise<SaveResult> {
  const origin = await fs.realpath(input.originPath).catch(() => {
    throw new Error(`Original project not found: ${input.originPath}`);
  });
  const written: string[] = [];
  const removed: string[] = [];
  const baselineDir = input.baselineDir;
  const hasBaseline = baselineDir ? await pathExists(baselineDir) : false;
  const baseline = hasBaseline && baselineDir ? await listRelativeFiles(baselineDir) : null;
  const workspace = await listRelativeFiles(input.workspaceDir);

  if (input.kind === "file") {
    const name = path.basename(origin);
    const from = path.join(input.workspaceDir, name);
    if (!(await pathExists(from))) {
      if (baseline?.has(name)) {
        await fs.rm(origin);
        removed.push(name);
      }
      return { origin, written, removed };
    }
    const changed = baseline ? !baseline.has(name) || !(await sameFile(from, path.join(baselineDir!, name))) : !(await sameFile(from, origin));
    if (changed) {
      await fs.copyFile(from, origin);
      written.push(name);
    }
    return { origin, written, removed };
  }

  let originStat;
  try {
    originStat = await fs.stat(origin);
  } catch {
    throw new Error(`Original project not found: ${origin}`);
  }
  if (!originStat.isDirectory()) {
    throw new Error(`Original path is not a directory: ${origin}`);
  }

  for (const rel of [...workspace].sort()) {
    const from = path.join(input.workspaceDir, rel);
    const base = baselineDir ? path.join(baselineDir, rel) : "";
    const changed = !baseline || !baseline.has(rel) || !(await sameFile(from, base));
    if (!changed) {
      continue;
    }
    const to = path.join(origin, rel);
    await copyOver(from, to, origin);
    written.push(rel.split(path.sep).join("/"));
  }

  if (baseline && baselineDir) {
    for (const rel of [...baseline].sort()) {
      if (workspace.has(rel)) {
        continue;
      }
      await removeFile(path.join(origin, rel), origin);
      removed.push(rel.split(path.sep).join("/"));
    }
  }

  return { origin, written, removed };
}

export async function saveWorkspace(): Promise<SaveResult> {
  const record = await readOrigin();
  if (!record) {
    throw new Error(
      "No imported project to save. Load a project into the workspace before saving.",
    );
  }
  return saveChanges({
    workspaceDir: WORKSPACE_DIR,
    originPath: record.path,
    kind: record.kind,
    baselineDir: BASELINE_DIR,
  });
}
