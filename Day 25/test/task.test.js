import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { LlmAgent } from "../src/agent.js";
import { helpText, parseCommand } from "../src/cli.js";
import { AgentMemory } from "../src/memory.js";
import { buildPrompt } from "../src/profile.js";
import { loadState, saveState } from "../src/store.js";
import {
  TASK_DONE,
  TASK_EXECUTION,
  TASK_PLANNING,
  TASK_VALIDATION,
  TRANSITIONS,
  applyTaskSignals,
  approvePlan,
  buildTaskPrompt,
  canTransition,
  completeStep,
  createTaskContext,
  expectedAction,
  formatAllowedTransitions,
  formatResume,
  formatStageCheck,
  formatTaskPrompt,
  loadTaskContext,
  parseTaskSignals,
  saveTaskContext,
  setPlan,
  transition,
  validateStageResponse,
} from "../src/task.js";
import { runInvariantPipeline } from "../src/invariant.js";

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

function authTask() {
  return createTaskContext({ task: "сервис авторизации" });
}

describe("task state machine", () => {
  it("starts in planning with expected action", () => {
    const ctx = authTask();
    assert.equal(ctx.state, TASK_PLANNING);
    assert.equal(ctx.step, 1);
    assert.equal(ctx.total, 1);
    assert.equal(ctx.current, expectedAction(TASK_PLANNING));
    assert.deepEqual(ctx.plan, []);
    assert.deepEqual(ctx.done, []);
  });

  it("allows only the documented transitions", () => {
    assert.deepEqual(TRANSITIONS[TASK_PLANNING], [TASK_EXECUTION]);
    assert.deepEqual(TRANSITIONS[TASK_EXECUTION], [
      TASK_VALIDATION,
      TASK_PLANNING,
    ]);
    assert.deepEqual(TRANSITIONS[TASK_VALIDATION], [
      TASK_DONE,
      TASK_EXECUTION,
    ]);
    assert.deepEqual(TRANSITIONS[TASK_DONE], []);
  });

  it("rejects forbidden hops", () => {
    const ctx = authTask();
    assert.throws(
      () => transition(ctx, TASK_DONE),
      /PLANNING -> DONE запрещён: нельзя делать финал без валидации/,
    );
    assert.throws(
      () => transition(ctx, TASK_VALIDATION),
      /PLANNING -> VALIDATION запрещён: нельзя перепрыгнуть реализацию/,
    );
  });

  it("blocks execution until the plan is approved", () => {
    const ctx = authTask();
    const denied = canTransition(ctx, TASK_EXECUTION);
    assert.equal(denied.ok, false);
    assert.match(denied.reason, /реализацию до утверждённого плана/);
    assert.throws(
      () => transition(ctx, TASK_EXECUTION),
      /нельзя делать реализацию до утверждённого плана/,
    );
    const drafted = setPlan(ctx, "JWT module | Token validation");
    assert.equal(canTransition(drafted, TASK_EXECUTION).ok, true);
    const next = transition(drafted, TASK_EXECUTION);
    assert.equal(next.state, TASK_EXECUTION);
    assert.equal(next.current, "JWT module");
  });

  it("blocks done until validation", () => {
    let ctx = approvePlan(setPlan(authTask(), "JWT module | Token validation"));
    const hop = canTransition(ctx, TASK_DONE);
    assert.equal(hop.ok, false);
    assert.match(hop.reason, /финал без валидации/);
    assert.throws(
      () => transition(ctx, TASK_DONE),
      /EXECUTION -> DONE запрещён: нельзя делать финал без валидации/,
    );
    ctx = transition(ctx, TASK_VALIDATION);
    ctx = transition(ctx, TASK_DONE);
    assert.equal(ctx.state, TASK_DONE);
  });

  it("approves a plan and enters execution at step 1/N", () => {
    let ctx = setPlan(
      authTask(),
      "JWT module | Token validation | Refresh | Tests",
    );
    ctx = approvePlan(ctx);
    assert.equal(ctx.state, TASK_EXECUTION);
    assert.equal(ctx.step, 1);
    assert.equal(ctx.total, 4);
    assert.equal(ctx.current, "JWT module");
  });

  it("completes a step and moves to the next plan item", () => {
    let ctx = approvePlan(
      setPlan(authTask(), "JWT module | Token validation | Refresh | Tests"),
    );
    ctx = completeStep(ctx, "Token validation");
    assert.equal(ctx.state, TASK_EXECUTION);
    assert.equal(ctx.step, 2);
    assert.equal(ctx.total, 4);
    assert.equal(ctx.current, "Token validation");
    assert.deepEqual(ctx.done, ["JWT module"]);
  });

  it("can return from execution to planning and from validation to execution", () => {
    let ctx = approvePlan(setPlan(authTask(), "JWT module | Token validation"));
    ctx = transition(ctx, TASK_PLANNING);
    assert.equal(ctx.state, TASK_PLANNING);
    ctx = approvePlan(ctx);
    ctx = transition(ctx, TASK_VALIDATION);
    assert.equal(ctx.state, TASK_VALIDATION);
    ctx = transition(ctx, TASK_EXECUTION);
    assert.equal(ctx.state, TASK_EXECUTION);
    ctx = transition(ctx, TASK_VALIDATION);
    ctx = transition(ctx, TASK_DONE);
    assert.equal(ctx.state, TASK_DONE);
    assert.equal(ctx.current, expectedAction(TASK_DONE));
    assert.throws(() => transition(ctx, TASK_EXECUTION), /DONE -> EXECUTION запрещён/);
  });
});

