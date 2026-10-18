import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { hashFile, listRelativeFiles } from "./files.js";
import { shouldSkip } from "./ignore.js";
import { BASELINE_DIR, FIXTURES_DIR, WORKSPACE_DIR } from "./paths.js";

const gitIo = { encoding: "utf-8" as const, maxBuffer: 20 * 1024 * 1024 };

export function isGitWorkTree(cwd: string): boolean {
  const result = spawnSync(
    "git",
    ["-C", cwd, "rev-parse", "--is-inside-work-tree"],
    gitIo,
  );
  return result.status === 0 && (result.stdout ?? "").trim() === "true";
}

export function workingTreeDirty(cwd: string): boolean {
  const result = spawnSync("git", ["-C", cwd, "status", "--porcelain"], gitIo);
  return (result.stdout ?? "").trim().length > 0;
}

export async function takeBaseline(cwd: string): Promise<void> {
  await fs.rm(BASELINE_DIR, { recursive: true, force: true });
  await fs.cp(cwd, BASELINE_DIR, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => {
      const rel = path.relative(cwd, src);
      return rel === "" || !shouldSkip(rel);
    },
  });
}

function writeGitOutput(result: ReturnType<typeof spawnSync>): void {
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (out.trim()) {
    process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
  }
}

export function printFixturesDiff(): void {
  console.log("\n--- diff (fixtures → workspace) ---\n");
  const result = spawnSync(
    "git",
    ["--no-pager", "diff", "--no-index", "--", FIXTURES_DIR, WORKSPACE_DIR],
    gitIo,
  );
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (out.trim()) {
    process.stdout.write(out);
  } else {
    console.log("(no differences)");
  }
}

export function printGitDiff(cwd: string, dirtyBefore: boolean): void {
  console.log("\n--- working tree ---\n");
  if (dirtyBefore) {
    console.log(
      "This git working tree already had changes before the run. The diff includes those earlier edits.\n",
    );
  }
  const status = spawnSync("git", ["-C", cwd, "status", "--porcelain"], gitIo);
  const statusOut = status.stdout ?? "";
  if (statusOut.trim()) {
    process.stdout.write(statusOut.endsWith("\n") ? statusOut : `${statusOut}\n`);
  } else {
    console.log("(clean)");
  }

  console.log("\n--- git diff ---\n");
  const diff = spawnSync("git", ["--no-pager", "-C", cwd, "diff", "--"], gitIo);
  const diffOut = `${diff.stdout ?? ""}${diff.stderr ?? ""}`;
  if (diffOut.trim()) {
    process.stdout.write(diffOut);
  } else {
    console.log("(no unstaged differences)");
  }
}

export async function printBaselineDiff(cwd: string): Promise<void> {
  console.log("\n--- diff (before → after) ---\n");
  const before = await listRelativeFiles(BASELINE_DIR);
  const after = await listRelativeFiles(cwd);
  const rels = [...new Set([...before, ...after])].sort();
  let any = false;

  for (const rel of rels) {
    const left = path.join(BASELINE_DIR, rel);
    const right = path.join(cwd, rel);
    const leftExists = before.has(rel);
    const rightExists = after.has(rel);
    if (leftExists && rightExists) {
      const [leftHash, rightHash] = await Promise.all([
        hashFile(left),
        hashFile(right),
      ]);
      if (leftHash === rightHash) {
        continue;
      }
    }
    any = true;
    const result = spawnSync(
      "git",
      [
        "--no-pager",
        "diff",
        "--no-index",
        "--",
        leftExists ? left : "/dev/null",
        rightExists ? right : "/dev/null",
      ],
      gitIo,
    );
    writeGitOutput(result);
  }

  if (!any) {
    console.log("(no differences)");
  }
}
