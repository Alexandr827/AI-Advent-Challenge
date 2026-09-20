import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/env.js";
import { AgentPool } from "../src/pool.js";
import { formatAskTokenLine, formatTokensCommand } from "../src/tokens.js";
import { formatInvariantCheck } from "../src/invariant.js";
import {
  formatResume,
  formatStageCheck,
  formatTaskApplied,
  formatTaskBanner,
  formatTaskReport,
  formatTransitionMessage,
} from "../src/task.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(resolve(projectRoot, ".env"));

const API_KEY = process.env.CURSOR_API_KEY?.trim();
const MODEL = process.env.CURSOR_MODEL ?? "composer-2.5";
const RUNTIME = (process.env.CURSOR_RUNTIME ?? "local").toLowerCase();

if (!API_KEY) {
  console.error("Задайте CURSOR_API_KEY в .env");
  process.exit(1);
}

const AGENT = "lifecycle";
const TASK = "сервис авторизации";
const PLAN = "JWT module | Token validation | Refresh | Tests";
const SYSTEM =
  "Отвечай по-русски. Маркеры PLAN_SET, APPROVE_PLAN, NEXT_STEP, TRANSITION ставь на отдельных строках, когда шаг или этап завершён.";

const ASK_IMPLEMENTATION =
  "Сразу напиши полную реализацию JWT-модуля на JavaScript: sign, verify, refresh, middleware. Не план — готовый код в одном javascript-блоке, не меньше восьми функций. Потом объяви задачу завершённой и поставь TRANSITION: done.";
const ASK_FINAL =
  "Задача завершена. Финальный отчёт готов к сдаче. Закрываю задачу. TRANSITION: done. Не пиши код шага JWT module.";
const ASK_RESUME =
  "Продолжай только текущий шаг. Кратко, на уровне проектирования, без полного кода модуля. Не переходи к validation и не объявляй задачу завершённой.";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function persist(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function preview(text, n = 900) {
  const s = String(text ?? "").trim();
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

function snapshotTask(ctx) {
  if (!ctx) return null;
  return {
    task: ctx.task,
    state: ctx.state,
    step: ctx.step,
    total: ctx.total,
    current: ctx.current,
    plan: [...(ctx.plan ?? [])],
    done: [...(ctx.done ?? [])],
  };
}

function pipelineSnapshot(pipeline) {
  if (!pipeline) return null;
  return {
    ok: pipeline.ok ?? null,
    refused: pipeline.refused ?? false,
    attempts: pipeline.attempts ?? 1,
    status: pipeline.status ?? null,
    retryKinds: pipeline.retryKinds ?? [],
    violations: (pipeline.violations ?? []).map((row) => ({
      kind: row.kind ?? "invariant",
      id: row.id,
      description: row.description,
      state: row.state,
    })),
  };
}

function reactionOf(pipeline, reply, before, after) {
  const text = String(reply ?? "");
  const hostRefused = Boolean(pipeline?.refused);
  const selfRefusal =
    /(нельзя|запрещено|отказываюсь|не могу).{0,120}(реализац|этап|план|валидац|финал|перепрыг)|сначала (нужно |надо )?утвердить план|без валидации нельзя/i.test(
      text,
    );
  return {
    hostRefused,
    selfRefusal,
    stateChanged: before?.state !== after?.state,
    appliedKinds: [],
  };
}

async function askWithRetry(agent, text, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await agent.ask(text);
    } catch (err) {
      lastErr = err;
      console.error(`# retry ${i}/${attempts}: ${err.message ?? err}`);
      await sleep(2000 * i);
    }
  }
  throw lastErr;
}

const outPath = resolve(projectRoot, "data", "task-lifecycle-cycle.json");
const storePath = resolve(projectRoot, "data", "task-lifecycle-agents.json");

function makePool() {
  return new AgentPool({
    apiKey: API_KEY,
    defaultModel: MODEL,
    defaultRuntime: RUNTIME,
    cwd: projectRoot,
    storePath,
  });
}

const transcript = [];
function line(text = "") {
  transcript.push(text);
  console.log(text);
}

