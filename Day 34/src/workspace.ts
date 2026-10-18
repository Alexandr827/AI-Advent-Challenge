import fs from "node:fs/promises";
import path from "node:path";
import { listRelativeFiles } from "./files.js";
import { shouldSkip } from "./ignore.js";
import { forgetOrigin } from "./save.js";
import { BASELINE_DIR, FIXTURES_DIR, WORKSPACE_DIR } from "./paths.js";

export type TargetMode = "fixtures" | "workspace" | "project";

export interface RunTarget {
  cwd: string;
  mode: TargetMode;
  focusFile?: string;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function canonicalPath(target: string): Promise<string> {
  const resolved = path.resolve(target);
  try {
    return await fs.realpath(resolved);
  } catch {
    const parent = await fs.realpath(path.dirname(resolved));
    return path.join(parent, path.basename(resolved));
  }
}

export async function resetWorkspaceFromFixtures(): Promise<void> {
  await forgetOrigin();
  await fs.rm(WORKSPACE_DIR, { recursive: true, force: true });
  await fs.cp(FIXTURES_DIR, WORKSPACE_DIR, { recursive: true });
}

export async function cleanWorkspace(): Promise<void> {
  await forgetOrigin();
  await fs.rm(WORKSPACE_DIR, { recursive: true, force: true });
  await fs.rm(BASELINE_DIR, { recursive: true, force: true });
  await fs.mkdir(WORKSPACE_DIR, { recursive: true });
}

export async function importSource(
  source: string,
  dest: string,
): Promise<{ kind: "file" | "directory"; source: string; copiedTo: string; files: number }> {
  const requested = path.resolve(source);
  let stat;
  try {
    stat = await fs.stat(requested);
  } catch {
    throw new Error(`Path not found: ${requested}`);
  }

  const abs = await fs.realpath(requested);
  const destResolved = await canonicalPath(dest);
  const overlaps =
    abs === destResolved ||
    destResolved.startsWith(abs + path.sep) ||
    abs.startsWith(destResolved + path.sep);
  if (overlaps) {
    throw new Error("Refusing to import a path that overlaps the destination.");
  }

  if (!stat.isDirectory() && !stat.isFile()) {
    throw new Error(`Not a file or directory: ${abs}`);
  }

  if (stat.isFile() && shouldSkip(path.basename(abs))) {
    throw new Error(`Refusing to import ${path.basename(abs)}.`);
  }

  await fs.rm(destResolved, { recursive: true, force: true });
  await fs.mkdir(destResolved, { recursive: true });

  if (stat.isDirectory()) {
    await fs.cp(abs, destResolved, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (src) => {
        const rel = path.relative(abs, src);
        return rel === "" || !shouldSkip(rel);
      },
    });
    const files = await listRelativeFiles(destResolved);
    return { kind: "directory", source: abs, copiedTo: destResolved, files: files.size };
  }

  const copiedTo = path.join(destResolved, path.basename(abs));
  await fs.copyFile(abs, copiedTo);
  return { kind: "file", source: abs, copiedTo, files: 1 };
}

export async function resolveFocusFile(cwd: string, file: string): Promise<string> {
  const abs = path.resolve(cwd, file);
  const rel = path.relative(cwd, abs);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`--file must be inside the project: ${file}`);
  }
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw new Error(`--file not found: ${abs}`);
  }
  if (!stat.isFile()) {
    throw new Error(`--file must be a file: ${abs}`);
  }
  return rel.split(path.sep).join("/");
}

export async function prepareRunTarget(options: {
  fixtures: boolean;
  project?: string;
  file?: string;
  allowEmpty?: boolean;
}): Promise<RunTarget> {
  if (options.fixtures) {
    await resetWorkspaceFromFixtures();
    return {
      cwd: WORKSPACE_DIR,
      mode: "fixtures",
      focusFile: options.file
        ? await resolveFocusFile(WORKSPACE_DIR, options.file)
        : undefined,
    };
  }

  if (options.project) {
    const cwd = path.resolve(options.project);
    let stat;
    try {
      stat = await fs.stat(cwd);
    } catch {
      throw new Error(`Project not found: ${cwd}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(
        `--project must be a directory: ${cwd}\n` +
          `To attach a single file, import it first:\n` +
          `  npm run import -- ${cwd}`,
      );
    }
    return {
      cwd,
      mode: "project",
      focusFile: options.file ? await resolveFocusFile(cwd, options.file) : undefined,
    };
  }

  if (!(await pathExists(WORKSPACE_DIR))) {
    if (!options.allowEmpty) {
      throw new Error(
        "Workspace is missing.\n" +
          "  npm run assistant -- \"у меня есть проект NodeJSproject. Обнови по нему readme.md\"\n" +
          "  npm run import -- /path/to/project",
      );
    }
    await fs.mkdir(WORKSPACE_DIR, { recursive: true });
  }

  const entries = await fs.readdir(WORKSPACE_DIR);
  if (entries.length === 0 && !options.allowEmpty) {
    throw new Error(
      "Workspace is empty. Name the project in the assistant request, or import it:\n" +
        "  npm run import -- /path/to/project",
    );
  }

  return {
    cwd: WORKSPACE_DIR,
    mode: "workspace",
    focusFile: options.file
      ? await resolveFocusFile(WORKSPACE_DIR, options.file)
      : undefined,
  };
}
