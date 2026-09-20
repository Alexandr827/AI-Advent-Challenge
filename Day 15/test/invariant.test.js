import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { LlmAgent } from "../src/agent.js";
import { parseCommand } from "../src/cli.js";
import { buildPrompt } from "../src/profile.js";
import {
  ArchOnly,
  Budget,
  Decision,
  FreeApis,
  MaxDeps,
  NoBanned,
  StackOnly,
  addInvariant,
  formatInvariantsPrompt,
  parseInvariantSpec,
} from "../src/invariant/model.js";
import {
  InvariantService,
  createInvariantStorage,
  formatRefusal,
  runInvariantPipeline,
  validateResponse,
} from "../src/invariant.js";

const tmpDirs = [];

after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), "invariants-"));
  tmpDirs.push(dir);
  const storage = createInvariantStorage({ path: join(dir, "invariants.json") });
  return { dir, storage, invariants: new InvariantService({ storage }) };
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

describe("invariant checkers", () => {
  it("StackOnly rejects a competing stack and accepts a refusal + allowed stack", () => {
    const inv = new StackOnly({ allowed: ["NodeJS", "JavaScript"] });
    assert.equal(
      inv.check("Отличный выбор, сделаем сервис на C# и ASP.NET."),
      false,
    );
    assert.equal(
      inv.check(
        "Нарушение инварианта StackOnly. C# и ASP.NET не входят в разрешенный стек. Разрешено NodeJS, JavaScript. Предлагаю решение на NodeJS.",
      ),
      true,
    );
    assert.equal(inv.check("2+2 = 4"), true);
  });

  it("ArchOnly keeps MVVM and rejects MVC as the chosen architecture", () => {
    const inv = new ArchOnly({ allowed: ["MVVM"] });
    assert.equal(inv.check("Спроектируем экран по MVVM."), true);
    assert.equal(inv.check("Возьмём классический MVC."), false);
    assert.equal(
      inv.check("MVC нельзя, остаёмся на MVVM как в инварианте."),
      true,
    );
  });

  it("Budget rejects amounts above the cap", () => {
    const inv = new Budget({ max: 100000 });
    assert.equal(inv.check("Оценка: 80 000$."), true);
    assert.equal(inv.check("Это будет стоить 250000$."), false);
    assert.equal(inv.check("Бюджет 100000$, уложимся."), true);
  });

  it("MaxDeps counts declared libraries", () => {
    const inv = new MaxDeps({ max: 5 });
    assert.equal(inv.check("Хватит 4 библиотек."), true);
    assert.equal(inv.check("Понадобится 7 библиотек."), false);
    assert.equal(inv.check("npm install lodash axios moment express mongoose prisma"), false);
  });

  it("NoBanned allows naming the ban, but not recommending it", () => {
    const inv = new NoBanned({ banned: ["RxJava"] });
    assert.equal(inv.check("Для потоков возьмём RxJava."), false);
    assert.equal(inv.check("RxJava запрещён, используйте Flow."), true);
    assert.equal(inv.check("Обычный ответ без библиотек."), true);
  });

  it("Decision and FreeApis catch explicit violations", () => {
    const decision = new Decision({ text: "REST без GraphQL" });
    assert.equal(decision.check("Сделаем GraphQL gateway."), false);
    assert.equal(decision.check("GraphQL нельзя, оставляем REST."), true);
    const apis = new FreeApis({ policy: "free" });
    assert.equal(apis.check("Подключим Stripe для оплаты."), false);
    assert.equal(apis.check("Stripe платный, нельзя. Берём бесплатный API."), true);
  });
});

