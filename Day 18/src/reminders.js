import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const EMPTY = { nextId: 1, reminders: [] };

export function defaultRemindersPath(cwd = process.cwd()) {
  return resolve(cwd, "data", "reminders.json");
}

export function loadReminders(filePath) {
  try {
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    const reminders = Array.isArray(data?.reminders) ? data.reminders.map(normalizeReminder) : [];
    let nextId =
      Number.isInteger(data?.nextId) && data.nextId >= 1 ? data.nextId : 1;
    for (const row of reminders) {
      const n = Number(String(row.id).replace(/^rem-/u, ""));
      if (Number.isInteger(n) && n >= nextId) nextId = n + 1;
    }
    return { nextId, reminders };
  } catch (err) {
    if (err?.code === "ENOENT") return { ...EMPTY, reminders: [] };
    throw new Error(`Не удалось прочитать напоминания ${filePath}: ${err.message}`);
  }
}

export function saveReminders(filePath, state) {
  mkdirSync(dirname(filePath), { recursive: true });
  const payload = {
    nextId: state.nextId,
    reminders: state.reminders,
  };
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tmp, filePath);
}

function normalizeReminder(row) {
  if (!row || typeof row !== "object") return null;
  const id = String(row.id ?? "");
  if (!id) return null;
  return {
    id,
    message: String(row.message ?? ""),
    everyMs: row.everyMs == null ? null : Number(row.everyMs),
    at: row.at == null ? null : String(row.at),
    until: row.until == null ? null : String(row.until),
    status: String(row.status ?? "active"),
    createdAt: String(row.createdAt ?? ""),
    nextRunAt: row.nextRunAt == null ? null : String(row.nextRunAt),
    fires: Array.isArray(row.fires)
      ? row.fires.map((f) => ({ at: String(f?.at ?? "") })).filter((f) => f.at)
      : [],
  };
}

