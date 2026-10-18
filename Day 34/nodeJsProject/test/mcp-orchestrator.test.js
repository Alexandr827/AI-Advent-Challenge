import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { LlmAgent } from "../src/agent.js";
import { helpText } from "../src/cli.js";
import { connectNamedMcp, listMcpCatalog, projectMcpServers } from "../src/mcp-client.js";
import { saveBrief } from "../src/mcp-brief.js";
import { cityClock } from "../src/mcp-clock.js";
import { planOrchestration, runOrchestration } from "../src/mcp-orchestrator.js";
import { toolText } from "../src/mcp-pipeline.js";
import { formatToolTrace } from "../src/mcp-trace.js";
import { forecastAt, geocodeCity } from "../src/mcp-weather.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const FULL =
  "Какая погода завтра в Ереване, который час в этом городе и сохрани сводку в файл";

function textResult(text, isError = false) {
  return {
    isError,
    content: [{ type: "text", text }],
  };
}

describe("orchestration plan", () => {
  it("orders tools from three servers and skips demo-mcp", () => {
    const plan = planOrchestration(FULL);
    assert.equal(plan.error, undefined);
    assert.deepEqual(
      plan.steps.map((step) => [step.server, step.name]),
      [
        ["weather-mcp", "geocode"],
        ["weather-mcp", "forecast"],
        ["clock-mcp", "city_clock"],
        ["brief-mcp", "save_brief"],
      ],
    );
    assert.deepEqual(plan.steps[0].arguments, { query: "Yerevan" });
    const banned = ["add", "echo", "git_status", "city_time", "search_feature", "saveToFile"];
    assert.equal(
      plan.steps.some((step) => step.server === "demo-mcp" || banned.includes(step.name)),
      false,
    );
  });

  it("keeps only the clock when the ask is about time", () => {
    const plan = planOrchestration("который час в Москве");
    assert.deepEqual(
      plan.steps.map((step) => [step.server, step.name]),
      [["clock-mcp", "city_clock"]],
    );
    assert.deepEqual(plan.steps[0].arguments, { city: "Москва" });
  });

  it("keeps geocode and forecast when the ask is only about weather", () => {
    const plan = planOrchestration("прогноз погоды в Пекине");
    assert.deepEqual(
      plan.steps.map((step) => step.name),
      ["geocode", "forecast"],
    );
    assert.equal(plan.steps[0].arguments.query, "Beijing");
  });

  it("leaves feature search to the day 19 pipeline", () => {
    assert.equal(
      planOrchestration("найти фичу стратегия, кратко резюмируй и сохрани в файл"),
      null,
    );
  });

  it("plans a dated Moscow forecast and a file without calling the clock", () => {
    const plan = planOrchestration(
      "Запиши мне результаты по прогнозу погоды в Москве 25 сентября 2026 года в 18 часов 26 минут по часовому поясу самой Москвы. Резульаты прогноза сохрани в отдельный файл внутри проекта",
    );
    assert.deepEqual(
      plan.steps.map((step) => [step.server, step.name]),
      [
        ["weather-mcp", "geocode"],
        ["weather-mcp", "forecast"],
        ["brief-mcp", "save_brief"],
      ],
    );
    assert.deepEqual(plan.steps[0].arguments, { query: "Moscow" });
    assert.deepEqual(plan.steps[1].arguments, {
      date: "2026-09-25",
      hour: 18,
      minute: 26,
    });
    assert.equal(plan.when.date, "2026-09-25");
  });

  it("asks for a city and refuses an unknown clock city", () => {
    assert.match(planOrchestration("какая погода завтра").error, /город/);
    assert.match(planOrchestration("который час в Тбилиси").error, /Ереван/);
    const tbilisi = planOrchestration('погода в «Тбилиси»');
    assert.equal(tbilisi.steps[0].arguments.query, "Тбилиси");
    assert.equal(tbilisi.steps.length, 2);
  });
});

