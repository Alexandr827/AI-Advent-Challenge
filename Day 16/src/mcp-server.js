import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

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
