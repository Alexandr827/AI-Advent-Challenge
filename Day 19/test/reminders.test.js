import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { helpText, parseCommand } from "../src/cli.js";
import {
  buildSummary,
  createReminder,
  loadReminders,
  nextReminderDelayMs,
  runReminderAction,
  saveReminders,
  stopReminder,
  tickReminders,
} from "../src/reminders.js";

const MSG =
  "Если ты хочешь изменить жизнь и, быть может, мир — сначала доделай задачу!";

describe("reminders", () => {
  it("create periodic writes rem-1 with message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rem-"));
    const file = join(dir, "reminders.json");
    const now = new Date("2026-09-25T12:00:00.000+04:00");
    const until = "2026-09-25T15:00:00.000+04:00";

    const result = runReminderAction(
      {
        action: "create",
        message: MSG,
        everySeconds: 60,
        until,
      },
      { filePath: file, now },
    );
    assert.equal(result.ok, true);
    const body = JSON.parse(result.text);
    assert.equal(body.id, "rem-1");
    const firstAt = new Date(now.getTime() + 60_000).toISOString();
    assert.equal(body.nextRunAt, firstAt);

    const state = loadReminders(file);
    assert.equal(state.reminders.length, 1);
    assert.equal(state.reminders[0].message, MSG);
    assert.equal(state.reminders[0].everyMs, 60_000);
    assert.equal(nextReminderDelayMs(state, now), 60_000);
    await rm(dir, { recursive: true, force: true });
  });

  it("tick before nextRunAt does not add fires", async () => {
    const now = new Date("2026-09-25T12:00:00.000+04:00");
    let state = { nextId: 1, reminders: [] };
    const created = createReminder(
      state,
      { message: MSG, everySeconds: 60, until: "2026-09-25T18:00:00.000+04:00" },
      now,
    );
    state = { nextId: created.nextId, reminders: created.reminders };

    const early = new Date(now.getTime() + 30_000);
    const ticked = tickReminders(state, early);
    assert.equal(ticked.fired.length, 0);
    assert.equal(ticked.reminders[0].fires.length, 0);
  });

  it("tick on schedule adds one fire and shifts nextRunAt", async () => {
    const now = new Date("2026-09-25T12:00:00.000+04:00");
    let state = { nextId: 1, reminders: [] };
    const created = createReminder(
      state,
      { message: MSG, everySeconds: 60, until: "2026-09-25T18:00:00.000+04:00" },
      now,
    );
    state = { nextId: created.nextId, reminders: created.reminders };

    const due = new Date(now.getTime() + 60_000);
    const ticked = tickReminders(state, due);
    assert.equal(ticked.fired.length, 1);
    assert.equal(ticked.fired[0].message, MSG);
    assert.equal(ticked.reminders[0].fires.length, 1);
    const next = new Date(now.getTime() + 120_000).toISOString();
    assert.equal(ticked.reminders[0].nextRunAt, next);
  });

  it("tick when now >= until sets expired without new fire", async () => {
    const start = new Date("2026-09-25T12:00:00.000+04:00");
    let state = { nextId: 1, reminders: [] };
    const created = createReminder(
      state,
      { message: MSG, everySeconds: 60, until: "2026-09-25T13:00:00.000+04:00" },
      start,
    );
    state = { nextId: created.nextId, reminders: created.reminders };
    state = tickReminders(state, new Date(start.getTime() + 60_000));

    const afterUntil = new Date("2026-09-25T13:00:00.000+04:00");
    const ticked = tickReminders(state, afterUntil);
    assert.equal(ticked.fired.length, 0);
    assert.equal(ticked.reminders[0].status, "expired");
    assert.equal(ticked.reminders[0].fires.length, 1);
  });

  it("stop sets stopped and tick stays silent", async () => {
    const now = new Date("2026-09-25T12:00:00.000+04:00");
    let state = { nextId: 1, reminders: [] };
    const created = createReminder(
      state,
      { message: MSG, everySeconds: 60, until: "2026-09-25T18:00:00.000+04:00" },
      now,
    );
    state = { nextId: created.nextId, reminders: created.reminders };
    state = stopReminder(state, "rem-1");
    assert.equal(state.reminders[0].status, "stopped");

    const ticked = tickReminders(state, new Date(now.getTime() + 60_000));
    assert.equal(ticked.fired.length, 0);
  });

  it("one-shot at fires once then done", async () => {
    const at = new Date("2026-09-25T14:00:00.000+04:00");
    let state = { nextId: 1, reminders: [] };
    const created = createReminder(state, { message: MSG, at: at.toISOString() }, at);
    state = { nextId: created.nextId, reminders: created.reminders };

    const before = tickReminders(state, new Date("2026-09-25T13:00:00.000+04:00"));
    assert.equal(before.fired.length, 0);

    const ticked = tickReminders(before, at);
    assert.equal(ticked.fired.length, 1);
    assert.equal(ticked.reminders[0].status, "done");
    assert.equal(ticked.reminders[0].fires.length, 1);

    const again = tickReminders(ticked, new Date("2026-09-25T15:00:00.000+04:00"));
    assert.equal(again.fired.length, 0);
  });

  it("summary counts only fires on the chosen calendar day", async () => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const day = "2026-09-25";
    const state = {
      nextId: 2,
      reminders: [
        {
          id: "rem-1",
          message: MSG,
          everyMs: 3_600_000,
          at: null,
          until: "2026-09-26T00:00:00.000+04:00",
          status: "active",
          createdAt: "2026-09-25T12:00:00.000+04:00",
          nextRunAt: null,
          fires: [
            { at: "2026-09-25T12:00:00.000+04:00" },
            { at: "2026-09-25T13:00:00.000+04:00" },
            { at: "2026-09-24T23:00:00.000+04:00" },
          ],
        },
      ],
    };
    const text = buildSummary(state, { day, timeZone: tz });
    assert.match(text, /Срабатываний: 2/);
    assert.match(text, /rem-1: 2 раз/);
    assert.match(text, /Текст: Если ты хочешь изменить жизнь/);
  });

  it("saveReminders uses atomic rename", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rem-"));
    const file = join(dir, "reminders.json");
    saveReminders(file, { nextId: 1, reminders: [] });
    const loaded = loadReminders(file);
    assert.deepEqual(loaded.reminders, []);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("reminder cli", () => {
  it("parses periodic create into MCP arguments", () => {
    const cmd = parseCommand(
      `reminder create --message "${MSG}" --every 60 --until 2026-09-26T00:00:00+04:00`,
    );
    assert.equal(cmd.type, "reminder");
    assert.equal(cmd.action, "create");
    assert.equal(cmd.arguments.message, MSG);
    assert.equal(cmd.arguments.everySeconds, 60);
    assert.equal(typeof cmd.arguments.everySeconds, "number");
    assert.equal(cmd.arguments.until, "2026-09-26T00:00:00+04:00");
    assert.deepEqual(cmd.arguments, {
      action: "create",
      message: MSG,
      everySeconds: 60,
      until: "2026-09-26T00:00:00+04:00",
    });
  });

  it("rejects create without until and without at", () => {
    assert.throws(
      () => parseCommand(`reminder create --message "${MSG}"`),
      /Использование/,
    );
    assert.throws(
      () => parseCommand(`reminder create --message "${MSG}" --every 60 --at 2026-09-25T21:30:00+04:00`),
      /не оба/,
    );
  });

  it("parses stop id", () => {
    assert.deepEqual(parseCommand("reminder stop rem-1"), {
      type: "reminder",
      action: "stop",
      arguments: { action: "stop", id: "rem-1" },
    });
  });

  it("parses summary day", () => {
    const cmd = parseCommand("reminder summary --day 2026-09-25");
    assert.equal(cmd.action, "summary");
    assert.deepEqual(cmd.arguments, {
      action: "summary",
      day: "2026-09-25",
    });
  });

  it("help explains how to launch the reminder MCP tool", () => {
    const help = helpText();
    assert.match(help, /reminder create --message/);
    assert.match(help, /--every N --until ISO/);
    assert.match(help, /reminder stop <id>/);
    assert.match(help, /reminder summary \[--day YYYY-MM-DD\]/);
    assert.match(help, /reminder tick/);
    assert.match(help, /callTool/);
    assert.match(help, /каждые 60 с/);
  });
});
