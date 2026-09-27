import { emptyProfile, normalizeProfile, parseUserId } from "./model.js";

export class ProfileLoader {
  constructor(storage) {
    this.storage = storage;
  }

  async load(userId) {
    const id = parseUserId(userId, "user_id");
    const row = await this.storage.load(id);
    if (!row) {
      throw new Error(`Профиль не найден: ${id}`);
    }
    return normalizeProfile(row, id);
  }

  tryLoad(userId) {
    const id = String(userId ?? "").trim();
    if (!id) return emptyProfile();
    const row = this.storage.load(id);
    if (!row || typeof row.then === "function") return emptyProfile();
    return normalizeProfile(row, id);
  }

  async exists(userId) {
    const id = parseUserId(userId, "user_id");
    return Boolean(await this.storage.exists(id));
  }
}