function parseInstant(value, fieldName) {
  if (value == null || value === "") return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Некорректное время в поле ${fieldName}`);
  }
  return d;
}

export function calendarDayKey(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatTimeHm(date, timeZone) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatDateTimeShort(iso, timeZone) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return date.replace(",", "");
}

function fireOnCalendarDay(fireAtIso, day, timeZone) {
  const d = new Date(fireAtIso);
  if (Number.isNaN(d.getTime())) return false;
  return calendarDayKey(d, timeZone) === day;
}

export function createReminder(state, input, now = new Date()) {
  const message = String(input.message ?? "").trim();
  if (!message) throw new Error("Нужен непустой message");

  const everySeconds = input.everySeconds;
  const atRaw = input.at;
  const untilRaw = input.until;

  const hasEvery =
    everySeconds != null && everySeconds !== "" && Number.isFinite(Number(everySeconds));
  const hasAt = atRaw != null && atRaw !== "";
  const hasUntil = untilRaw != null && untilRaw !== "";

  let everyMs = null;
  let at = null;
  let until = null;
  let nextRunAt;

  if (hasEvery) {
    if (!hasUntil) throw new Error("Периодическое напоминание требует until");
    if (hasAt) throw new Error("Укажите everySeconds или at, не оба");
    const seconds = Number(everySeconds);
    if (!Number.isInteger(seconds) || seconds < 1) {
      throw new Error("everySeconds должен быть целым числом секунд >= 1");
    }
    everyMs = seconds * 1000;
    until = parseInstant(untilRaw, "until");
    if (until.getTime() <= now.getTime()) {
      throw new Error("until должен быть в будущем");
    }
    const firstAt = now.getTime() + everyMs;
    if (firstAt >= until.getTime()) {
      throw new Error("until должен быть позже первого срабатывания");
    }
    nextRunAt = new Date(firstAt).toISOString();
  } else if (hasAt) {
    at = parseInstant(atRaw, "at");
    nextRunAt = at.toISOString();
  } else {
    throw new Error("Укажите everySeconds (с until) или at для одноразового напоминания");
  }

  const id = `rem-${state.nextId}`;
  const reminder = {
    id,
    message,
    everyMs,
    at: at ? at.toISOString() : null,
    until: until ? until.toISOString() : null,
    status: "active",
    createdAt: now.toISOString(),
    nextRunAt,
    fires: [],
  };

  return {
    nextId: state.nextId + 1,
    reminders: [...state.reminders, reminder],
    created: reminder,
  };
}

export function stopReminder(state, id) {
  const needle = String(id ?? "").trim();
  if (!needle) throw new Error("Для stop нужен id");
  let found = false;
  const reminders = state.reminders.map((row) => {
    if (row.id !== needle) return row;
    found = true;
    if (row.status === "active") {
      return { ...row, status: "stopped" };
    }
    return row;
  });
  if (!found) throw new Error(`Напоминание ${needle} не найдено`);
  return { ...state, reminders };
}

export function tickReminders(state, now = new Date()) {
  const fired = [];
  const nowMs = now.getTime();

  const reminders = state.reminders.map((row) => {
    if (row.status !== "active") return row;

    const untilMs = row.until ? new Date(row.until).getTime() : null;
    if (untilMs != null && !Number.isNaN(untilMs) && nowMs >= untilMs) {
      return { ...row, status: "expired", nextRunAt: null };
    }

    const nextMs = row.nextRunAt ? new Date(row.nextRunAt).getTime() : NaN;
    if (Number.isNaN(nextMs) || nextMs > nowMs) return row;

    const fireAt = now.toISOString();
    const fires = [...row.fires, { at: fireAt }];
    fired.push({ id: row.id, message: row.message, at: fireAt });

    if (row.everyMs != null) {
      const next = nowMs + row.everyMs;
      let nextRunAt = new Date(next).toISOString();
      if (untilMs != null && !Number.isNaN(untilMs) && next >= untilMs) {
        nextRunAt = null;
      }
      return { ...row, fires, nextRunAt };
    }

    return { ...row, fires, status: "done", nextRunAt: null };
  });

  return { ...state, reminders, fired };
}

export function buildSummary(state, options = {}) {
  const timeZone =
    options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day = options.day?.trim() || calendarDayKey(options.now ?? new Date(), timeZone);

  let totalFires = 0;
  const lines = [];

  for (const row of state.reminders) {
    const dayFires = row.fires.filter((f) => fireOnCalendarDay(f.at, day, timeZone));
    if (dayFires.length === 0) continue;

    totalFires += dayFires.length;
    const last = dayFires[dayFires.length - 1];
    const period =
      row.everyMs != null ? `период ${Math.round(row.everyMs / 1000)} с` : "одноразовое";
    const untilPart = row.until
      ? `, предел ${formatDateTimeShort(row.until, timeZone)}`
      : "";
    const lastPart = `, последнее ${formatTimeHm(new Date(last.at), timeZone)}`;
    lines.push(
      `${row.id}: ${dayFires.length} раз, статус ${row.status}, ${period}${untilPart}${lastPart}`,
    );
    lines.push(`Текст: ${row.message}`);
  }

  const stopped = state.reminders.filter((r) => r.status === "stopped").length;
  const expired = state.reminders.filter((r) => r.status === "expired").length;

  const parts = [
    `Сутки: ${day} (${timeZone})`,
    `Срабатываний: ${totalFires}`,
    ...lines,
    `Остановлено командой: ${stopped}`,
    `Истекло по пределу: ${expired}`,
  ];

  return parts.join("\n");
}

export function nextReminderDelayMs(state, now = new Date()) {
  const nowMs = now.getTime();
  let soonest = null;
  for (const row of state.reminders) {
    if (row.status !== "active" || row.nextRunAt == null) continue;
    const at = new Date(row.nextRunAt).getTime();
    if (Number.isNaN(at)) continue;
    if (soonest == null || at < soonest) soonest = at;
  }
  if (soonest == null) return null;
  return Math.max(0, soonest - nowMs);
}

export function runReminderAction(input, options = {}) {
  const filePath = options.filePath ?? defaultRemindersPath(options.cwd);
  const timeZone =
    options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = options.now ?? new Date();
  const action = String(input.action ?? "").trim();

  let state = loadReminders(filePath);

  switch (action) {
    case "create": {
      const created = createReminder(state, input, now);
      state = { nextId: created.nextId, reminders: created.reminders };
      saveReminders(filePath, state);
      return {
        ok: true,
        text: JSON.stringify(
          {
            id: created.created.id,
            nextRunAt: created.created.nextRunAt,
            status: created.created.status,
          },
          null,
          2,
        ),
      };
    }
    case "stop": {
      state = stopReminder(state, input.id);
      saveReminders(filePath, state);
      return { ok: true, text: JSON.stringify({ id: input.id, status: "stopped" }, null, 2) };
    }
    case "summary": {
      const text = buildSummary(state, {
        day: input.day,
        timeZone,
        now,
      });
      return { ok: true, text };
    }
    case "tick": {
      const result = tickReminders(state, now);
      state = { nextId: result.nextId, reminders: result.reminders };
      saveReminders(filePath, state);
      return {
        ok: true,
        text: JSON.stringify(
          {
            fired: result.fired,
            at: now.toISOString(),
          },
          null,
          2,
        ),
      };
    }
    default:
      return {
        ok: false,
        text: 'action должен быть create, stop, summary или tick',
      };
  }
}
