import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatTimeInZone } from "./mcp-server.js";
import { isMainModule, serveStdio } from "./mcp-serve.js";

export const CLOCK_CITIES = {
  ереван: { name: "Ереван", timeZone: "Asia/Yerevan" },
  yerevan: { name: "Ереван", timeZone: "Asia/Yerevan" },
  москва: { name: "Москва", timeZone: "Europe/Moscow" },
  moscow: { name: "Москва", timeZone: "Europe/Moscow" },
  пекин: { name: "Пекин", timeZone: "Asia/Shanghai" },
  beijing: { name: "Пекин", timeZone: "Asia/Shanghai" },
};

export function lookupClockCity(value) {
  const key = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!key) return null;
  if (CLOCK_CITIES[key]) return CLOCK_CITIES[key];
  const stem = Object.keys(CLOCK_CITIES).find((name) => key.startsWith(name));
  return stem ? CLOCK_CITIES[stem] : null;
}

export function cityClock({ city, timeZone, date = new Date() } = {}) {
  let zone = String(timeZone ?? "").trim();
  let label = zone;
  if (!zone && city) {
    const known = lookupClockCity(city);
    if (!known) {
      return {
        ok: false,
        text: "city_clock: неизвестный город. Известны Ереван, Москва и Пекин, либо передайте timeZone",
      };
    }
    zone = known.timeZone;
    label = known.name;
  } else if (city) {
    label = lookupClockCity(city)?.name || String(city).trim() || zone;
  }
  if (!zone) {
    return { ok: false, text: "city_clock: нужен timeZone или город" };
  }
  try {
    return { ok: true, text: `${label}: ${formatTimeInZone(date, zone)}` };
  } catch {
    return { ok: false, text: `city_clock: неизвестный пояс ${zone}` };
  }
}

export function createClockServer() {
  const server = new McpServer({
    name: "clock-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "city_clock",
    {
      description:
        "Текущие дата и время одного города (Ереван, Москва, Пекин) или произвольного IANA-пояса",
      inputSchema: z.object({
        city: z
          .string()
          .optional()
          .describe("Город: Ереван, Москва или Пекин. Можно вместе с timeZone"),
        timeZone: z
          .string()
          .optional()
          .describe("IANA-пояс, например Asia/Yerevan. Если указан, город только для подписи"),
      }),
    },
    async ({ city, timeZone }) => {
      const result = cityClock({ city, timeZone });
      return {
        content: [{ type: "text", text: result.text }],
        ...(result.ok ? {} : { isError: true }),
      };
    },
  );

  return server;
}

if (isMainModule(import.meta.url)) {
  await serveStdio(createClockServer, "clock-mcp");
}
