import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { LlmAgent } from "../src/agent.js";
import { parseCommand } from "../src/cli.js";
import { loadState, saveState } from "../src/store.js";
import {
  extractFactsFromMessages,
  formatFacts,
  hydrateBranching,
  parseStrategy,
  slidingWindow,
  STRATEGY_BRANCHING,
  STRATEGY_FACTS,
  STRATEGY_SLIDING,
  updateFacts,
} from "../src/strategy.js";

const tmpDirs = [];

after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function msg(role, content, ts = Date.now()) {
  return { role, content, ts };
}

function history(count) {
  const list = [];
  for (let i = 1; i <= count; i++) {
    list.push(msg("user", `u${i}`, i * 2 - 1));
    list.push(msg("assistant", `a${i}`, i * 2));
  }
  return list;
}

function makeAgent(overrides = {}) {
  return new LlmAgent({
    id: "1",
    name: "tester",
    model: "composer-2.5",
    runtime: "local",
    apiKey: "test-key",
    cwd: process.cwd(),
    compress: false,
    ...overrides,
  });
}

describe("CLI switcher", () => {
  it("parses spawn --strategy and --window", () => {
    const cmd = parseCommand(
      "spawn --name memory --strategy facts --window 6",
    );
    assert.equal(cmd.type, "spawn");
    assert.equal(cmd.strategy, STRATEGY_FACTS);
    assert.equal(cmd.window, 6);
  });

  it("parses strategy / window / facts / branching commands", () => {
    assert.deepEqual(parseCommand("strategy slider"), {
      type: "strategy",
      target: "slider",
      strategy: undefined,
      window: undefined,
    });
    assert.equal(parseCommand("strategy slider sliding --window 4").strategy, STRATEGY_SLIDING);
    assert.deepEqual(parseCommand("window slider 6"), {
      type: "window",
      target: "slider",
      window: 6,
    });
    assert.equal(parseCommand("facts memory").type, "facts");
    assert.equal(parseCommand("checkpoint fork").type, "checkpoint");
    assert.deepEqual(parseCommand("branch fork rest graphql"), {
      type: "branch",
      target: "fork",
      branchA: "rest",
      branchB: "graphql",
    });
    assert.deepEqual(parseCommand("use fork graphql"), {
      type: "use",
      target: "fork",
      branch: "graphql",
    });
    assert.equal(parseCommand("branches fork").type, "branches");
  });

  it("rejects unknown strategy names", () => {
    assert.throws(() => parseStrategy("random"), /sliding, facts, branching или full/);
  });
});

describe("Sliding Window", () => {
  it("keeps only the last N messages", () => {
    const all = history(5);
    const windowed = slidingWindow(all, 4);
    assert.equal(windowed.length, 4);
    assert.equal(windowed[0].content, "u4");
    assert.equal(windowed.at(-1).content, "a5");
  });

  it("discards older messages from the agent archive", () => {
    const agent = makeAgent({
      strategy: STRATEGY_SLIDING,
      window: 4,
      messages: history(5),
    });
    assert.equal(agent.messages.length, 4);
    assert.equal(agent.messages[0].content, "u4");
    assert.equal(agent.toJSON().messages.length, 4);
    assert.equal(agent.tokenReport.promptMessageCount, 4);
  });

  it("setWindow trims further", async () => {
    const agent = makeAgent({
      strategy: STRATEGY_SLIDING,
      window: 6,
      messages: history(4),
    });
    assert.equal(agent.messages.length, 6);
    await agent.setWindow(2);
    assert.equal(agent.messages.length, 2);
    assert.equal(agent.messages[0].content, "u4");
  });
});

