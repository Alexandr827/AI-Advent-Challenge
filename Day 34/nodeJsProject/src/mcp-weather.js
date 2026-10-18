import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isMainModule, serveStdio } from "./mcp-serve.js";

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";

function asTool(result) {
  return {
    content: [{ type: "text", text: result.text }],
    ...(result.ok ? {} : { isError: true }),
  };
}

function weatherLabel(code) {
  const n = Number(code);
  if (n === 0) return "ясно";
  if (n <= 3) return "облачно";
  if (n === 45 || n === 48) return "туман";
  if (n <= 57) return "морось";
  if (n <= 67) return "дождь";
  if (n <= 77) return "снег";
  if (n <= 82) return "ливень";
  if (n <= 86) return "снежный заряд";
  if (n >= 95) return "гроза";
  return `код ${n}`;
}

async function readJson(response, label) {
  if (!response.ok) {
    return { ok: false, text: `${label}: HTTP ${response.status}` };
  }
  try {
    return { ok: true, data: await response.json() };
  } catch {
    return { ok: false, text: `${label}: ответ не JSON` };
  }
}

export async function geocodeCity(query, { fetchImpl = globalThis.fetch } = {}) {
  const name = String(query ?? "").trim();
  if (!name) return { ok: false, text: "geocode: пустой query" };
  const url = new URL(GEOCODE_URL);
  url.searchParams.set("name", name);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "ru");
  let response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    return { ok: false, text: `geocode: ${error.message}` };
  }
  const parsed = await readJson(response, "geocode");
  if (!parsed.ok) return parsed;
  const hit = parsed.data?.results?.[0];
  if (!hit || hit.latitude == null || hit.longitude == null) {
    return { ok: false, text: `geocode: город не найден: ${name}` };
  }
  return {
    ok: true,
    text: JSON.stringify({
      name: hit.name,
      latitude: hit.latitude,
      longitude: hit.longitude,
      timezone: hit.timezone ?? "",
      country: hit.country ?? "",
    }),
  };
}

function hourlyUrl(base, lat, lon, zone, date) {
  const url = new URL(base);
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("hourly", "temperature_2m,weather_code");
  url.searchParams.set("timezone", zone);
  url.searchParams.set("start_date", date);
  url.searchParams.set("end_date", date);
  return url;
}

function pickHour(data, date, hour) {
  const times = data?.hourly?.time;
  if (!Array.isArray(times)) return null;
  const hh = String(hour).padStart(2, "0");
  const index = times.findIndex((stamp) => String(stamp).startsWith(`${date}T${hh}:`));
  if (index < 0) return null;
  const temp = data.hourly?.temperature_2m?.[index];
  const code = data.hourly?.weather_code?.[index];
  if (temp == null || code == null) return null;
  return { time: times[index], temp, code };
}

function formatSlot(date, hour, minute, zone, slot) {
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute ?? 0).padStart(2, "0");
  return `${date} ${hh}:${mm} (${zone}): ${slot.temp} °C, ${weatherLabel(slot.code)} (час ${slot.time})`;
}

async function loadJson(url, fetchImpl, label) {
  let response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    return { ok: false, text: `${label}: ${error.message}` };
  }
  return readJson(response, label);
}

async function forecastHour({ lat, lon, zone, date, hour, minute }, fetchImpl) {
  const forecast = await loadJson(hourlyUrl(FORECAST_URL, lat, lon, zone, date), fetchImpl, "forecast");
  const fromForecast = forecast.ok ? pickHour(forecast.data, date, hour) : null;
  if (fromForecast) {
    return { ok: true, text: formatSlot(date, hour, minute, zone, fromForecast) };
  }
  const archive = await loadJson(hourlyUrl(ARCHIVE_URL, lat, lon, zone, date), fetchImpl, "forecast");
  if (!archive.ok) {
    return forecast.ok
      ? { ok: false, text: `forecast: нет часа ${hour} на ${date}` }
      : archive;
  }
  const fromArchive = pickHour(archive.data, date, hour);
  if (!fromArchive) return { ok: false, text: `forecast: нет часа ${hour} на ${date}` };
  return { ok: true, text: formatSlot(date, hour, minute, zone, fromArchive) };
}

export async function forecastAt(
  { latitude, longitude, timezone, date, hour, minute },
  { fetchImpl = globalThis.fetch } = {},
) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { ok: false, text: "forecast: нужны latitude и longitude" };
  }
  const zone = String(timezone ?? "").trim() || "auto";
  const day = String(date ?? "").trim();
  if (day) {
    if (hour == null || hour === "") {
      return { ok: false, text: "forecast: для даты нужен час" };
    }
    const clockHour = Number(hour);
    if (!Number.isInteger(clockHour) || clockHour < 0 || clockHour > 23) {
      return { ok: false, text: "forecast: час вне 0–23" };
    }
    return forecastHour(
      { lat, lon, zone, date: day, hour: clockHour, minute: Number(minute ?? 0) },
      fetchImpl,
    );
  }
  const url = new URL(FORECAST_URL);
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,weather_code");
  url.searchParams.set("timezone", zone);
  url.searchParams.set("forecast_days", "2");
  const parsed = await loadJson(url, fetchImpl, "forecast");
  if (!parsed.ok) return parsed;
  const daily = parsed.data?.daily;
  const tomorrow = daily?.time?.[1];
  const min = daily?.temperature_2m_min?.[1];
  const max = daily?.temperature_2m_max?.[1];
  const code = daily?.weather_code?.[1];
  if (tomorrow == null || min == null || max == null || code == null) {
    return { ok: false, text: "forecast: в ответе нет дня на завтра" };
  }
  const where = zone === "auto" ? "auto" : zone;
  return {
    ok: true,
    text: `Завтра ${tomorrow}: ${min}…${max} °C, ${weatherLabel(code)} (${where})`,
  };
}

export function createWeatherServer({ fetchImpl } = {}) {
  const server = new McpServer({
    name: "weather-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "geocode",
    {
      description:
        "Город в координаты Open-Meteo: JSON с name, latitude, longitude, timezone, country. Ключ не нужен",
      inputSchema: z.object({
        query: z.string().describe("Название города, например Yerevan или Ереван"),
      }),
    },
    async ({ query }) => asTool(await geocodeCity(query, { fetchImpl })),
  );

  server.registerTool(
    "forecast",
    {
      description:
        "Прогноз Open-Meteo по координатам. Без date — сутки на завтра. С date и hour — температура в этот час местного пояса",
      inputSchema: z.object({
        latitude: z.number().describe("Широта из geocode"),
        longitude: z.number().describe("Долгота из geocode"),
        timezone: z
          .string()
          .optional()
          .describe("IANA-пояс из geocode, например Europe/Moscow"),
        date: z
          .string()
          .optional()
          .describe("День YYYY-MM-DD. Без даты прогноз считается на завтра"),
        hour: z
          .number()
          .int()
          .min(0)
          .max(23)
          .optional()
          .describe("Час 0–23 в поясе timezone"),
        minute: z
          .number()
          .int()
          .min(0)
          .max(59)
          .optional()
          .describe("Минута из запроса. В ответе значение почасового слота этого часа"),
      }),
    },
    async ({ latitude, longitude, timezone, date, hour, minute }) =>
      asTool(await forecastAt({ latitude, longitude, timezone, date, hour, minute }, { fetchImpl })),
  );

  return server;
}

if (isMainModule(import.meta.url)) {
  await serveStdio(createWeatherServer, "weather-mcp");
}
