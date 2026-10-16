import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadState, saveState } from "../src/store.js";

const tmpDirs = [];

after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function tempFile(name = "agents.json") {
  const dir = mkdtempSync(join(tmpdir(), "store-test-"));
  tmpDirs.push(dir);
  return join(dir, name);
}

describe("store load/save", () => {
  it("returns empty state for missing file", () => {
    const state = loadState(tempFile("missing.json"));
    assert.deepEqual(state.agents, []);
    assert.equal(state.nextId, 1);
  });

  it("round-trips agent with strategy, compress and chat", () => {
    const path = tempFile();
    saveState(path, {
      nextId: 3,
      agents: [
        {
          id: "1",
          name: "a1",
          model: "composer-2.5",
          runtime: "local",
          systemPrompt: "hi",
          messages: [{ role: "user", content: "q", ts: 1 }],
          compress: true,
          compressEvery: 4,
          strategy: "facts",
          window: 6,
          facts: { goal: "x" },
          memory: { short: { entries: {} }, working: { entries: {}, task: "" }, long: { profile: {}, decisions: {}, knowledge: {} } },
          chat: {
            history: [{ role: "user", content: "chat q", ts: 2 }],
            goal: "цель",
            clarifications: [],
            constraints: [],
            terms: [],
          },
        },
      ],
    });
    const loaded = loadState(path);
    assert.equal(loaded.nextId, 3);
    assert.equal(loaded.agents.length, 1);
    assert.equal(loaded.agents[0].name, "a1");
    assert.equal(loaded.agents[0].strategy, "facts");
    assert.equal(loaded.agents[0].compress, true);
    assert.equal(loaded.agents[0].chat.goal, "цель");
    assert.equal(loaded.agents[0].chat.history.length, 1);
  });

  it("throws on corrupt json", () => {
    const path = tempFile();
    writeFileSync(path, "{ not json", "utf8");
    assert.throws(() => loadState(path), /Не удалось прочитать историю/);
  });
});