describe("Sticky Facts", () => {
  it("extracts goal, constraints, preferences, decisions, agreements", () => {
    const facts = updateFacts(
      {},
      [
        "цель: REST API",
        "ограничения: без внешних сервисов",
        "Предпочитаю краткие ответы",
        "Решили использовать JWT",
        "Договорились что дедлайн пятница",
      ].join(". "),
    );
    assert.equal(facts["цель"], "REST API");
    assert.match(facts["ограничения"], /без внешних сервисов/);
    assert.match(facts["предпочтения"], /краткие ответы/i);
    assert.match(facts["решения"], /JWT/);
    assert.match(facts["договорённости"], /дедлайн пятница/);
  });

  it("updates after each user message and keeps previous keys", () => {
    let facts = updateFacts({}, "цель: REST API");
    facts = updateFacts(facts, "ограничения: только Node.js");
    assert.equal(facts["цель"], "REST API");
    assert.match(facts["ограничения"], /Node\.js/);
  });

  it("sends facts + last N: occupancy includes the facts block, archive is the window", () => {
    const messages = [
      ...history(3),
      msg("user", "цель: REST API. ограничения: без внешних сервисов."),
      msg("assistant", "ок"),
    ];
    const agent = makeAgent({
      strategy: STRATEGY_FACTS,
      window: 4,
      messages,
    });
    assert.equal(agent.messages.length, 4);
    assert.equal(agent.facts["цель"], "REST API");
    const block = formatFacts(agent.facts);
    assert.match(block, /цель: REST API/);
    assert.match(block, /ограничения: без внешних сервисов/);
    const sliding = makeAgent({
      strategy: STRATEGY_SLIDING,
      window: 4,
      messages,
    });
    assert.ok(agent.tokenReport.occupancy > sliding.tokenReport.occupancy);
  });

  it("rebuilds facts from history when switching to facts", async () => {
    const agent = makeAgent({
      strategy: "full",
      messages: [
        msg("user", "цель: CLI-хост"),
        msg("assistant", "понял"),
      ],
    });
    await agent.setStrategy(STRATEGY_FACTS, { window: 4 });
    assert.equal(agent.strategy, STRATEGY_FACTS);
    assert.equal(agent.facts["цель"], "CLI-хост");
  });
});

describe("Branching", () => {
  it("hydrates a main branch from linear history", () => {
    const messages = history(2);
    const state = hydrateBranching({ messages });
    assert.equal(state.currentBranch, "main");
    assert.equal(state.branches.main.messages.length, 4);
  });

  it("checkpoints, forks two independent branches, and switches", async () => {
    const agent = makeAgent({
      strategy: STRATEGY_BRANCHING,
      messages: history(2),
    });
    const saved = agent.checkpoint();
    assert.equal(saved, 4);

    const created = await agent.createBranches("rest", "graphql");
    assert.deepEqual(created.branches, ["rest", "graphql"]);
    assert.equal(created.current, "rest");
    assert.equal(agent.currentBranch, "rest");

    agent.messages.push(msg("user", "делай REST"), msg("assistant", "ok rest"));
    assert.equal(agent.messages.length, 6);

    await agent.useBranch("graphql");
    assert.equal(agent.currentBranch, "graphql");
    assert.equal(agent.messages.length, 4);
    assert.equal(
      agent.messages.some((item) => item.content.includes("REST")),
      false,
    );

    agent.messages.push(msg("user", "делай GraphQL"), msg("assistant", "ok gql"));
    await agent.useBranch("rest");
    assert.equal(agent.messages.at(-1).content, "ok rest");
    assert.equal(
      agent.messages.some((item) => item.content.includes("GraphQL")),
      false,
    );

    const report = agent.branchReport();
    assert.equal(report.branches.length, 3);
    const names = report.branches.map((b) => b.name).sort();
    assert.deepEqual(names, ["graphql", "main", "rest"]);
  });
});

describe("persistence", () => {
  it("round-trips strategy, facts, window and branches through the store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strategy-"));
    tmpDirs.push(dir);
    const file = join(dir, "agents.json");

    const agent = makeAgent({
      strategy: STRATEGY_FACTS,
      window: 4,
      messages: [
        msg("user", "цель: REST API"),
        msg("assistant", "ок"),
        msg("user", "ограничения: без облака"),
        msg("assistant", "зафиксировал"),
      ],
    });
    saveState(file, { nextId: 2, agents: [agent.toJSON()] });
    const loaded = loadState(file);
    assert.equal(loaded.agents[0].strategy, STRATEGY_FACTS);
    assert.equal(loaded.agents[0].window, 4);
    assert.equal(loaded.agents[0].facts["цель"], "REST API");
    assert.equal(loaded.agents[0].messages.length, 4);

    const fork = makeAgent({
      id: "2",
      name: "fork",
      strategy: STRATEGY_BRANCHING,
      messages: history(1),
    });
    fork.checkpoint();
    await fork.createBranches("a", "b");
    saveState(file, { nextId: 3, agents: [fork.toJSON()] });
    const again = loadState(file);
    assert.equal(again.agents[0].strategy, STRATEGY_BRANCHING);
    assert.equal(again.agents[0].currentBranch, "a");
    assert.ok(again.agents[0].branches.a);
    assert.ok(again.agents[0].branches.b);
  });
});

describe("extractFactsFromMessages", () => {
  it("walks only user turns", () => {
    const facts = extractFactsFromMessages([
      msg("user", "цель: A"),
      msg("assistant", "цель: не брать из ответа"),
      msg("user", "предпочтения: таблицы"),
    ]);
    assert.equal(facts["цель"], "A");
    assert.equal(facts["предпочтения"], "таблицы");
  });
});
