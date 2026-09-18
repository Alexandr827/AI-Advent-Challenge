export const TaskState = Object.freeze({
  PLANNING: "planning",
  EXECUTION: "execution",
  VALIDATION: "validation",
  DONE: "done",
});

export const TASK_PLANNING = TaskState.PLANNING;
export const TASK_EXECUTION = TaskState.EXECUTION;
export const TASK_VALIDATION = TaskState.VALIDATION;
export const TASK_DONE = TaskState.DONE;

export const TASK_STATES = [
  TASK_PLANNING,
  TASK_EXECUTION,
  TASK_VALIDATION,
  TASK_DONE,
];

export const TRANSITIONS = Object.freeze({
  [TASK_PLANNING]: [TASK_EXECUTION],
  [TASK_EXECUTION]: [TASK_VALIDATION, TASK_PLANNING],
  [TASK_VALIDATION]: [TASK_DONE, TASK_EXECUTION],
  [TASK_DONE]: [],
});

export const EXPECTED_ACTIONS = Object.freeze({
  [TASK_PLANNING]: "собираем требования, утверждаем план",
  [TASK_EXECUTION]: "пишем код, создаём артефакты",
  [TASK_VALIDATION]: "тесты, ревью, соответствие плану",
  [TASK_DONE]: "задача завершена, фиксируем результат",
});

const STATE_ALIASES = {
  planning: TASK_PLANNING,
  plan: TASK_PLANNING,
  план: TASK_PLANNING,
  планирование: TASK_PLANNING,
  execution: TASK_EXECUTION,
  exec: TASK_EXECUTION,
  выполнение: TASK_EXECUTION,
  реализация: TASK_EXECUTION,
  validation: TASK_VALIDATION,
  validate: TASK_VALIDATION,
  проверка: TASK_VALIDATION,
  валидация: TASK_VALIDATION,
  done: TASK_DONE,
  complete: TASK_DONE,
  completed: TASK_DONE,
  готово: TASK_DONE,
  завершено: TASK_DONE,
};

const SIGNAL_ALIASES = {
  next_step: "next",
  nextstep: "next",
  next: "next",
  transition: "transition",
  plan_set: "plan",
  planset: "plan",
  plan: "plan",
  approve_plan: "approve",
  approveplan: "approve",
  approve: "approve",
  current: "current",
};

export function expectedAction(state) {
  return EXPECTED_ACTIONS[normalizeState(state)] ?? EXPECTED_ACTIONS[TASK_PLANNING];
}

export function labelState(state) {
  return String(state ?? "").toUpperCase();
}

export function parseState(raw, flag = "этап задачи") {
  const key = String(raw ?? "")
    .trim()
    .toLowerCase();
  const state = STATE_ALIASES[key];
  if (!state) {
    throw new Error(
      `${flag} должен быть planning, execution, validation или done`,
    );
  }
  return state;
}

export function normalizeState(raw, fallback = TASK_PLANNING) {
  const key = String(raw ?? "")
    .trim()
    .toLowerCase();
  return STATE_ALIASES[key] ?? fallback;
}

export function parsePlanItems(raw) {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item ?? "").trim()).filter(Boolean);
  }
  const text = String(raw ?? "").trim();
  if (!text) return [];
  const numbered = text.match(/^\d+[.)]\s+/m);
  if (numbered) {
    return text
      .split(/\s*\d+[.)]\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return text
    .split(/\s*[|;]\s*|\n+/)
    .map((item) => item.replace(/^\d+[.)]\s*/, "").trim())
    .filter(Boolean);
}

export function emptyTaskContext() {
  return {
    task: "",
    state: TASK_PLANNING,
    step: 0,
    total: 0,
    plan: [],
    done: [],
    current: "",
  };
}

export function isActiveTask(ctx) {
  return Boolean(ctx && String(ctx.task ?? "").trim());
}

function asInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}

export function createTaskContext({
  task = "",
  state,
  step,
  total,
  plan,
  done,
  current,
} = {}) {
  const title = String(task ?? "").trim();
  if (!title) return emptyTaskContext();
  const normalizedState = normalizeState(state, TASK_PLANNING);
  const items = parsePlanItems(plan);
  const finished = parsePlanItems(done);
  const nextStep = Math.max(1, asInt(step, 1));
  const nextTotal = Math.max(1, items.length, nextStep, asInt(total, 1));
  return {
    task: title,
    state: normalizedState,
    step: Math.min(nextStep, nextTotal),
    total: nextTotal,
    plan: items,
    done: finished,
    current: String(current ?? "").trim() || expectedAction(normalizedState),
  };
}

export function normalizeTaskContext(row, { task: fallbackTask = "" } = {}) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    const task = String(fallbackTask ?? "").trim();
    return task ? createTaskContext({ task }) : emptyTaskContext();
  }
  const task = String(row.task ?? fallbackTask ?? "").trim();
  if (
    !task &&
    !row.current &&
    !parsePlanItems(row.plan).length &&
    !parsePlanItems(row.done).length
  ) {
    return emptyTaskContext();
  }
  return createTaskContext({ ...row, task });
}