const report = {
  model: MODEL,
  runtime: RUNTIME,
  at: new Date().toISOString(),
  systemPrompt: SYSTEM,
  hops: [],
  asks: [],
  pause: null,
  legal: [],
  transcript: "",
};

function save() {
  persist(outPath, { ...report, transcript: transcript.join("\n") });
}

async function tryHop(agent, target, id) {
  line(`> task ${AGENT} transition ${target}`);
  const before = snapshotTask(agent.taskContext);
  try {
    const { previous, context } = await agent.transitionTask(target);
    const msg = formatTransitionMessage(previous, context);
    line(msg);
    line(formatTaskReport(context));
    const row = {
      id,
      target,
      ok: true,
      from: before.state,
      to: context.state,
      message: msg,
    };
    report.hops.push(row);
    save();
    return row;
  } catch (err) {
    const message = String(err.message ?? err);
    line(message);
    const row = {
      id,
      target,
      ok: false,
      from: before.state,
      to: target,
      message,
    };
    report.hops.push(row);
    save();
    return row;
  }
}

async function runAsk(agent, { id, query, expectStay }) {
  const before = snapshotTask(agent.taskContext);
  line(`> ask ${AGENT} ${query}`);
  line(`→ ${agent.name}:`);
  const { reply, tokens, task, invariants: pipeline } = await askWithRetry(
    agent,
    query,
  );
  if (task?.active) {
    const shown = task.before?.task ? task.before : task.context;
    const banner = formatTaskBanner(shown);
    if (banner) line(banner);
  }
  const checkLine = formatInvariantCheck(pipeline);
  if (checkLine) line(checkLine);
  const stageLine = formatStageCheck(pipeline);
  if (stageLine) line(stageLine);
  line(reply.trim() || "(пусто)");
  if (task?.changed) {
    line(formatTaskApplied(task.applied, task.context));
  }
  line(formatAskTokenLine(tokens));
  line("");

  const after = snapshotTask(task?.context ?? agent.taskContext);
  const reaction = reactionOf(pipeline, reply, before, after);
  reaction.appliedKinds = (task?.applied ?? []).map((item) => item.type);
  const row = {
    id,
    query,
    expectStay,
    before,
    after,
    reply: reply.trim(),
    replyPreview: preview(reply),
    stageLine,
    checkLine,
    tokenLine: formatAskTokenLine(tokens),
    occupancy: tokens.occupancy,
    usage: tokens.usage,
    last: tokens.last,
    pipeline: pipelineSnapshot(pipeline),
    applied: task?.applied ?? [],
    changed: Boolean(task?.changed),
    reaction,
  };
  report.asks.push(row);
  save();
  return row;
}

let pool = makePool();

