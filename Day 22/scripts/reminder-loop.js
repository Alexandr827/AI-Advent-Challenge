import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/env.js";
import { AgentPool } from "../src/pool.js";
import {
  calendarDayKey,
  defaultRemindersPath,
  loadReminders,
  nextReminderDelayMs,
  saveReminders,
  tickReminders,
} from "../src/reminders.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(resolve(projectRoot, ".env"));

const API_KEY = process.env.CURSOR_API_KEY?.trim();
const MODEL = process.env.CURSOR_MODEL ?? "composer-2.5";
const RUNTIME = (process.env.CURSOR_RUNTIME ?? "local").toLowerCase();
const IDLE_MS = 1000;
const AGENT = "mcp-reminder";
const LOOP_STATE = resolve(projectRoot, "data", "reminder-loop.json");
const REMINDERS_PATH = defaultRemindersPath(projectRoot);

if (!API_KEY || API_KEY === "cursor_your-key-here") {
  console.error("Задайте CURSOR_API_KEY в .env");
  process.exit(1);
}
if (RUNTIME !== "local") {
  console.error("MCP stdio доступен только при CURSOR_RUNTIME=local");
  process.exit(1);
}

function loadLoopState() {
  try {
    return JSON.parse(readFileSync(LOOP_STATE, "utf8"));
  } catch {
    return { lastSummaryDay: null };
  }
}

function saveLoopState(data) {
  mkdirSync(dirname(LOOP_STATE), { recursive: true });
  writeFileSync(LOOP_STATE, `${JSON.stringify(data, null, 2)}\n`);
}

const pool = new AgentPool({
  apiKey: API_KEY,
  defaultModel: MODEL,
  defaultRuntime: RUNTIME,
  cwd: projectRoot,
  storePath: resolve(projectRoot, "data", "reminder-loop-agents.json"),
});

let agent;
if (pool.get(AGENT)) {
  agent = pool.get(AGENT);
} else {
  [agent] = pool.spawn({
    name: AGENT,
    model: MODEL,
    runtime: "local",
    systemPrompt:
      "Отвечай по-русски. Для напоминаний используй только MCP-инструмент reminder сервера demo-mcp, когда это явно указано в запросе.",
  });
}

function timeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

async function askAgent(prompt) {
  console.log(`> ask ${AGENT} ${prompt.slice(0, 80)}…`);
  const { reply } = await agent.ask(prompt);
  const text = String(reply ?? "").trim();
  if (text) console.log(text);
  return text;
}

async function onTick() {
  const now = new Date();
  const tz = timeZone();
  const today = calendarDayKey(now, tz);
  const loopState = loadLoopState();

  if (loopState.lastSummaryDay && loopState.lastSummaryDay !== today) {
    const yesterday = loopState.lastSummaryDay;
    await askAgent(
      `Вызови MCP-инструмент reminder с action summary и day ${yesterday} (сервер demo-mcp). ` +
        "Коротко перескажи сводку пользователю по-русски.",
    );
  }
  if (loopState.lastSummaryDay !== today) {
    saveLoopState({ lastSummaryDay: today });
  }

  let state = loadReminders(REMINDERS_PATH);
  const before = JSON.stringify(state.reminders.map((r) => r.fires.length));
  const result = tickReminders(state, now);
  state = { nextId: result.nextId, reminders: result.reminders };
  const after = JSON.stringify(state.reminders.map((r) => r.fires.length));
  if (before !== after) {
    saveReminders(REMINDERS_PATH, state);
  }

  for (const fire of result.fired) {
    await askAgent(
      `Произнеси дословно следующий текст и больше ничего не добавляй:\n\n${fire.message}`,
    );
  }
}

console.error(`reminder-loop: срабатывание по nextRunAt (--every в секундах), reminders → ${REMINDERS_PATH}`);

const shutdown = async () => {
  console.error("reminder-loop: остановка");
  if (agent) await agent.dispose();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function scheduleLoop() {
  const delay = nextReminderDelayMs(loadReminders(REMINDERS_PATH)) ?? IDLE_MS;
  setTimeout(() => {
    onTick()
      .catch((err) => {
        console.error("reminder-loop tick error:", err);
      })
      .finally(scheduleLoop);
  }, delay);
}

await onTick();
scheduleLoop();