export function cloneTaskContext(ctx) {
  const src = normalizeTaskContext(ctx);
  return {
    task: src.task,
    state: src.state,
    step: src.step,
    total: src.total,
    plan: [...src.plan],
    done: [...src.done],
    current: src.current,
  };
}

export function saveTaskContext(ctx) {
  return cloneTaskContext(ctx);
}

export function loadTaskContext(raw) {
  return normalizeTaskContext(raw);
}

function requireActive(ctx) {
  if (!isActiveTask(ctx)) {
    throw new Error("Нет активной задачи. Сначала: task <агент> start <название>");
  }
  return ctx;
}

function copy(ctx, patch) {
  return cloneTaskContext({ ...ctx, ...patch });
}

function executionCursor(ctx, currentOverride) {
  const total = Math.max(1, ctx.plan.length, ctx.total);
  if (currentOverride) {
    const idx = ctx.plan.indexOf(currentOverride);
    return {
      step: idx >= 0 ? idx + 1 : 1,
      total: Math.max(total, idx + 1),
      current: currentOverride,
    };
  }
  const idx = ctx.plan.findIndex((item) => !ctx.done.includes(item));
  if (idx >= 0) {
    return { step: idx + 1, total: Math.max(total, ctx.plan.length), current: ctx.plan[idx] };
  }
  return {
    step: 1,
    total,
    current: ctx.plan[0] || expectedAction(TASK_EXECUTION),
  };
}

export function transition(ctx, target, { current } = {}) {
  const src = requireActive(normalizeTaskContext(ctx));
  const nextState = parseState(target, "целевой этап");
  const allowed = TRANSITIONS[src.state] ?? [];
  if (!allowed.includes(nextState)) {
    throw new Error(`${labelState(src.state)} -> ${labelState(nextState)} запрещён`);
  }

  const override = String(current ?? "").trim();
  if (nextState === TASK_EXECUTION) {
    const cursor = executionCursor(src, override);
    return copy(src, { state: nextState, ...cursor });
  }
  if (nextState === TASK_VALIDATION) {
    return copy(src, {
      state: nextState,
      step: 1,
      total: Math.max(1, src.total),
      current: override || expectedAction(TASK_VALIDATION),
    });
  }
  if (nextState === TASK_PLANNING) {
    return copy(src, {
      state: nextState,
      step: 1,
      total: Math.max(1, src.plan.length, src.total),
      current: override || expectedAction(TASK_PLANNING),
    });
  }
  return copy(src, {
    state: TASK_DONE,
    step: Math.max(1, src.total),
    total: Math.max(1, src.total),
    current: override || expectedAction(TASK_DONE),
  });
}

export function setPlan(ctx, items) {
  const src = requireActive(normalizeTaskContext(ctx));
  const plan = parsePlanItems(items);
  if (!plan.length) {
    throw new Error("План не может быть пустым");
  }
  const inPlanning = src.state === TASK_PLANNING;
  return copy(src, {
    plan,
    total: plan.length,
    step: inPlanning ? src.step : 1,
    current: inPlanning
      ? src.current || expectedAction(TASK_PLANNING)
      : plan[0],
  });
}

export function approvePlan(ctx) {
  const src = requireActive(normalizeTaskContext(ctx));
  if (src.state !== TASK_PLANNING) {
    throw new Error("Утвердить план можно только на этапе PLANNING");
  }
  if (!src.plan.length) {
    throw new Error("Сначала задайте план: task <агент> plan пункт | пункт");
  }
  return transition(src, TASK_EXECUTION);
}

export function completeStep(ctx, nextCurrent = "") {
  const src = requireActive(normalizeTaskContext(ctx));
  if (src.state === TASK_DONE) {
    throw new Error("Задача уже завершена");
  }

  const done = [...src.done];
  const finished = String(src.current ?? "").trim();
  if (finished && !done.includes(finished)) {
    done.push(finished);
  }

  const provided = String(nextCurrent ?? "").trim();
  const total = Math.max(1, src.total, src.plan.length);

  if (src.step >= total) {
    return copy(src, {
      done,
      total,
      current: provided || `этап ${src.state} можно завершать`,
    });
  }

  const step = src.step + 1;
  const fromPlan = src.plan[step - 1] ?? "";
  return copy(src, {
    step,
    total,
    done,
    current: provided || fromPlan || expectedAction(src.state),
  });
}

export function setCurrent(ctx, current) {
  const src = requireActive(normalizeTaskContext(ctx));
  const value = String(current ?? "").trim();
  if (!value) {
    throw new Error("Нужно описание текущего шага");
  }
  return copy(src, { current: value });
}

export function parseTaskSignals(text) {
  const signals = [];
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(
      /^(?:\[(NEXT_STEP|TRANSITION|PLAN_SET|APPROVE_PLAN)\]|(NEXT_STEP|TRANSITION|PLAN_SET|APPROVE_PLAN|CURRENT|next_step))\s*:?\s*(.*)$/i,
    );
    if (!match) continue;
    const kind = String(match[1] || match[2] || "")
      .trim()
      .toLowerCase()
      .replace(/-/g, "_");
    const value = String(match[3] ?? "").trim();
    const type = SIGNAL_ALIASES[kind];
    if (!type) continue;
    if (type === "approve") signals.push({ type: "approve" });
    else if (type === "next") signals.push({ type: "next", current: value });
    else if (type === "transition") signals.push({ type: "transition", state: value });
    else if (type === "plan") signals.push({ type: "plan", items: value });
    else if (type === "current") signals.push({ type: "current", current: value });
  }
  return signals;
}

