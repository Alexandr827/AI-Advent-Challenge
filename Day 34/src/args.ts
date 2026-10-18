export type TaskName = "docs" | "readme" | "adr" | "changelog" | "run";

export type ParsedArgs =
  | { command: "help" }
  | { command: "reset" }
  | { command: "clean" }
  | { command: "save" }
  | { command: "import"; source: string }
  | {
      command: TaskName;
      project?: string;
      file?: string;
      fixtures: boolean;
      goal: string;
    };

const TASKS = new Set<TaskName>(["docs", "readme", "adr", "changelog", "run"]);

function isTask(value: string): value is TaskName {
  return TASKS.has(value as TaskName);
}

export function parseArgs(argv: string[]): ParsedArgs {
  let project: string | undefined;
  let file: string | undefined;
  let fixtures = false;
  let help = false;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--fixtures") {
      fixtures = true;
      continue;
    }
    if (arg === "--project" || arg === "--file") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a path`);
      }
      i++;
      if (arg === "--project") {
        project = value;
      } else {
        file = value;
      }
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positionals.push(arg);
  }

  if (help || positionals.length === 0) {
    return { command: "help" };
  }

  const [command, ...rest] = positionals;

  if (command === "reset" || command === "clean" || command === "save") {
    if (rest.length > 0 || project || file || fixtures) {
      throw new Error(`${command} takes no arguments`);
    }
    return { command };
  }

  if (command === "import") {
    if (rest.length !== 1 || project || file || fixtures) {
      throw new Error("Usage: import <file-or-directory>");
    }
    return { command: "import", source: rest[0] };
  }

  if (!command || !isTask(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  if (fixtures && project) {
    throw new Error("Use either --fixtures or --project, not both");
  }

  if (command === "run") {
    const goal = rest.join(" ").trim();
    if (!goal) {
      throw new Error('run requires a goal. Example: npm run assistant -- "update the docs"');
    }
    return { command, project, file, fixtures, goal };
  }

  if (rest.length > 0) {
    throw new Error(
      `${command} does not take extra text. Pass a custom goal with: npm run assistant -- "<goal>"`,
    );
  }

  return { command, project, file, fixtures, goal: "" };
}