describe("orchestration run", () => {
  it("feeds forecast and the clock from the geocode JSON, then saves both texts", async () => {
    const plan = planOrchestration(FULL);
    const calls = [];
    const run = await runOrchestration(plan, async (req) => {
      calls.push(req);
      if (req.name === "geocode") {
        return textResult(
          JSON.stringify({
            name: "Ереван",
            latitude: 40.18,
            longitude: 44.51,
            timezone: "Asia/Yerevan",
          }),
        );
      }
      if (req.name === "forecast") {
        return textResult("Завтра 2026-09-28: 12…24 °C, ясно (Asia/Yerevan)");
      }
      if (req.name === "city_clock") {
        return textResult("Ереван: 2026-09-27 17:00:00 GMT+4 (Asia/Yerevan)");
      }
      return textResult("Сохранено: /tmp/погода_Ереван.md");
    });
    assert.equal(run.ok, true);
    assert.deepEqual(
      calls.map((call) => [call.server, call.name]),
      [
        ["weather-mcp", "geocode"],
        ["weather-mcp", "forecast"],
        ["clock-mcp", "city_clock"],
        ["brief-mcp", "save_brief"],
      ],
    );
    assert.deepEqual(calls[1].arguments, {
      latitude: 40.18,
      longitude: 44.51,
      timezone: "Asia/Yerevan",
    });
    assert.equal(calls[2].arguments.timeZone, "Asia/Yerevan");
    assert.equal(calls[2].arguments.city, "Ереван");
    assert.equal(calls[3].arguments.title, "погода Ереван");
    assert.match(calls[3].arguments.content, /Завтра 2026-09-28/);
    assert.match(calls[3].arguments.content, /Ереван: 2026-09-27/);
    assert.match(
      formatToolTrace({
        server: "weather-mcp",
        tool: "geocode",
        status: "completed",
        resultText: "ok",
      }),
      /MCP weather-mcp geocode completed → ok/,
    );
  });

  it("passes the requested Moscow hour into forecast and the brief title", async () => {
    const plan = planOrchestration(
      "прогноз погоды в Москве 25 сентября 2026 года в 18 часов 26 минут и сохрани в файл",
    );
    const calls = [];
    const run = await runOrchestration(plan, async (req) => {
      calls.push(req);
      if (req.name === "geocode") {
        return textResult(
          JSON.stringify({
            name: "Москва",
            latitude: 55.75,
            longitude: 37.62,
            timezone: "Europe/Moscow",
          }),
        );
      }
      if (req.name === "forecast") {
        return textResult("2026-09-25 18:26 (Europe/Moscow): 16.4 °C, облачно (час 2026-09-25T18:00)");
      }
      return textResult("Сохранено: /tmp/погода_Москва_2026-09-25.md");
    });
    assert.equal(run.ok, true);
    assert.deepEqual(calls[1].arguments, {
      latitude: 55.75,
      longitude: 37.62,
      timezone: "Europe/Moscow",
      date: "2026-09-25",
      hour: 18,
      minute: 26,
    });
    assert.equal(calls[2].arguments.title, "погода Москва 2026-09-25");
    assert.match(calls[2].arguments.content, /18:26/);
  });

  it("stops the flow when a step returns isError", async () => {
    const plan = planOrchestration(FULL);
    let calls = 0;
    const run = await runOrchestration(plan, async () => {
      calls += 1;
      return textResult("geocode: HTTP 500", true);
    });
    assert.equal(calls, 1);
    assert.equal(run.ok, false);
    assert.equal(run.steps.length, 1);
    assert.equal(run.steps[0].name, "geocode");
    assert.equal(run.steps[0].isError, true);
  });

  it("does not call forecast when geocode text is not coordinates", async () => {
    const plan = planOrchestration("погода в Ереване");
    let calls = 0;
    const run = await runOrchestration(plan, async () => {
      calls += 1;
      return textResult("не json");
    });
    assert.equal(calls, 1);
    assert.equal(run.ok, false);
    assert.equal(run.steps.at(-1).isError, true);
    assert.match(run.steps.at(-1).text, /latitude/);
  });
});

