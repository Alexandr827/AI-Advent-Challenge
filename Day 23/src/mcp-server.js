import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  saveFeatureFile,
  searchFeature,
  summarizeFeature,
} from "./mcp-pipeline.js";
import { runReminderAction, defaultRemindersPath } from "./reminders.js";

const execFileAsync = promisify(execFile);

export const CITY_TIMEZONES = {
  moscow: { name: "Москва", timeZone: "Europe/Moscow" },
  beijing: { name: "Пекин", timeZone: "Asia/Shanghai" },
};

export function deviceTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function formatTimeInZone(date, timeZone) {
  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "longOffset",
  }).format(date);
  return `${formatted} (${timeZone})`;
}

export function formatDeviceTime(date = new Date()) {
  return formatTimeInZone(date, deviceTimeZone());
}

export function formatCityTimes(date = new Date()) {
  return Object.values(CITY_TIMEZONES)
    .map(
      ({ name, timeZone }) =>
        `${name}: ${formatTimeInZone(date, timeZone)}`,
    )
    .join("\n");
}

export async function gitStatus(repo = process.cwd()) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "-b"],
      {
        cwd: repo,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      },
    );
    return { ok: true, text: stdout.replace(/\s+$/u, "") };
  } catch (error) {
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    return {
      ok: false,
      text: stderr || error.message || "git status failed",
    };
  }
}

export function createMcpServer() {
  const server = new McpServer({
    name: "demo-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "add",
    {
      description: "Складывает два числа",
      inputSchema: z.object({
        a: z.number().describe("Первое слагаемое"),
        b: z.number().describe("Второе слагаемое"),
      }),
    },
    async ({ a, b }) => ({
      content: [{ type: "text", text: String(a + b) }],
    }),
  );

  server.registerTool(
    "echo",
    {
      description: "Возвращает переданную строку",
      inputSchema: z.object({
        message: z.string().describe("Текст для ответа"),
      }),
    },
    async ({ message }) => ({
      content: [{ type: "text", text: message }],
    }),
  );

  server.registerTool(
    "device_time",
    {
      description: "Текущие дата, время и часовой пояс устройства, где запущен MCP-сервер",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [{ type: "text", text: formatDeviceTime() }],
    }),
  );

  server.registerTool(
    "city_time",
    {
      description: "Текущие время и часовой пояс Москвы и Пекина",
      inputSchema: z.object({}),
    },
    async () => ({
      content: [{ type: "text", text: formatCityTimes() }],
    }),
  );

  server.registerTool(
    "git_status",
    {
      description:
        "Статус локального git-репозитория: текущая ветка и список изменений (git status --porcelain -b)",
      inputSchema: z.object({
        repo: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Путь к корню git-репозитория. Если не указан — каталог, в котором запущен MCP-сервер",
          ),
      }),
    },
    async ({ repo }) => {
      const result = await gitStatus(repo);
      return {
        content: [{ type: "text", text: result.text }],
        ...(result.ok ? {} : { isError: true }),
      };
    },
  );

  server.registerTool(
    "reminder",
    {
      description:
        "Напоминания: create (расписание), stop, summary (сводка за сутки), tick (срабатывания по расписанию)",
      inputSchema: z.object({
        action: z
          .enum(["create", "stop", "summary", "tick"])
          .describe("create | stop | summary | tick"),
        message: z
          .string()
          .optional()
          .describe("Текст напоминания (для create)"),
        everySeconds: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Период в секундах (для периодического create, вместе с until). 60 — сообщение каждые 60 с"),
        until: z
          .string()
          .optional()
          .describe("ISO-время предела работы (для периодического create)"),
        at: z
          .string()
          .optional()
          .describe("ISO-время одноразового срабатывания (если нет everySeconds)"),
        id: z.string().optional().describe("id напоминания (для stop)"),
        day: z
          .string()
          .optional()
          .describe("Календарный день YYYY-MM-DD для summary; по умолчанию — текущие сутки"),
      }),
    },
    async (args) => {
      const result = runReminderAction(args, {
        filePath: defaultRemindersPath(process.cwd()),
        timeZone: deviceTimeZone(),
      });
      return {
        content: [{ type: "text", text: result.text }],
        ...(result.ok ? {} : { isError: true }),
      };
    },
  );

  const asTool = (result) => ({
    content: [{ type: "text", text: result.text }],
    ...(result.ok ? {} : { isError: true }),
  });

  server.registerTool(
    "search_feature",
    {
      description:
        "Ищет функциональность по коду проекта (src, scripts, test) и возвращает JSON с попаданиями",
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe("Что искать в коде: подстрока или имя с пробелами"),
      }),
    },
    async ({ query }) => asTool(searchFeature(query, { root: process.cwd() })),
  );

  server.registerTool(
    "summarize_feature",
    {
      description:
        "Краткая сводка по JSON поиска и абзацам README.md, где встречается тот же запрос",
      inputSchema: z.object({
        search: z
          .string()
          .optional()
          .describe("JSON-текст search_feature (поле hits), обычно весь вывод предыдущего шага"),
      }),
    },
    async ({ search }) => asTool(summarizeFeature(search, { root: process.cwd() })),
  );

  server.registerTool(
    "saveToFile",
    {
      description:
        "Пишет markdown в файл НАЗВАНИЕ_ФИЧИ.md в корне проекта. Если перед этим был summarize_feature, в файл добавляется описание и блок результатов. Путь в имени запрещён",
      inputSchema: z.object({
        feature: z
          .string()
          .optional()
          .describe("Имя фичи: пробелы станут _, получится НАЗВАНИЕ_ФИЧИ.md"),
        content: z
          .string()
          .optional()
          .describe("Текст файла, обычно вывод summarize_feature"),
        summarized: z
          .boolean()
          .optional()
          .describe("true, если content — вывод summarize_feature: в файл добавятся описание и результаты"),
      }),
    },
    async ({ feature, content, summarized }) =>
      asTool(saveFeatureFile({ feature, content, summarized }, { root: process.cwd() })),
  );

  return server;
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  console.error("demo-mcp listening on stdio");
}