describe("task prompt", () => {
  it("builds STATE / CURRENT / PLAN / DONE / PROFILE / QUERY", () => {
    let ctx = approvePlan(
      setPlan(authTask(), "JWT module | Token validation | Refresh | Tests"),
    );
    ctx = completeStep(ctx, "Token validation");
    const prompt = buildTaskPrompt("Продолжай", ctx, {
      userId: "alex",
      name: "Алексей",
    });
    assert.match(prompt, /\[STATE\] EXECUTION, step 2\/4/);
    assert.match(prompt, /\[CURRENT\] Token validation/);
    assert.match(prompt, /\[PLAN\] JWT module; Token validation; Refresh; Tests/);
    assert.match(prompt, /\[DONE\] JWT module/);
    assert.match(prompt, /\[PROFILE\] alex \/ Алексей/);
    assert.match(prompt, /\[QUERY\] Продолжай/);
    assert.match(prompt, /Работай только в рамках current step/);
    assert.match(prompt, /\[TRANSITIONS\]/);
    assert.match(prompt, /\[FORBIDDEN\] planning→validation\|done; execution→done/);
  });

  it("injects the task block into the host prompt builder", () => {
    const ctx = createTaskContext({ task: "сервис авторизации" });
    const prompt = buildPrompt({
      profile: { userId: "alex", name: "Алексей", style: {}, constraints: {}, context: {} },
      task: formatTaskPrompt(ctx),
      query: "Начни сервис авторизации",
    });
    assert.match(prompt, /\[STATE\] PLANNING/);
    assert.match(prompt, /Начни сервис авторизации/);
  });
});

describe("pause and resume", () => {
  it("saves and loads the same task context", () => {
    let ctx = approvePlan(
      setPlan(authTask(), "JWT module | Token validation | Refresh | Tests"),
    );
    ctx = completeStep(ctx, "Token validation");
    const saved = saveTaskContext(ctx);
    const loaded = loadTaskContext(saved);
    assert.equal(loaded.state, TASK_EXECUTION);
    assert.equal(loaded.step, 2);
    assert.equal(loaded.total, 4);
    assert.equal(loaded.current, "Token validation");
    assert.equal(
      formatResume(loaded),
      "State: EXECUTION, шаг 2/4. Продолжаю Token validation.",
    );
  });

  it("round-trips the machine through agents.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "task-"));
    tmpDirs.push(dir);
    const file = join(dir, "agents.json");
    const agent = makeAgent();
    await agent.startTask("сервис авторизации");
    await agent.setTaskPlan("JWT module | Token validation | Refresh | Tests");
    await agent.approveTask();
    await agent.nextTaskStep("Token validation");

    saveState(file, { nextId: 2, agents: [agent.toJSON()] });
    const loaded = loadState(file);
    const restored = makeAgent(loaded.agents[0]);
    const ctx = restored.taskContext;
    assert.equal(ctx.state, TASK_EXECUTION);
    assert.equal(ctx.step, 2);
    assert.equal(ctx.current, "Token validation");
    assert.equal(
      formatResume(ctx),
      "State: EXECUTION, шаг 2/4. Продолжаю Token validation.",
    );
  });
});

describe("task signals from the model", () => {
  it("parses NEXT_STEP, PLAN_SET, APPROVE_PLAN and TRANSITION", () => {
    const signals = parseTaskSignals(
      [
        "План готов.",
        "PLAN_SET: JWT module | Token validation | Refresh | Tests",
        "APPROVE_PLAN",
        "NEXT_STEP: Token validation",
        "TRANSITION: validation",
      ].join("\n"),
    );
    assert.deepEqual(
      signals.map((item) => item.type),
      ["plan", "approve", "next", "transition"],
    );
  });

  it("applies plan + approve + next_step from a reply", () => {
    const { context, changed } = applyTaskSignals(
      authTask(),
      [
        "PLAN_SET: JWT module | Token validation | Refresh | Tests",
        "APPROVE_PLAN",
        "NEXT_STEP: Token validation",
      ].join("\n"),
    );
    assert.equal(changed, true);
    assert.equal(context.state, TASK_EXECUTION);
    assert.equal(context.step, 2);
    assert.equal(context.current, "Token validation");
  });

  it("ignores a forbidden transition in a reply instead of throwing", () => {
    const { context, changed } = applyTaskSignals(
      authTask(),
      "TRANSITION: done",
    );
    assert.equal(changed, false);
    assert.equal(context.state, TASK_PLANNING);
  });

  it("ignores execution hop from a reply when the plan is empty", () => {
    const { context, changed } = applyTaskSignals(
      authTask(),
      "TRANSITION: execution",
    );
    assert.equal(changed, false);
    assert.equal(context.state, TASK_PLANNING);
  });
});