describe("weather, clock and brief tools", () => {
  it("reads Open-Meteo through an injected fetch", async () => {
    const fetchImpl = async (url) => {
      const href = String(url);
      if (href.includes("geocoding-api")) {
        return {
          ok: true,
          json: async () => ({
            results: [
              {
                name: "Ереван",
                latitude: 40.18,
                longitude: 44.51,
                timezone: "Asia/Yerevan",
                country: "Армения",
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          daily: {
            time: ["2026-09-27", "2026-09-28"],
            temperature_2m_min: [10, 12],
            temperature_2m_max: [22, 24],
            weather_code: [1, 0],
          },
        }),
      };
    };
    const geo = await geocodeCity("Yerevan", { fetchImpl });
    assert.equal(geo.ok, true);
    const place = JSON.parse(geo.text);
    const forecast = await forecastAt(place, { fetchImpl });
    assert.equal(
      forecast.text,
      "Завтра 2026-09-28: 12…24 °C, ясно (Asia/Yerevan)",
    );
    const missing = await geocodeCity("Нигде", {
      fetchImpl: async () => ({ ok: true, json: async () => ({ results: [] }) }),
    });
    assert.equal(missing.ok, false);

    const urls = [];
    const slot = await forecastAt(
      {
        latitude: 55.75,
        longitude: 37.62,
        timezone: "Europe/Moscow",
        date: "2026-09-25",
        hour: 18,
        minute: 26,
      },
      {
        fetchImpl: async (url) => {
          urls.push(String(url));
          if (String(url).includes("archive-api")) {
            throw new Error("archive should not be called");
          }
          return {
            ok: true,
            json: async () => ({
              hourly: {
                time: ["2026-09-25T18:00"],
                temperature_2m: [16.4],
                weather_code: [3],
              },
            }),
          };
        },
      },
    );
    assert.equal(slot.ok, true);
    assert.match(slot.text, /2026-09-25 18:26 \(Europe\/Moscow\): 16\.4 °C, облачно/);
    assert.match(urls[0], /start_date=2026-09-25/);
    assert.match(urls[0], /timezone=Europe%2FMoscow/);

    const archived = await forecastAt(
      {
        latitude: 55.75,
        longitude: 37.62,
        timezone: "Europe/Moscow",
        date: "2026-09-25",
        hour: 18,
        minute: 26,
      },
      {
        fetchImpl: async (url) => {
          if (String(url).includes("archive-api")) {
            return {
              ok: true,
              json: async () => ({
                hourly: {
                  time: ["2026-09-25T18:00"],
                  temperature_2m: [15],
                  weather_code: [0],
                },
              }),
            };
          }
          return { ok: true, json: async () => ({ hourly: { time: [], temperature_2m: [], weather_code: [] } }) };
        },
      },
    );
    assert.match(archived.text, /15 °C, ясно/);
  });

  it("formats Yerevan local time and writes a brief inside the root", async () => {
    const clock = cityClock({
      city: "Ереван",
      date: new Date("2026-09-27T13:00:00Z"),
    });
    assert.equal(clock.ok, true);
    assert.match(clock.text, /^Ереван: 2026-09-27 17:00:00/);
    assert.match(clock.text, /Asia\/Yerevan/);
    assert.equal(cityClock({ city: "Тбилиси" }).ok, false);

    const dir = await mkdtemp(join(tmpdir(), "mcp-brief-"));
    try {
      const saved = saveBrief(
        { title: "погода Ереван", content: "Завтра ясно" },
        { root: dir },
      );
      assert.equal(saved.ok, true);
      const body = readFileSync(saved.path, "utf8");
      assert.match(body, /^# погода Ереван/);
      assert.match(body, /Завтра ясно/);
      const escaped = saveBrief({ title: "../secret", content: "x" }, { root: dir });
      assert.equal(escaped.ok, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("registered MCP servers", () => {
  const clients = [];

  after(async () => {
    for (const client of clients) await client.close();
  });

  it("registers four stdio servers and lists tools on each", async () => {
    const servers = projectMcpServers(repoRoot);
    assert.deepEqual(Object.keys(servers), [
      "demo-mcp",
      "weather-mcp",
      "clock-mcp",
      "brief-mcp",
    ]);
    assert.equal(servers["weather-mcp"].args[0].endsWith("mcp-weather.js"), true);
    assert.equal(servers["clock-mcp"].args[0].endsWith("mcp-clock.js"), true);
    assert.equal(servers["brief-mcp"].args[0].endsWith("mcp-brief.js"), true);

    const catalog = await listMcpCatalog(repoRoot);
    assert.deepEqual(
      catalog.map((server) => server.name),
      ["demo-mcp", "weather-mcp", "clock-mcp", "brief-mcp"],
    );
    const names = (server) =>
      catalog
        .find((item) => item.name === server)
        .tools.map((tool) => tool.name)
        .sort();
    assert.deepEqual(names("weather-mcp"), ["forecast", "geocode"]);
    assert.deepEqual(names("clock-mcp"), ["city_clock"]);
    assert.deepEqual(names("brief-mcp"), ["save_brief"]);
    assert.ok(names("demo-mcp").includes("git_status"));
  });

  it("calls city_clock and save_brief on their own servers", async () => {
    const clock = await connectNamedMcp("clock-mcp", repoRoot);
    clients.push(clock);
    const time = await clock.callTool({
      name: "city_clock",
      arguments: { timeZone: "Asia/Yerevan", city: "Ереван" },
    });
    assert.notEqual(time.isError, true);
    assert.match(toolText(time), /Ереван:/);
    assert.match(toolText(time), /Asia\/Yerevan/);

    const dir = await mkdtemp(join(tmpdir(), "mcp-brief-server-"));
    const brief = await connectNamedMcp("brief-mcp", dir);
    clients.push(brief);
    try {
      const saved = await brief.callTool({
        name: "save_brief",
        arguments: { title: "время Ереван", content: "17:00" },
      });
      assert.notEqual(saved.isError, true);
      assert.match(readFileSync(join(dir, "время_Ереван.md"), "utf8"), /17:00/);
      const bad = await brief.callTool({
        name: "save_brief",
        arguments: { title: "a/b", content: "x" },
      });
      assert.equal(bad.isError, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ask --mcp runs the clock and the brief and leaves the feature pipeline alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-orch-ask-"));
    const agent = new LlmAgent({
      id: "orch",
      name: "orchestrator",
      model: "composer-2.5",
      runtime: "local",
      apiKey: "test-key",
      cwd: dir,
      compress: false,
    });
    try {
      await assert.rejects(
        () => agent.ask("какая погода завтра", { mcp: true }),
        /город/,
      );
      const { reply, tools } = await agent.ask(
        "который час в Ереване и сохрани сводку в файл",
        { mcp: true },
      );
      assert.deepEqual(
        tools.calls.map((call) => [call.server, call.tool]),
        [
          ["clock-mcp", "city_clock"],
          ["brief-mcp", "save_brief"],
        ],
      );
      assert.equal(tools.calls[1].arguments.content, tools.calls[0].resultText);
      assert.match(reply, /сервер clock-mcp/);
      assert.match(reply, /сервер brief-mcp/);
      assert.match(reply, /Сохранено:/);
      assert.match(readFileSync(join(dir, "время_Ереван.md"), "utf8"), /Asia\/Yerevan/);
      assert.match(helpText(), /weather-mcp geocode/);
      const withoutFlag = await agent.ask("который час в Москве и сохрани сводку в файл");
      assert.deepEqual(
        withoutFlag.tools.calls.map((call) => [call.server, call.tool]),
        [
          ["clock-mcp", "city_clock"],
          ["brief-mcp", "save_brief"],
        ],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
