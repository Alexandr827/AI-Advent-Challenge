import { toolText } from "./mcp-pipeline.js";

const KNOWN_CITIES = [
  {
    stems: ["ереван", "yerevan"],
    name: "Ереван",
    query: "Yerevan",
    timeZone: "Asia/Yerevan",
  },
  {
    stems: ["москв", "moscow"],
    name: "Москва",
    query: "Moscow",
    timeZone: "Europe/Moscow",
  },
  {
    stems: ["пекин", "beijing"],
    name: "Пекин",
    query: "Beijing",
    timeZone: "Asia/Shanghai",
  },
];

const WEATHER_RE = /погод|прогноз|forecast/iu;
const CLOCK_RE = /(?:^|[^\p{L}\p{N}_])(?:время|час|часы|time)(?:$|[^\p{L}\p{N}_])/iu;
const SAVE_RE = /сохран|файл|запиш/iu;
const MONTHS = {
  января: "01",
  февраля: "02",
  марта: "03",
  апреля: "04",
  мая: "05",
  июня: "06",
  июля: "07",
  августа: "08",
  сентября: "09",
  октября: "10",
  ноября: "11",
  декабря: "12",
};

export function extractWhen(text) {
  const source = String(text ?? "");
  const rus = source.match(
    /(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)\s+(\d{4})/iu,
  );
  const iso = source.match(/\b(\d{4}-\d{2}-\d{2})\b/u);
  let date = "";
  if (rus) {
    const day = Number(rus[1]);
    const month = MONTHS[rus[2].toLowerCase()];
    if (month && day >= 1 && day <= 31) {
      date = `${rus[3]}-${month}-${String(day).padStart(2, "0")}`;
    }
  } else if (iso) {
    date = iso[1];
  }
  const clock = source.match(/(\d{1,2})\s+час(?:а|ов)?(?:\s+(\d{1,2})\s+минут(?:а|ы|у)?)?/iu);
  let hour = null;
  let minute = null;
  if (clock) {
    hour = Number(clock[1]);
    minute = clock[2] == null ? 0 : Number(clock[2]);
    if (hour > 23 || minute > 59) {
      hour = null;
      minute = null;
    }
  }
  if (!date && hour == null) return null;
  return { date, hour, minute };
}

function whenArguments(when) {
  if (!when) return {};
  const args = {};
  if (when.date) args.date = when.date;
  if (when.hour != null) args.hour = when.hour;
  if (when.minute != null) args.minute = when.minute;
  return args;
}

function knownCity(value) {
  const lower = String(value ?? "").trim().toLowerCase();
  if (!lower) return null;
  return (
    KNOWN_CITIES.find((city) => city.stems.some((stem) => lower.includes(stem))) ?? null
  );
}

export function extractCity(text) {
  const source = String(text ?? "");
  const quoted = source.match(/[«"]([^»"]+)[»"]/u);
  if (quoted?.[1]?.trim()) {
    const raw = quoted[1].trim();
    return knownCity(raw) ?? { name: raw, query: raw, timeZone: null };
  }
  const embedded = knownCity(source);
  if (embedded) return embedded;
  const prep = source.match(/(?:^|[^\p{L}\p{N}_])в\s+([A-Za-zА-Яа-яЁё-]{2,})/iu);
  if (!prep) return null;
  const raw = prep[1];
  return knownCity(raw) ?? { name: raw, query: raw, timeZone: null };
}

function briefTitle(plan) {
  const place = plan.city?.name || "сводка";
  const day = plan.when?.date ? ` ${plan.when.date}` : "";
  if (plan.steps.some((step) => step.name === "forecast")) return `погода ${place}${day}`;
  if (plan.steps.some((step) => step.name === "city_clock")) return `время ${place}`;
  return place;
}

export function planOrchestration(text) {
  const source = String(text ?? "");
  const weather = WEATHER_RE.test(source);
  const clock = CLOCK_RE.test(source);
  if (!weather && !clock) return null;

  const city = extractCity(source);
  if (!city) {
    return {
      steps: [],
      city: null,
      error: "Не понял город. Напишите «в Ереване» или город в кавычках.",
    };
  }
  if (clock && !weather && !city.timeZone) {
    return {
      steps: [],
      city,
      error:
        "city_clock знает Ереван, Москву и Пекин. Напишите один из них или добавьте погоду, чтобы взять пояс из геокода.",
    };
  }

  const when = extractWhen(source);
  const steps = [];
  if (weather) {
    steps.push({
      server: "weather-mcp",
      name: "geocode",
      arguments: { query: city.query },
    });
    steps.push({
      server: "weather-mcp",
      name: "forecast",
      arguments: whenArguments(when),
      fill: "forecast",
    });
  }
  if (clock) {
    steps.push({
      server: "clock-mcp",
      name: "city_clock",
      arguments: weather ? {} : { city: city.name },
      fill: weather ? "clock" : "",
    });
  }
  if (SAVE_RE.test(source)) {
    steps.push({
      server: "brief-mcp",
      name: "save_brief",
      arguments: {},
      fill: "brief",
    });
  }
  return { steps, city, when };
}

function fail(steps, name, server, args, text) {
  return {
    ok: false,
    steps: [
      ...steps,
      { server, name, arguments: args, text, isError: true },
    ],
  };
}

function parseGeocode(text) {
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const latitude = Number(data.latitude);
    const longitude = Number(data.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    return {
      name: String(data.name ?? ""),
      latitude,
      longitude,
      timezone: String(data.timezone ?? ""),
    };
  } catch {
    return null;
  }
}

export async function runOrchestration(plan, callTool) {
  const steps = [];
  const texts = [];
  let geocode = null;
  for (const step of plan.steps ?? []) {
    let args = { ...step.arguments };
    if (step.fill === "forecast") {
      if (!geocode) {
        return fail(steps, step.name, step.server, args, "forecast: нет координат из geocode");
      }
      args = {
        latitude: geocode.latitude,
        longitude: geocode.longitude,
        timezone: geocode.timezone,
        ...whenArguments(step.arguments),
      };
    } else if (step.fill === "clock") {
      if (!geocode?.timezone) {
        return fail(steps, step.name, step.server, args, "city_clock: нет пояса из geocode");
      }
      args = { city: plan.city?.name || geocode.name, timeZone: geocode.timezone };
    } else if (step.fill === "brief") {
      args = { title: briefTitle(plan), content: texts.join("\n\n") };
    }

    const result = await callTool({
      server: step.server,
      name: step.name,
      arguments: args,
    });
    const body = toolText(result);
    steps.push({
      server: step.server,
      name: step.name,
      arguments: args,
      text: body,
      isError: Boolean(result?.isError),
    });
    if (result?.isError) return { ok: false, steps };
    texts.push(body);
    if (step.name === "geocode") {
      geocode = parseGeocode(body);
      if (!geocode) {
        return fail(
          steps,
          "forecast",
          "weather-mcp",
          {},
          "geocode: в ответе нет latitude, longitude и timezone",
        );
      }
    }
  }
  return { ok: true, steps };
}
