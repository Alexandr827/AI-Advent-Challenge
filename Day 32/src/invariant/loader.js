import { emptyInvariantSet, normalizeInvariantSet, parseSetId } from "./model.js";

export class InvariantLoader {
  constructor(storage) {
    this.storage = storage;
  }

  async load(setId) {
    const id = parseSetId(setId, "set_id");
    const row = await this.storage.load(id);
    if (!row) {
      throw new Error(`Набор инвариантов не найден: ${id}`);
    }
    return normalizeInvariantSet(row, id);
  }

  tryLoad(setId) {
    const id = String(setId ?? "").trim();
    if (!id) return emptyInvariantSet();
    const row = this.storage.load(id);
    if (!row || typeof row.then === "function") return emptyInvariantSet();
    return normalizeInvariantSet(row, id);
  }

  async exists(setId) {
    const id = parseSetId(setId, "set_id");
    return Boolean(await this.storage.exists(id));
  }
}
