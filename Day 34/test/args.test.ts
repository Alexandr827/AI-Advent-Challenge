import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/args.js";

test("parseArgs reads a task with project and file", () => {
  assert.deepEqual(parseArgs(["docs", "--project", "/tmp/app", "--file", "src/api.ts"]), {
    command: "docs",
    project: "/tmp/app",
    file: "src/api.ts",
    fixtures: false,
    goal: "",
  });
});

test("parseArgs joins a custom goal", () => {
  assert.deepEqual(parseArgs(["run", "--project", "/tmp/app", "update", "the", "docs"]), {
    command: "run",
    project: "/tmp/app",
    file: undefined,
    fixtures: false,
    goal: "update the docs",
  });
});

test("parseArgs rejects fixtures together with a project", () => {
  assert.throws(
    () => parseArgs(["changelog", "--fixtures", "--project", "/tmp/app"]),
    /either --fixtures or --project/,
  );
});

test("parseArgs requires a goal for run", () => {
  assert.throws(() => parseArgs(["run"]), /requires a goal/);
});

test("parseArgs rejects an unknown command", () => {
  assert.throws(() => parseArgs(["deploy"]), /Unknown command/);
});

test("parseArgs accepts clean with no arguments", () => {
  assert.deepEqual(parseArgs(["clean"]), { command: "clean" });
});

test("parseArgs accepts save with no arguments", () => {
  assert.deepEqual(parseArgs(["save"]), { command: "save" });
});

test("parseArgs rejects extra clean arguments", () => {
  assert.throws(() => parseArgs(["clean", "workspace"]), /takes no arguments/);
});
