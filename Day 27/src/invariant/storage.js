import { readFileSync } from "node:fs";
import { writeJsonAtomic } from "../fs-utils.js";
import {
  cloneInvariantSet,
  normalizeInvariantSet,
  parseSetId,
} from "./model.js";

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return { sets: {} };
    throw new Error(`Не удалось прочитать инварианты ${filePath}: ${err.message}`);
  }
}

export class JsonInvariantStorage {
  constructor(filePath) {
    this.filePath = filePath;
    this.kind = "json";
  }

  #all() {
    const data = readJson(this.filePath);
    return data?.sets && typeof data.sets === "object" ? data.sets : {};
  }

  #write(sets) {
    const payload = {
      sets: Object.fromEntries(
        Object.entries(sets).map(([id, row]) => {
          const src = normalizeInvariantSet(row, id);
          return [
            id,
            {
              id: src.id,
              items: src.items.map((item) => item.toJSON()),
            },
          ];
        }),
      ),
    };
    writeJsonAtomic(this.filePath, payload);
  }

  exists(setId) {
    return Boolean(this.#all()[parseSetId(setId, "set_id")]);
  }

  load(setId) {
    const id = parseSetId(setId, "set_id");
    const row = this.#all()[id];
    return row ? normalizeInvariantSet(row, id) : null;
  }

  save(set) {
    const src = cloneInvariantSet(set);
    const id = parseSetId(src.id, "set_id");
    src.id = id;
    const sets = this.#all();
    sets[id] = {
      id,
      items: src.items.map((item) => item.toJSON()),
    };
    this.#write(sets);
    return normalizeInvariantSet(sets[id], id);
  }

  delete(setId) {
    const id = parseSetId(setId, "set_id");
    const sets = this.#all();
    delete sets[id];
    this.#write(sets);
  }

  list() {
    return Object.values(this.#all()).map((row) => normalizeInvariantSet(row));
  }
}

export function createInvariantStorage({ path } = {}) {
  if (!path) {
    throw new Error("Для хранилища инвариантов нужен путь к JSON");
  }
  return new JsonInvariantStorage(path);
}
