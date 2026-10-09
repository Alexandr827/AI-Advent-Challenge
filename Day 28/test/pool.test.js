import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { AgentPool, MAX_AGENTS } from "../src/pool.js";
import { loadState, saveState } from "../src/store.js";

const tmpDirs = [];

after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function poolWithStore() {
  const dir = mkdtempSync(join(tmpdir(), "pool-test-"));
  tmpDirs.push(dir);
  const storePath = join(dir, "agents.json");
  const pool = new AgentPool({
    apiKey: "test-key",
    defaultModel: "composer-2.5",
    defaultRuntime: "local",
    cwd: dir,
    storePath,
  });
  return { pool, storePath, dir };
}

describe("AgentPool", () => {
  it("spawn persists and restores chat field", () => {
    const { pool, storePath, dir } = poolWithStore();
    pool.spawn({ name: "helper" });
    const state = loadState(storePath);
    state.agents[0].chat = {
      history: [{ role: "user", content: "hi", ts: 1 }],
      goal: "g",
      clarifications: [],
      constraints: [],
      terms: [],
    };
    saveState(storePath, state);

    const pool2 = new AgentPool({
      apiKey: "test-key",
      defaultModel: "composer-2.5",
      defaultRuntime: "local",
      cwd: dir,
      storePath,
    });
    const restored = pool2.get("helper");
    assert.equal(restored.chatState.goal, "g");
    assert.equal(restored.chatState.history.length, 1);
  });

  it("rejects duplicate names", () => {
    const { pool } = poolWithStore();
    pool.spawn({ name: "dup" });
    assert.throws(() => pool.spawn({ name: "dup" }), /уже занято/);
  });

  it("enforces MAX_AGENTS limit", () => {
    const { pool } = poolWithStore();
    assert.throws(() => pool.spawn({ count: MAX_AGENTS + 1 }), /больше/);
  });

  it("kill and killAll update store", async () => {
    const { pool, storePath } = poolWithStore();
    pool.spawn({ name: "a" });
    pool.spawn({ name: "b" });
    assert.equal(pool.size, 2);
    await pool.kill("a");
    assert.equal(pool.size, 1);
    await pool.killAll();
    assert.equal(pool.size, 0);
    const state = loadState(storePath);
    assert.equal(state.agents.length, 0);
  });
});