describe("CLI task commands", () => {
  it("parses plan, approve, next, transition and continue", () => {
    assert.deepEqual(
      parseCommand("task helper plan JWT module | Token validation | Refresh | Tests"),
      {
        type: "task",
        target: "helper",
        action: "plan",
        items: "JWT module | Token validation | Refresh | Tests",
      },
    );
    assert.equal(parseCommand("task helper approve").action, "approve");
    assert.deepEqual(parseCommand("task helper next Token validation"), {
      type: "task",
      target: "helper",
      action: "next",
      current: "Token validation",
    });
    assert.deepEqual(parseCommand("task helper transition validation"), {
      type: "task",
      target: "helper",
      action: "transition",
      state: "validation",
    });
    assert.equal(parseCommand("task helper continue").action, "continue");
    assert.equal(parseCommand("task helper").action, "show");
  });

  it("help lists task subcommands and that start does not write a plan", () => {
    const help = helpText();
    assert.match(help, /план остаётся пустым/);
    assert.match(help, /task <name\|id> plan пункт/);
    assert.match(help, /PLAN_SET/);
    assert.match(help, /модель не вызывается/);
    assert.match(help, /remember working — заметки в entries/);
    assert.match(help, /execution без утверждённого плана/);
  });
});

describe("agent task context", () => {
  it("startTask initializes the machine and counts toward occupancy", async () => {
    const empty = makeAgent();
    const filled = makeAgent();
    await filled.startTask("сервис авторизации");
    assert.equal(filled.taskContext.state, TASK_PLANNING);
    assert.ok(filled.tokenReport.occupancy > empty.tokenReport.occupancy);
    assert.match(formatTaskPrompt(filled.taskContext), /\[STATE\] PLANNING/);
  });

  it("forget working clears the machine", () => {
    const memory = new AgentMemory();
    memory.startTask("сервис авторизации");
    memory.setTaskPlan("JWT module | Token validation");
    memory.forget("working");
    assert.equal(memory.working.task, "");
    assert.equal(memory.taskContext().task, "");
    assert.equal(memory.taskContext().step, 0);
  });
});

const IMPLEMENTATION_DRAFT = [
  "Вот реализация JWT:",
  "```javascript",
  "import jwt from \"jsonwebtoken\";",
  "export function sign(payload) {",
  "  return jwt.sign(payload, process.env.SECRET);",
  "}",
  "export function verify(token) {",
  "  return jwt.verify(token, process.env.SECRET);",
  "}",
  "```",
].join("\n");

describe("controlled stage policy", () => {
  it("rejects implementation during planning and accepts a plan-only reply", () => {
    const ctx = authTask();
    const fail = validateStageResponse(IMPLEMENTATION_DRAFT, ctx);
    assert.equal(fail.ok, false);
    assert.match(fail.violations[0].description, /реализацию до утверждённого плана/);

    const pass = validateStageResponse(
      "План: JWT module | Token validation\nPLAN_SET: JWT module | Token validation",
      ctx,
    );
    assert.equal(pass.ok, true);

    const refusal = validateStageResponse(
      "Нельзя писать реализацию на этапе PLANNING. Сначала нужно утвердить план.",
      ctx,
    );
    assert.equal(refusal.ok, true);
  });

  it("rejects a final claim before validation and allows it after", () => {
    const executing = approvePlan(
      setPlan(authTask(), "JWT module | Token validation"),
    );
    const early = validateStageResponse(
      "Задача завершена. Финальный отчёт готов к сдаче.",
      executing,
    );
    assert.equal(early.ok, false);
    assert.match(early.violations[0].description, /финал без валидации/);

    const validating = transition(executing, TASK_VALIDATION);
    const later = validateStageResponse(
      "Проверил тесты. TRANSITION: done",
      validating,
    );
    assert.equal(later.ok, true);
  });

  it("lists allowed hops on the report", () => {
    const emptyPlan = authTask();
    assert.match(
      formatAllowedTransitions(emptyPlan),
      /только после утверждённого плана/,
    );
    const executing = approvePlan(setPlan(emptyPlan, "JWT module"));
    assert.equal(formatAllowedTransitions(executing), "validation, planning");
  });

  it("retries then refuses a stage skip in the ask pipeline", async () => {
    const drafts = [IMPLEMENTATION_DRAFT, IMPLEMENTATION_DRAFT];
    const result = await runInvariantPipeline({
      invariants: [],
      extraValidate: (response) => validateStageResponse(response, authTask()),
      query: "Сразу напиши код",
      buildPrompt: ({ query }) => query,
      generate: async () => drafts.shift(),
    });
    assert.equal(result.refused, true);
    assert.equal(result.attempts, 2);
    assert.match(result.response, /Нарушение этапа PLANNING/);
    assert.doesNotMatch(result.response, /jsonwebtoken/);
    assert.equal(
      formatStageCheck(result),
      "этап: ответ отклонён (нельзя делать реализацию до утверждённого плана)",
    );
  });
});
