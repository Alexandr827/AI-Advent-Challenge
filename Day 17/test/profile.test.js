import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { LlmAgent } from "../src/agent.js";
import { parseCommand } from "../src/cli.js";
import {
  ProfileService,
  buildPrompt,
  createProfileStorage,
  formatProfilePrompt,
  parseUserId,
  runProfilePipeline,
} from "../src/profile.js";
import { parseMdc } from "../src/profile/mdc.js";

const tmpDirs = [];

after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), "profiles-"));
  tmpDirs.push(dir);
  const storage = createProfileStorage({ kind: "file", dir });
  return { dir, storage, profiles: new ProfileService({ storage }) };
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

describe("profile storage writes .md and .mdc rules", () => {
  it("creates a user profile as rule files", async () => {
    const { dir, profiles } = makeService();
    await profiles.create("alex", { name: "Алексей" });
    const md = readFileSync(join(dir, "alex", "profile.md"), "utf8");
    const parsed = parseMdc(md);
    assert.equal(parsed.frontmatter.user, "alex");
    assert.equal(parsed.frontmatter.name, "Алексей");
    const loaded = await profiles.load("alex");
    assert.equal(loaded.userId, "alex");
    assert.equal(loaded.name, "Алексей");
  });

  it("stores style, constraints and context in alwaysApply mdc files", async () => {
    const { dir, profiles } = makeService();
    await profiles.create("alex", { name: "Алексей" });
    await profiles.setEntry("alex", "style", "length", "краткие");
    await profiles.setEntry("alex", "style", "tone", "разговорный");
    await profiles.setEntry("alex", "style", "examples", "с примерами кода");
    await profiles.setEntry("alex", "style", "language", "русский");
    await profiles.setEntry("alex", "constraints", "stack", "javascript + nodeJS");
    await profiles.setEntry("alex", "constraints", "architecture", "MVVM");
    await profiles.setEntry("alex", "constraints", "dependencies", "минимум зависимостей");
    await profiles.setEntry("alex", "constraints", "apis", "только бесплатные api");
    await profiles.setEntry("alex", "context", "role", "senior fullstack nodeJS dev");
    await profiles.setEntry(
      "alex",
      "context",
      "project",
      "сервис для запуска исполняемых bpmn-процессов",
    );
    await profiles.setEntry("alex", "context", "team", "3 человека");
    await profiles.setEntry("alex", "context", "deadline", "3 недели");

    const style = parseMdc(readFileSync(join(dir, "alex", "style.mdc"), "utf8"));
    assert.equal(style.frontmatter.kind, "style");
    assert.equal(style.frontmatter.alwaysApply, true);
    assert.equal(style.entries.length, "brief");
    assert.equal(style.entries.tone, "casual");
    assert.equal(style.entries.examples, "code");
    assert.equal(style.entries.language, "ru");

    const profile = await profiles.load("alex");
    assert.equal(profile.constraints.stack, "javascript + nodeJS");
    assert.equal(profile.constraints.architecture, "MVVM");
    assert.equal(profile.context.role, "senior fullstack nodeJS dev");
    assert.equal(profile.context.deadline, "3 недели");
  });

  it("json db backend round-trips the same model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-db-"));
    tmpDirs.push(dir);
    const storage = createProfileStorage({
      kind: "db",
      dbPath: join(dir, "db.json"),
    });
    const profiles = new ProfileService({ storage });
    await profiles.create("alex", { name: "Алексей" });
    await profiles.setEntry("alex", "style", "length", "подробные");
    const loaded = await profiles.load("alex");
    assert.equal(loaded.style.length, "detailed");
  });

  it("removes a profile from storage", async () => {
    const { profiles } = makeService();
    await profiles.create("alex", { name: "Алексей" });
    assert.equal(await profiles.loader.exists("alex"), true);
    assert.equal(await profiles.remove("alex"), "alex");
    assert.equal(await profiles.loader.exists("alex"), false);
    await assert.rejects(() => profiles.remove("alex"), /не найден/);
  });
});

