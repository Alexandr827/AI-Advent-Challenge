import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  installPrWorkflow,
  parseGithubRemote,
  renderProjectWorkflow,
} from "../src/pr-pipeline.js";

const roots = [];

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe("pr-pipeline", () => {
  it("разбирает GitHub remote", () => {
    assert.equal(parseGithubRemote("git@github.com:Alexandr827/dev-assistant.git"), "Alexandr827/dev-assistant");
    assert.equal(parseGithubRemote("https://github.com/Alexandr827/AI-Advent-Challenge"), "Alexandr827/AI-Advent-Challenge");
  });

  it("устанавливает workflow в проект", async () => {
    const root = await mkdtemp(join(tmpdir(), "dev-assistant-pipe-"));
    roots.push(root);
    const assistant = { repo: "Alexandr827/dev-assistant", ref: "main" };
    const { target } = installPrWorkflow(root, { assistant });
    const text = readFileSync(target, "utf8");
    assert.match(text, /ai-review\.js/);
    assert.match(text, /pull_request:/);
    assert.match(text, /diff_url/);
    assert.doesNotMatch(text, /workflow_call/);
    assert.match(renderProjectWorkflow(assistant), /repository: Alexandr827\/dev-assistant/);
  });
});