function applyOneSignal(ctx, signal) {
  switch (signal?.type) {
    case "plan":
      return setPlan(ctx, signal.items);
    case "approve":
      return approvePlan(ctx);
    case "next":
      return completeStep(ctx, signal.current);
    case "transition":
      return transition(ctx, signal.state);
    case "current":
      return setCurrent(ctx, signal.current);
    default:
      return ctx;
  }
}

export function applyTaskSignals(ctx, text) {
  const signals = parseTaskSignals(text);
  let current = normalizeTaskContext(ctx);
  const applied = [];
  for (const signal of signals) {
    try {
      current = applyOneSignal(current, signal);
      applied.push(signal);
    } catch {
      // ответ модели не должен рвать ask из-за запрещённого перехода
    }
  }
  return { context: current, applied, changed: applied.length > 0 };
}

function formatProfileRef(profile) {
  if (profile == null || profile === "") return "";
  if (typeof profile === "string") return profile;
  return [profile.userId, profile.name].filter(Boolean).join(" / ");
}

export function formatTaskPrompt(ctx) {
  const src = normalizeTaskContext(ctx);
  if (!isActiveTask(src)) return "";
  return [
    `[STATE] ${labelState(src.state)}, step ${src.step}/${src.total}`,
    `[CURRENT] ${src.current}`,
    `[EXPECTED] ${expectedAction(src.state)}`,
    `[PLAN] ${src.plan.join("; ") || "—"}`,
    `[DONE] ${src.done.join("; ") || "—"}`,
    "",
    "Rules:",
    "- Работай только в рамках current step",
    "- Не перепрыгивай этап",
    "- Если step завершён — верни NEXT_STEP: <описание следующего шага>",
    "- Если этап завершён — верни TRANSITION: <execution|validation|done>",
    "- Если план собран — верни PLAN_SET: пункт | пункт",
    "- Если план утверждён — верни APPROVE_PLAN",
  ].join("\n");
}

export function buildTaskPrompt(query, ctx, profile) {
  const profileText = formatProfileRef(profile);
  return [
    formatTaskPrompt(ctx),
    profileText ? `[PROFILE] ${profileText}` : "",
    `[QUERY] ${query}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatResume(ctx) {
  const src = normalizeTaskContext(ctx);
  if (!isActiveTask(src)) return "Нет активной задачи";
  if (src.state === TASK_DONE) {
    return `State: DONE. Задача «${src.task}» завершена.`;
  }
  const current = src.current || expectedAction(src.state);
  return `State: ${labelState(src.state)}, шаг ${src.step}/${src.total}. Продолжаю ${current}.`;
}

export function formatTaskBanner(ctx) {
  const src = normalizeTaskContext(ctx);
  if (!isActiveTask(src)) return "";
  return `состояние: ${labelState(src.state)}, шаг ${src.step}/${src.total} — ${src.current || expectedAction(src.state)}`;
}

export function formatTaskApplied(applied, ctx) {
  if (!applied?.length) return "";
  const src = normalizeTaskContext(ctx);
  const kinds = applied.map((item) => String(item.type).toUpperCase()).join(", ");
  return `автомат: ${kinds} → ${labelState(src.state)}, шаг ${src.step}/${src.total}: ${src.current}`;
}

export function formatTransitionMessage(prev, next) {
  const from = normalizeTaskContext(prev);
  const to = normalizeTaskContext(next);
  if (from.state === TASK_PLANNING && to.state === TASK_EXECUTION) {
    return `План утверждён -> execution. Шаг ${to.step}/${to.total}: ${to.current}`;
  }
  return `${labelState(from.state)} -> ${labelState(to.state)}. Шаг ${to.step}/${to.total}: ${to.current}`;
}

function formatPlanList(ctx) {
  if (!ctx.plan.length) return " (пусто)";
  return `\n${ctx.plan
    .map((item, index) => {
      const n = index + 1;
      const mark = ctx.done.includes(item) ? "x" : n === ctx.step ? ">" : " ";
      return `  ${n}. [${mark}] ${item}`;
    })
    .join("\n")}`;
}

export function formatTaskReport(ctx) {
  const src = normalizeTaskContext(ctx);
  if (!isActiveTask(src)) {
    return "Задача: (нет активной задачи)";
  }
  return [
    `Задача: «${src.task}»`,
    `Этап: ${labelState(src.state)}  шаг ${src.step}/${src.total}`,
    `Ожидаемое действие: ${expectedAction(src.state)}`,
    `Сейчас: ${src.current || "—"}`,
    `План:${formatPlanList(src)}`,
    `Сделано: ${src.done.length ? src.done.join("; ") : "—"}`,
  ].join("\n");
}
