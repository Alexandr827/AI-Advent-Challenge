import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  emptyProfile,
  normalizeProfile,
  parseUserId,
  PROFILE_SECTIONS,
  SECTION_CONSTRAINTS,
  SECTION_CONTEXT,
  SECTION_STYLE,
} from "./model.js";
import { parseMdc, serializeMdc, serializeProfileMarkdown } from "./mdc.js";

const SECTION_META = {
  [SECTION_STYLE]: { file: "style.mdc", title: "Style" },
  [SECTION_CONSTRAINTS]: { file: "constraints.mdc", title: "Constraints" },
  [SECTION_CONTEXT]: { file: "context.mdc", title: "Context" },
};

function readText(filePath) {
  try {
    return readFileSync(filePath, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return "";
    throw err;
  }
}

function writeText(filePath, contents) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents, "utf8");
}

export class FileProfileStorage {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.kind = "file";
  }

  #dir(userId) {
    return join(this.rootDir, parseUserId(userId, "user_id"));
  }

  exists(userId) {
    return Boolean(readText(join(this.#dir(userId), "profile.md")));
  }

  load(userId) {
    const id = parseUserId(userId, "user_id");
    const dir = this.#dir(id);
    const identity = parseMdc(readText(join(dir, "profile.md")));
    if (!identity.frontmatter.user && !identity.entries.user_id) {
      return null;
    }
    const profile = emptyProfile(id);
    profile.name = String(
      identity.frontmatter.name ?? identity.entries.name ?? "",
    ).trim();
    for (const section of PROFILE_SECTIONS) {
      const parsed = parseMdc(readText(join(dir, SECTION_META[section].file)));
      profile[section] = parsed.entries;
    }
    return normalizeProfile(profile, id);
  }

  save(profile) {
    const src = normalizeProfile(profile);
    const id = parseUserId(src.userId, "user_id");
    const dir = this.#dir(id);
    mkdirSync(dir, { recursive: true });
    writeText(join(dir, "profile.md"), serializeProfileMarkdown(src));
    for (const section of PROFILE_SECTIONS) {
      const meta = SECTION_META[section];
      writeText(
        join(dir, meta.file),
        serializeMdc({
          description: `${meta.title} rules for user ${id}`,
          kind: section,
          user: id,
          alwaysApply: true,
          title: meta.title,
          entries: src[section],
        }),
      );
    }
    return src;
  }

  delete(userId) {
    const id = parseUserId(userId, "user_id");
    rmSync(this.#dir(id), { recursive: true, force: true });
  }

  list() {
    let names = [];
    try {
      names = readdirSync(this.rootDir, { withFileTypes: true });
    } catch (err) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
    return names
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.load(entry.name))
      .filter(Boolean);
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return { profiles: {} };
    throw new Error(`Не удалось прочитать БД профилей ${filePath}: ${err.message}`);
  }
}

export class JsonProfileStorage {
  constructor(filePath) {
    this.filePath = filePath;
    this.kind = "db";
  }

  #all() {
    const data = readJson(this.filePath);
    return data?.profiles && typeof data.profiles === "object"
      ? data.profiles
      : {};
  }

  #write(profiles) {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(
      this.filePath,
      `${JSON.stringify({ profiles }, null, 2)}\n`,
      "utf8",
    );
  }

  exists(userId) {
    return Boolean(this.#all()[parseUserId(userId, "user_id")]);
  }

  load(userId) {
    const id = parseUserId(userId, "user_id");
    const row = this.#all()[id];
    return row ? normalizeProfile(row, id) : null;
  }

  save(profile) {
    const src = normalizeProfile(profile);
    const id = parseUserId(src.userId, "user_id");
    const profiles = this.#all();
    profiles[id] = src;
    this.#write(profiles);
    return src;
  }

  delete(userId) {
    const id = parseUserId(userId, "user_id");
    const profiles = this.#all();
    delete profiles[id];
    this.#write(profiles);
  }

  list() {
    return Object.values(this.#all()).map((row) => normalizeProfile(row));
  }
}

export class ApiProfileStorage {
  constructor(baseUrl, { fetchImpl } = {}) {
    const url = String(baseUrl ?? "").trim().replace(/\/$/, "");
    if (!url) {
      throw new Error("PROFILE_API_URL не задан для хранилища api");
    }
    this.baseUrl = url;
    this.kind = "api";
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
  }

  async #request(method, path, body) {
    const fetchImpl = this.fetchImpl;
    if (typeof fetchImpl !== "function") {
      throw new Error("fetch недоступен для PROFILE_STORAGE=api");
    }
    const res = await fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body == null ? undefined : JSON.stringify(body),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Профиль API ${method} ${path}: HTTP ${res.status}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async exists(userId) {
    return Boolean(await this.load(userId));
  }

  async load(userId) {
    const id = parseUserId(userId, "user_id");
    const row = await this.#request("GET", `/profiles/${id}`);
    return row ? normalizeProfile(row, id) : null;
  }

  async save(profile) {
    const src = normalizeProfile(profile);
    const id = parseUserId(src.userId, "user_id");
    const row = await this.#request("PUT", `/profiles/${id}`, src);
    return row ? normalizeProfile(row, id) : src;
  }

  async delete(userId) {
    const id = parseUserId(userId, "user_id");
    await this.#request("DELETE", `/profiles/${id}`);
  }

  async list() {
    const data = await this.#request("GET", "/profiles");
    const rows = Array.isArray(data) ? data : data?.profiles;
    return Array.isArray(rows) ? rows.map((row) => normalizeProfile(row)) : [];
  }
}

export function createProfileStorage({
  kind,
  dir,
  dbPath,
  apiUrl,
  fetchImpl,
} = {}) {
  const type = String(kind || process.env.PROFILE_STORAGE || "file")
    .trim()
    .toLowerCase();
  if (type === "file" || type === "md" || type === "mdc" || type === "rules") {
    if (!dir) throw new Error("Для file-хранилища профилей нужен каталог");
    return new FileProfileStorage(dir);
  }
  if (type === "db" || type === "json") {
    if (!dbPath) throw new Error("Для db-хранилища профилей нужен путь к JSON");
    return new JsonProfileStorage(dbPath);
  }
  if (type === "api") {
    return new ApiProfileStorage(apiUrl ?? process.env.PROFILE_API_URL, {
      fetchImpl,
    });
  }
  throw new Error(
    `PROFILE_STORAGE должен быть file, db или api (сейчас ${type})`,
  );
}
