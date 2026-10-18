import "./loadEnv.js";
import { parseArgs, type TaskName } from "./args.js";
import {
  isGitWorkTree,
  printBaselineDiff,
  printFixturesDiff,
  printGitDiff,
  takeBaseline,
  workingTreeDirty,
} from "./diff.js";
import { runGoal } from "./run.js";
import { goalForTask, withFocus } from "./scenarios.js";
import { ASSISTANT_PREFACE } from "./tools.js";
import { saveWorkspace, writeOrigin } from "./save.js";
import { WORKSPACE_DIR } from "./paths.js";
import {
  cleanWorkspace,
  importSource,
  prepareRunTarget,
  resetWorkspaceFromFixtures,
  type RunTarget,
} from "./workspace.js";

function printHelp(): void {
  console.log(`Usage:
  npm run assistant -- "<request>"
        The agent copies a named project into workspace/, then does the work.
        Example: "у меня есть проект NodeJSproject. Обнови по нему readme.md на основе последних правок в коде"
  npm run save
        Copy workspace changes back onto the project they were loaded from.
  npm run clean
        Remove imported projects from workspace/.
  npm run import -- <file-or-directory>
        Copy a file or project into workspace/ yourself. Skips dependency folders, .git, and .env.
  npm run docs
  npm run readme
  npm run adr
  npm run changelog
        Run that task in workspace/.
  npm run docs -- --project <dir> [--file <path>]
        Run in <dir> and write edits there. --file limits the task to one file inside <dir>.
  npm run assistant -- [--project <dir>] [--file <path>] "<goal>"
        Run a custom goal.

Demo (always reloads fixtures):
  npm run scenario:docs
  npm run scenario:changelog
  npm run reset

Requires CURSOR_API_KEY (.env or environment).
Optional: CURSOR_MODEL (default: composer-2.5)
Optional: PROJECTS_ROOT (folders scanned by project name; default: home directory)
`);
}

async function reportDiff(target: RunTarget, dirtyBefore: boolean): Promise<void> {
  if (target.mode === "fixtures") {
    printFixturesDiff();
    return;
  }
  if (target.mode === "project" && isGitWorkTree(target.cwd)) {
    printGitDiff(target.cwd, dirtyBefore);
    return;
  }
  await printBaselineDiff(target.cwd);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "help") {
    printHelp();
    process.exit(process.argv.slice(2).length === 0 ? 1 : 0);
  }

  if (args.command === "reset") {
    await resetWorkspaceFromFixtures();
    console.log("Workspace reset from fixtures.");
    return;
  }

  if (args.command === "clean") {
    await cleanWorkspace();
    console.log("Workspace cleared.");
    return;
  }

  if (args.command === "save") {
    const result = await saveWorkspace();
    if (result.written.length === 0 && result.removed.length === 0) {
      console.log(`No changes to save to ${result.origin}.`);
      return;
    }
    if (result.written.length > 0) {
      console.log(`Updated ${result.written.length} file(s) in ${result.origin}:`);
      for (const file of result.written) {
        console.log(`  ${file}`);
      }
    }
    if (result.removed.length > 0) {
      console.log(`Removed ${result.removed.length} file(s) from ${result.origin}:`);
      for (const file of result.removed) {
        console.log(`  ${file}`);
      }
    }
    return;
  }

  if (args.command === "import") {
    const result = await importSource(args.source, WORKSPACE_DIR);
    await writeOrigin({ path: result.source, kind: result.kind });
    await takeBaseline(WORKSPACE_DIR);
    console.log(
      `Imported ${result.kind} from ${result.source} into ${result.copiedTo} (${result.files} files).`,
    );
    console.log("Next: npm run docs | npm run readme | npm run adr | npm run changelog");
    return;
  }

  const target = await prepareRunTarget({
    ...args,
    allowEmpty: args.command === "run" && !args.project,
  });
  const baseGoal =
    args.command === "run"
      ? `${ASSISTANT_PREFACE}\n\n${args.goal}`
      : goalForTask(args.command as Exclude<TaskName, "run">);
  const goal = withFocus(baseGoal, target.focusFile);

  console.log(`project: ${target.cwd}`);
  if (target.focusFile) {
    console.log(`focus: ${target.focusFile}`);
  }

  let dirtyBefore = false;
  if (target.mode === "project" && isGitWorkTree(target.cwd)) {
    dirtyBefore = workingTreeDirty(target.cwd);
  } else if (target.mode !== "fixtures") {
    await takeBaseline(target.cwd);
  }

  await runGoal(goal, target.cwd);
  await reportDiff(target, dirtyBefore);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
