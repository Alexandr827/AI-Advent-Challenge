import type { TaskName } from "./args.js";

export const SCENARIO_GOALS: Record<Exclude<TaskName, "run">, string> = {
  docs: [
    "Read the implementation and the existing documentation.",
    "Update the documentation so it matches the current code:",
    "public interfaces, parameters, return values, and behavior.",
    "Prefer files under docs/ and markdown that already describes the project.",
    "If nothing documents the code yet, create docs/ from the public surface.",
    "Change only documentation.",
    "Do not modify implementation source.",
    "Do not invent features, commands, or package names that are not in the repository.",
  ].join(" "),

  readme: [
    "Create or update README.md at the project root from the codebase.",
    "Cover what the project is, how to run it when that is evident from the repo, and one short example grounded in the code.",
    "If README.md already exists, update it in place.",
    "Do not modify implementation source or other docs.",
    "Do not invent features, commands, or package names that are not in the repository.",
  ].join(" "),

  adr: [
    "Write an Architecture Decision Record for the most important design decision visible in the current code.",
    "Put it at docs/adr/NNNN-short-title.md, using the next free 4-digit number.",
    "Include status, context, decision, and consequences.",
    "Every claim must be supported by the source.",
    "Do not modify implementation source or unrelated documentation.",
  ].join(" "),

  changelog: [
    "Create or update CHANGELOG.md at the project root so it describes the current public surface.",
    "That surface is whatever the project actually exposes: exported APIs, commands, or routes.",
    "Use markdown headings.",
    "If the repository has no release history, use an Unreleased or Current section instead of inventing versions.",
    "Do not modify implementation source.",
  ].join(" "),
};

export function goalForTask(name: Exclude<TaskName, "run">): string {
  return SCENARIO_GOALS[name];
}

export function withFocus(goal: string, focusFile?: string): string {
  if (!focusFile) {
    return goal;
  }
  return `${goal} Treat ${focusFile} as the primary source for this run, and limit edits to what that file requires.`;
}
