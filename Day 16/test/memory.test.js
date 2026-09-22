import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { LlmAgent } from "../src/agent.js";
import { parseCommand } from "../src/cli.js";
import {
  AgentMemory,
  LONG_DECISIONS,
  LONG_KNOWLEDGE,
  LONG_PROFILE,
  MEMORY_LONG,
  MEMORY_SHORT,
  MEMORY_WORKING,
  formatMemoryForPrompt,
  parseMemoryDirective,
  parseRememberPayload,
} from "../src/memory.js";
import { loadState, saveState } from "../src/store.js";

const tmpDirs = [];

after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

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

describe("memory layers are separate stores", () => {
  it("starts with three empty independent buckets", () => {
    const memory = new AgentMemory();
    const json = memory.toJSON();
    assert.deepEqual(Object.keys(json).sort(), ["long", "short", "working"]);
    assert.deepEqual(json.short.entries, {});
    assert.deepEqual(json.working.entries, {});
    assert.equal(json.working.task, "");
    assert.deepEqual(json.long, { profile: {}, decisions: {}, knowledge: {} });
  });

  it("writing working does not touch long or short", () => {
    const memory = new AgentMemory();
    memory.remember(MEMORY_WORKING, { key: "цель", value: "REST API" });
    const json = memory.toJSON();
    assert.equal(json.working.entries["цель"], "REST API");
    assert.deepEqual(json.short.entries, {});
    assert.deepEqual(json.long.profile, {});
    assert.deepEqual(json.long.decisions, {});
    assert.deepEqual(json.long.knowledge, {});
  });

  it("writing long:profile / decisions / knowledge keeps them apart", () => {
    const memory = new AgentMemory();
    memory.remember(MEMORY_LONG, {
      kind: LONG_PROFILE,
      key: "язык",
      value: "русский",
    });
    memory.remember(MEMORY_LONG, {
      kind: LONG_DECISIONS,
      key: "auth",
      value: "JWT",
    });
    memory.remember(MEMORY_LONG, {
      kind: LONG_KNOWLEDGE,
      key: "REST",
      value: "архитектурный стиль",
    });
    const json = memory.toJSON();
    assert.equal(json.long.profile["язык"], "русский");
    assert.equal(json.long.decisions.auth, "JWT");
    assert.equal(json.long.knowledge.REST, "архитектурный стиль");
    assert.deepEqual(json.working.entries, {});
    assert.deepEqual(json.short.entries, {});
  });

  it("forget working leaves long-term intact", () => {
    const memory = new AgentMemory();
    memory.remember(MEMORY_WORKING, { key: "цель", value: "API" });
    memory.remember(MEMORY_LONG, {
      kind: LONG_DECISIONS,
      key: "стек",
      value: "Node.js",
    });
    memory.forget(MEMORY_WORKING);
    const json = memory.toJSON();
    assert.deepEqual(json.working.entries, {});
    assert.equal(json.long.decisions["стек"], "Node.js");
  });

  it("startTask clears only working memory", () => {
    const memory = new AgentMemory();
    memory.remember(MEMORY_WORKING, { key: "цель", value: "старая" });
    memory.remember(MEMORY_SHORT, { key: "тема", value: "диалог" });
    memory.remember(MEMORY_LONG, {
      kind: LONG_PROFILE,
      key: "имя",
      value: "Алекс",
    });
    memory.startTask("Спроектировать CLI");
    const json = memory.toJSON();
    assert.equal(json.working.task, "Спроектировать CLI");
    assert.deepEqual(json.working.entries, {});
    assert.equal(json.working.machine.state, "planning");
    assert.equal(json.working.machine.step, 1);
    assert.equal(json.short.entries["тема"], "диалог");
    assert.equal(json.long.profile["имя"], "Алекс");
  });
});

describe("explicit routing", () => {
  it("parses remember payload as key: value", () => {
    assert.deepEqual(parseRememberPayload("цель: REST API"), {
      key: "цель",
      value: "REST API",
    });
    assert.deepEqual(parseRememberPayload("auth JWT"), {
      key: "auth",
      value: "JWT",
    });
    assert.deepEqual(parseRememberPayload("просто фраза"), {
      key: "просто",
      value: "фраза",
    });
    assert.deepEqual(parseRememberPayload("однослово"), {
      key: "заметка",
      value: "однослово",
    });
  });

  it("ask without prefix does not choose working or long", () => {
    const parsed = parseMemoryDirective("цель: REST API. Спроектируй эндпоинты");
    assert.equal(parsed.layer, null);
    assert.equal(parsed.kind, null);
    assert.equal(parsed.text, "цель: REST API. Спроектируй эндпоинты");
  });

  it("ask /working and /long:kind explicitly pick the store", () => {
    const working = parseMemoryDirective("/working цель: REST API");
    assert.equal(working.layer, MEMORY_WORKING);
    assert.equal(working.payload.key, "цель");
    assert.equal(working.payload.value, "REST API");
    assert.equal(working.text, "цель: REST API");

    const long = parseMemoryDirective("/long:decisions auth: JWT");
    assert.equal(long.layer, MEMORY_LONG);
    assert.equal(long.kind, LONG_DECISIONS);
    assert.equal(long.payload.key, "auth");
    assert.equal(long.payload.value, "JWT");
  });

  it("plain ask on the agent does not fill working or long", async () => {
    const agent = makeAgent({
      messages: [
        { role: "user", content: "цель: REST API", ts: 1 },
        { role: "assistant", content: "ок", ts: 2 },
      ],
    });
    assert.deepEqual(agent.memory.working.entries, {});
    assert.deepEqual(agent.memory.long.knowledge, {});
    await agent.remember(MEMORY_WORKING, { key: "цель", value: "REST API" });
    assert.equal(agent.memory.working.entries["цель"], "REST API");
    assert.deepEqual(agent.memory.long.knowledge, {});
  });
});