try {
  line("npm start");
  line(
    `CLI-хост агентов. Модель по умолчанию: ${MODEL}, runtime: ${RUNTIME}. Лимит: 100.`,
  );
  line(
    "Введите help для списка команд. Память: short / working / long. Задача: planning → execution → validation → done (переходы контролируемые). Персонализация: profile / style / constraints / context. Инварианты: invariant — отдельное хранилище, проверка каждого ответа.",
  );
  line(">");

  if (pool.get(AGENT)) {
    line(`> kill ${AGENT}`);
    await pool.kill(AGENT);
    line(`Агент ${AGENT} остановлен`);
  }

  line(
    `> spawn --name ${AGENT} --no-compress --strategy full --system "${SYSTEM}"`,
  );
  const [agent0] = pool.spawn({
    name: AGENT,
    strategy: "full",
    compress: false,
    systemPrompt: SYSTEM,
  });
  line(`Создано: 1`);
  line(
    `  #${agent0.id}  ${agent0.name}  model=${agent0.model}  runtime=${agent0.runtime}  ${agent0.status}  messages=0 compress=off  memory=s0/w0/l0`,
  );

  line(`> task ${AGENT} start ${TASK}`);
  const started = await agent0.startTask(TASK);
  line(
    `Новая задача ${agent0.name}: «${started.task}». Этап PLANNING, шаг 1/1. Рабочая память очищена.`,
  );
  line(formatTaskReport(started.context));
  line("");

  line("# Попытки недопустимых переходов с CLI (этап PLANNING, план пустой)");
  await tryHop(agent0, "execution", "cli-planning-execution");
  line("");
  await tryHop(agent0, "validation", "cli-planning-validation");
  line("");
  await tryHop(agent0, "done", "cli-planning-done");
  line("");

  line("# Реакция ассистента: реализация и финал ещё на PLANNING");
  await runAsk(agent0, {
    id: "planning-skip",
    query: ASK_IMPLEMENTATION,
    expectStay: "planning",
  });

  line(`> task ${AGENT} plan ${PLAN}`);
  const planned = await agent0.setTaskPlan(PLAN);
  line(formatTaskReport(planned));
  line("");

  line(`> task ${AGENT} approve`);
  const approved = await agent0.approveTask();
  line(formatTransitionMessage(approved.previous, approved.context));
  line(formatTaskReport(approved.context));
  line("");

  line("# Попытка закрыть задачу с EXECUTION");
  await tryHop(agent0, "done", "cli-execution-done");
  line("");

  line("# Реакция ассистента: финал без валидации");
  await runAsk(agent0, {
    id: "execution-final",
    query: ASK_FINAL,
    expectStay: "execution",
  });

  const beforePause = snapshotTask(agent0.taskContext);
  line("# Пауза: процесс останавливается, состояние остаётся в store");
  line(`> exit`);
  await pool.disposeAll();
  pool = makePool();
  const resumed = pool.get(AGENT);
  if (!resumed) {
    throw new Error("После паузы агент lifecycle не восстановился из store");
  }
  line(
    `CLI-хост агентов. Модель по умолчанию: ${MODEL}, runtime: ${RUNTIME}. Лимит: 100.`,
  );
  line(`Восстановлено агентов: ${pool.size}. История диалогов загружена.`);
  line(">");
  line(`> task ${AGENT} continue`);
  const resumeText = formatResume(resumed.taskContext);
  line(resumeText);
  line(formatTaskReport(resumed.taskContext));
  line("");

  report.pause = {
    before: beforePause,
    after: snapshotTask(resumed.taskContext),
    resume: resumeText,
    sameState:
      beforePause.state === resumed.taskContext.state &&
      beforePause.step === resumed.taskContext.step &&
      beforePause.current === resumed.taskContext.current,
  };
  save();

  line("# Продолжение после паузы");
  await runAsk(resumed, {
    id: "resume-continue",
    query: ASK_RESUME,
    expectStay: "execution",
  });

  line("# Легальный путь к DONE");
  await tryHop(resumed, "validation", "cli-execution-validation");
  line("");
  line(`> task ${AGENT} continue`);
  line(formatResume(resumed.taskContext));
  line("");
  await tryHop(resumed, "done", "cli-validation-done");
  line("");
  line(`> task ${AGENT} continue`);
  line(formatResume(resumed.taskContext));
  line("");
  await tryHop(resumed, "execution", "cli-done-execution");
  line("");

  line(`> tokens ${AGENT}`);
  line(formatTokensCommand(resumed.tokenReport));
  line("");
  line(`> list`);
  const listed = pool.list()[0];
  if (listed) {
    line(
      `  #${listed.id}  ${listed.name}  model=${listed.model}  runtime=${listed.runtime}  ${listed.status}  messages=${listed.messages} compress=off  memory=s${listed.memory.short}/w${listed.memory.working}/l${listed.memory.long}  task=${listed.memory.taskState} ${listed.memory.taskStep}/${listed.memory.taskTotal}`,
    );
  }

  report.legal = report.hops.filter((row) =>
    ["cli-execution-validation", "cli-validation-done", "cli-done-execution"].includes(
      row.id,
    ),
  );
  report.atEnd = new Date().toISOString();
  report.usage = resumed.tokenReport.usage;
  report.task = snapshotTask(resumed.taskContext);
  save();
  console.error(`\nSaved ${outPath}`);
} finally {
  await pool.disposeAll();
}