describe("profile pipeline: storage -> loader -> prompt builder -> generate", () => {
  it("builds system + profile + query", async () => {
    const { profiles } = makeService();
    await profiles.create("alex", { name: "Алексей" });
    await profiles.setEntry("alex", "style", "length", "brief");
    await profiles.setEntry("alex", "constraints", "stack", "javascript + nodeJS");
    await profiles.setEntry("alex", "context", "role", "senior fullstack nodeJS dev");

    const result = await runProfilePipeline({
      loader: profiles.loader,
      userId: "alex",
      system: "Ты ассистент.",
      query: "Как спроектировать API?",
      generate: async (prompt) => prompt,
    });
    assert.match(result.prompt, /Ты ассистент/);
    assert.match(result.prompt, /Персонализация \(alex \/ Алексей\)/);
    assert.match(result.prompt, /объём ответа: краткие ответы/);
    assert.match(result.prompt, /стек: javascript \+ nodeJS/);
    assert.match(result.prompt, /роль: senior fullstack nodeJS dev/);
    assert.match(result.prompt, /Как спроектировать API\?/);
    assert.equal(result.response, result.prompt);
  });

  it("follow-up asks still attach the profile block", () => {
    const profile = {
      userId: "alex",
      name: "Алексей",
      style: { length: "brief" },
      constraints: {},
      context: {},
    };
    const prompt = buildPrompt({
      system: "sys",
      profile,
      memory: "memory-block",
      query: "второй вопрос",
      includeSystem: false,
      includeMemory: false,
      includeHistory: false,
    });
    assert.match(prompt, /Персонализация/);
    assert.match(prompt, /второй вопрос/);
    assert.doesNotMatch(prompt, /^sys/);
    assert.doesNotMatch(prompt, /memory-block/);
  });

  it("counts attached profile in occupancy", async () => {
    const { profiles } = makeService();
    await profiles.create("alex", { name: "Алексей" });
    await profiles.setEntry("alex", "style", "length", "краткие");
    await profiles.setEntry("alex", "constraints", "stack", "nodeJS");
    const empty = makeAgent();
    const filled = makeAgent({
      profileId: "alex",
      profileLoader: profiles.loader,
    });
    assert.ok(filled.tokenReport.occupancy > empty.tokenReport.occupancy);
    assert.equal(filled.tokenReport.profileId, "alex");
    assert.equal(filled.tokenReport.profile.style, 1);
    assert.equal(filled.tokenReport.profile.constraints, 1);
  });
});

describe("CLI profile pipeline commands", () => {
  it("parses profile lifecycle and section commands", () => {
    assert.deepEqual(parseCommand("profile create alex --name Алексей"), {
      type: "profile",
      action: "create",
      userId: "alex",
      name: "Алексей",
    });
    assert.equal(parseCommand("profile list").action, "list");
    assert.deepEqual(parseCommand("profile attach helper alex"), {
      type: "profile",
      action: "attach",
      target: "helper",
      userId: "alex",
    });
    assert.deepEqual(parseCommand("style alex length краткие"), {
      type: "style",
      action: "set",
      userId: "alex",
      section: "style",
      key: "length",
      value: "краткие",
    });
    assert.deepEqual(
      parseCommand("constraints alex стек javascript + nodeJS"),
      {
        type: "constraints",
        action: "set",
        userId: "alex",
        section: "constraints",
        key: "stack",
        value: "javascript + nodeJS",
      },
    );
    assert.deepEqual(
      parseCommand("context alex роль senior fullstack nodeJS dev"),
      {
        type: "context",
        action: "set",
        userId: "alex",
        section: "context",
        key: "role",
        value: "senior fullstack nodeJS dev",
      },
    );
    assert.deepEqual(
      parseCommand("prefer alex style examples без примеров"),
      {
        type: "style",
        action: "set",
        userId: "alex",
        section: "style",
        key: "examples",
        value: "без примеров",
      },
    );
    assert.deepEqual(parseCommand("spawn --name helper --profile alex").profileId, "alex");
    assert.deepEqual(parseCommand("profile delete alex"), {
      type: "profile",
      action: "delete",
      userId: "alex",
    });
    assert.deepEqual(parseCommand("profile rm alex"), {
      type: "profile",
      action: "delete",
      userId: "alex",
    });
    assert.deepEqual(parseCommand("profile alex delete"), {
      type: "profile",
      action: "delete",
      userId: "alex",
    });
    assert.throws(() => parseCommand("profile delete"), /profile delete/);
  });

  it("rejects bad user ids", () => {
    assert.throws(() => parseUserId("алексей"), /латиница/);
    assert.throws(() => parseCommand("profile create алексей"), /латиница/);
  });
});

describe("prompt builder formatting", () => {
  it("expands style enums into readable rules", () => {
    const block = formatProfilePrompt({
      userId: "alex",
      name: "Алексей",
      style: {
        length: "detailed",
        tone: "formal",
        examples: "none",
        language: "en",
      },
      constraints: { stack: "javascript + nodeJS" },
      context: { deadline: "3 недели" },
    });
    assert.match(block, /подробные ответы/);
    assert.match(block, /формальный/);
    assert.match(block, /без примеров кода/);
    assert.match(block, /английский/);
    assert.match(block, /стек: javascript \+ nodeJS/);
    assert.match(block, /дедлайн: 3 недели/);
  });
});
