import { ProfileLoader } from "./profile/loader.js";
import { buildPrompt, formatProfilePrompt, runProfilePipeline } from "./profile/builder.js";
import {
  clearProfileEntry,
  cloneProfile,
  emptyProfile,
  formatProfile,
  hasPersonalization,
  parseSection,
  parseSectionKey,
  parseUserId,
  profileSnapshot,
  SECTION_CONSTRAINTS,
  SECTION_CONTEXT,
  SECTION_STYLE,
  sectionTitle,
  setProfileEntry,
  keyTitle,
} from "./profile/model.js";
import { createProfileStorage } from "./profile/storage.js";

export {
  buildPrompt,
  createProfileStorage,
  emptyProfile,
  formatProfile,
  formatProfilePrompt,
  hasPersonalization,
  parseSection,
  parseSectionKey,
  parseUserId,
  ProfileLoader,
  profileSnapshot,
  runProfilePipeline,
  SECTION_CONSTRAINTS,
  SECTION_CONTEXT,
  SECTION_STYLE,
};

export class ProfileService {
  constructor({ storage, loader } = {}) {
    if (!storage) {
      throw new Error("ProfileService: нужно хранилище профилей");
    }
    this.storage = storage;
    this.loader = loader ?? new ProfileLoader(storage);
  }

  async create(userId, { name = "" } = {}) {
    const id = parseUserId(userId, "user_id");
    if (await this.storage.exists(id)) {
      throw new Error(`Профиль уже есть: ${id}`);
    }
    const profile = emptyProfile(id);
    profile.name = String(name ?? "").trim();
    return this.storage.save(profile);
  }

  load(userId) {
    return this.loader.load(userId);
  }

  tryLoad(userId) {
    return this.loader.tryLoad(userId);
  }

  async list() {
    return this.storage.list();
  }

  async setName(userId, name) {
    const profile = cloneProfile(await this.loader.load(userId));
    const text = String(name ?? "").trim();
    if (!text) throw new Error("Имя пользователя не может быть пустым");
    profile.name = text;
    return this.storage.save(profile);
  }

  async setEntry(userId, section, key, value) {
    const current = await this.loader.load(userId);
    const result = setProfileEntry(current, section, key, value);
    await this.storage.save(result.profile);
    return result;
  }

  async clear(userId, section, key) {
    const current = await this.loader.load(userId);
    const result = clearProfileEntry(current, section, key);
    await this.storage.save(result.profile);
    return result;
  }

  async remove(userId) {
    const id = parseUserId(userId, "user_id");
    if (!(await this.storage.exists(id))) {
      throw new Error(`Профиль не найден: ${id}`);
    }
    await this.storage.delete(id);
    return id;
  }

  format(profile) {
    return formatProfile(profile);
  }
}

export function formatProfileSet(result) {
  return `Профиль ${result.profile.userId}: ${sectionTitle(result.section)} / ${keyTitle(result.section, result.key)} = ${result.value}`;
}

export function formatProfileCreated(profile) {
  const who = profile.name ? `«${profile.name}»` : "(без имени)";
  return `Профиль ${profile.userId} создан: ${who}. Задайте style / constraints / context, затем profile attach <агент> ${profile.userId}.`;
}

export function formatProfileCleared(result) {
  if (result.key) {
    return `Профиль ${result.profile.userId}: удалено ${sectionTitle(result.section)} / ${result.key}`;
  }
  if (result.section) {
    return `Профиль ${result.profile.userId}: очищена секция «${sectionTitle(result.section)}» (${result.count})`;
  }
  return `Профиль ${result.profile.userId}: очищены имя, стиль, ограничения и контекст (${result.count})`;
}

export function formatProfileDeleted(userId, detached = []) {
  const names = detached.map((item) => item?.name ?? item).filter(Boolean);
  if (!names.length) return `Профиль ${userId} удалён`;
  return `Профиль ${userId} удалён; отключён от ${names.join(", ")}`;
}

export function formatProfileList(profiles) {
  if (!profiles.length) return "Профили: (пусто)";
  return [
    `Профили (${profiles.length}):`,
    ...profiles.map((item) => {
      const snap = profileSnapshot(item);
      return `  ${snap.userId}${snap.name ? ` — ${snap.name}` : ""}  style=${snap.style} constraints=${snap.constraints} context=${snap.context}`;
    }),
  ].join("\n");
}