describe("validate + retry pipeline", () => {
  it("passes a valid response and retries then refuses a violating one", async () => {
    const invariants = [
      new StackOnly({ allowed: ["NodeJS", "JavaScript"] }),
    ];
    const pass = validateResponse(
      "Сделаем сервис на NodeJS.",
      invariants,
    );
    assert.equal(pass.status, "pass");
    assert.equal(pass.ok, true);

    const fail = validateResponse("Сделаем на C# и ASP.NET.", invariants);
    assert.equal(fail.status, "fail");
    assert.match(fail.violations[0].description, /Stack: NodeJS/);

    const drafts = [
      "Сделаем на C# и ASP.NET.",
      "Всё равно предлагаю C#.",
    ];
    const result = await runInvariantPipeline({
      invariants,
      query: "Давай сделаем проект на C# и ASP.NET",
      buildPrompt: ({ query, violations }) =>
        `${violations.map((item) => item.description).join(",")}|${query}`,
      generate: async () => drafts.shift(),
    });
    assert.equal(result.refused, true);
    assert.equal(result.attempts, 2);
    assert.match(result.response, /Нарушение инварианта/);
    assert.doesNotMatch(result.response, /Всё равно предлагаю C#/);
  });

  it("retry can recover after a violation", async () => {
    const invariants = [new StackOnly({ allowed: ["NodeJS", "JavaScript"] })];
    const drafts = [
      "Сделаем на C#.",
      "C# не входит в стек. Предлагаю NodeJS.",
    ];
    const result = await runInvariantPipeline({
      invariants,
      query: "проект на C#",
      buildPrompt: ({ query }) => query,
      generate: async () => drafts.shift(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 2);
    assert.match(result.response, /NodeJS/);
  });
});

describe("storage is separate from dialogue", () => {
  it("round-trips a named set without touching agent messages", async () => {
    const { invariants } = makeService();
    await invariants.create("bpmn");
    await invariants.add("bpmn", "stack", ["NodeJS", "JavaScript"]);
    await invariants.add("bpmn", "arch", ["MVVM"]);
    await invariants.add("bpmn", "budget", ["100000"]);
    await invariants.add("bpmn", "maxdeps", ["5"]);
    await invariants.add("bpmn", "nobanned", ["RxJava"]);
    await invariants.add("bpmn", "apis", ["free"]);
    const loaded = await invariants.load("bpmn");
    assert.equal(loaded.id, "bpmn");
    assert.equal(loaded.items.length, 6);
    assert.equal(loaded.items[0].description, "Stack: NodeJS, JavaScript");
    const agent = makeAgent();
    assert.equal(agent.messages.length, 0);
    assert.equal(agent.invariantSetId, "");
  });
});

describe("prompt builder injects invariants before the query", () => {
  it("adds [INVARIANTS] and keeps them out of the user line", () => {
    const set = addInvariant(
      { id: "bpmn", items: [] },
      new StackOnly({ allowed: ["NodeJS", "JavaScript"] }),
    ).set;
    const block = formatInvariantsPrompt(set);
    assert.match(block, /\[INVARIANTS\]/);
    assert.match(block, /Stack: NodeJS, JavaScript/);
    assert.match(block, /ЗАПРЕЩЕНО/);
    const prompt = buildPrompt({
      system: "sys",
      invariants: block,
      query: "Давай сделаем проект на C# и ASP.NET",
    });
    assert.match(prompt, /\[INVARIANTS\]/);
    assert.match(prompt, /Давай сделаем проект на C# и ASP.NET/);
    assert.ok(prompt.indexOf("[INVARIANTS]") < prompt.indexOf("Давай сделаем"));
  });

  it("counts attached invariants in occupancy", async () => {
    const { invariants } = makeService();
    await invariants.create("bpmn");
    await invariants.add("bpmn", "StackOnly", ["NodeJS", "JavaScript"]);
    const empty = makeAgent();
    const filled = makeAgent({
      invariantSetId: "bpmn",
      invariantLoader: invariants.loader,
    });
    assert.ok(filled.tokenReport.occupancy > empty.tokenReport.occupancy);
    assert.equal(filled.tokenReport.invariantSetId, "bpmn");
    assert.equal(filled.tokenReport.invariants.count, 1);
  });
});

describe("CLI invariant commands", () => {
  it("parses create, add, attach and StackOnly(...) form", () => {
    assert.deepEqual(parseCommand("invariant create bpmn"), {
      type: "invariant",
      action: "create",
      setId: "bpmn",
    });
    assert.deepEqual(parseCommand("invariant add bpmn stack NodeJS JavaScript"), {
      type: "invariant",
      action: "add",
      setId: "bpmn",
      specType: "stack",
      specArgs: ["NodeJS", "JavaScript"],
    });
    assert.deepEqual(parseCommand("invariant attach helper bpmn"), {
      type: "invariant",
      action: "attach",
      target: "helper",
      setId: "bpmn",
    });
    assert.equal(
      parseCommand("spawn --name helper --invariants bpmn").invariantSetId,
      "bpmn",
    );
    const spec = parseInvariantSpec('StackOnly("NodeJS", "JavaScript")', []);
    assert.equal(spec.type, "stack");
    assert.deepEqual(spec.allowed, ["NodeJS", "JavaScript"]);
  });
});

describe("refusal text", () => {
  it("does not leak the violating draft", () => {
    const text = formatRefusal([
      { description: "Stack: NodeJS, JavaScript" },
    ]);
    assert.match(text, /Нарушение инварианта Stack: NodeJS, JavaScript/);
    assert.doesNotMatch(text, /ASP\.NET/);
  });
});