describe("CLI memory commands", () => {
  it("parses remember / forget / memory / task", () => {
    assert.deepEqual(parseCommand("remember helper working цель: REST API"), {
      type: "remember",
      target: "helper",
      layer: MEMORY_WORKING,
      kind: null,
      payload: "цель: REST API",
    });
    assert.deepEqual(
      parseCommand("remember helper long:profile язык: русский"),
      {
        type: "remember",
        target: "helper",
        layer: MEMORY_LONG,
        kind: LONG_PROFILE,
        payload: "язык: русский",
      },
    );
    assert.deepEqual(
      parseCommand("remember helper long decisions auth JWT"),
      {
        type: "remember",
        target: "helper",
        layer: MEMORY_LONG,
        kind: LONG_DECISIONS,
        payload: "auth JWT",
      },
    );
    assert.deepEqual(parseCommand("forget helper working цель"), {
      type: "forget",
      target: "helper",
      layer: MEMORY_WORKING,
      kind: null,
      key: "цель",
    });
    assert.deepEqual(parseCommand("memory helper long"), {
      type: "memory",
      target: "helper",
      layer: MEMORY_LONG,
    });
    assert.deepEqual(parseCommand("task helper start Спроектировать API"), {
      type: "task",
      target: "helper",
      action: "start",
      title: "Спроектировать API",
    });
    assert.equal(parseCommand("task helper clear").action, "clear");
  });
});

describe("agent prompt and occupancy", () => {
  it("injects working and long into occupancy, not mixing stores", async () => {
    const empty = makeAgent();
    const filled = makeAgent();
    await filled.remember(MEMORY_WORKING, { key: "цель", value: "REST API" });
    await filled.remember(MEMORY_LONG, {
      kind: LONG_PROFILE,
      key: "язык",
      value: "русский",
    });
    assert.ok(filled.tokenReport.occupancy > empty.tokenReport.occupancy);
    assert.equal(filled.tokenReport.memory.working, 1);
    assert.equal(filled.tokenReport.memory.long, 1);
    assert.equal(filled.tokenReport.memory.short, 0);
    const block = formatMemoryForPrompt(filled.memory);
    assert.match(block, /Рабочая память/);
    assert.match(block, /цель: REST API/);
    assert.match(block, /\[профиль\]/);
    assert.match(block, /язык: русский/);
  });

  it("forget short without key clears dialogue messages", async () => {
    const agent = makeAgent({
      messages: [
        { role: "user", content: "привет", ts: 1 },
        { role: "assistant", content: "здравствуйте", ts: 2 },
      ],
    });
    await agent.remember(MEMORY_SHORT, { key: "тема", value: "приветствие" });
    await agent.forget(MEMORY_SHORT);
    assert.equal(agent.messages.length, 0);
    assert.deepEqual(agent.memory.short.entries, {});
  });
});

describe("persistence keeps layers separate", () => {
  it("round-trips short, working and long through the store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memory-"));
    tmpDirs.push(dir);
    const file = join(dir, "agents.json");

    const agent = makeAgent();
    await agent.remember(MEMORY_SHORT, { key: "тема", value: "диалог про API" });
    await agent.remember(MEMORY_WORKING, { key: "цель", value: "REST API" });
    await agent.startTask("Эндпоинты");
    await agent.remember(MEMORY_WORKING, { key: "ресурс", value: "/tasks" });
    await agent.remember(MEMORY_LONG, {
      kind: LONG_DECISIONS,
      key: "auth",
      value: "JWT",
    });

    saveState(file, { nextId: 2, agents: [agent.toJSON()] });
    const loaded = loadState(file);
    const row = loaded.agents[0];
    assert.ok(row.memory.short);
    assert.ok(row.memory.working);
    assert.ok(row.memory.long);
    assert.equal(row.memory.short.entries["тема"], "диалог про API");
    assert.equal(row.memory.working.task, "Эндпоинты");
    assert.equal(row.memory.working.entries["ресурс"], "/tasks");
    assert.equal(row.memory.working.machine.state, "planning");
    assert.equal(row.memory.long.decisions.auth, "JWT");
    assert.deepEqual(row.memory.long.profile, {});

    const restored = makeAgent(row);
    assert.equal(restored.memory.working.task, "Эндпоинты");
    assert.equal(restored.memory.working.machine.state, "planning");
    assert.equal(restored.memory.long.decisions.auth, "JWT");
    assert.equal(restored.memory.short.entries["тема"], "диалог про API");
  });
});
