import { InvariantLoader } from "./invariant/loader.js";
import {
  addInvariant,
  cloneInvariantSet,
  emptyInvariantSet,
  formatInvariantSet,
  formatInvariantsPrompt,
  formatViolationsPrompt,
  invariantSnapshot,
  normalizeInvariantSet,
  parseInvariantSpec,
  parseInvariantType,
  parseSetId,
  removeInvariant,
} from "./invariant/model.js";
import { createInvariantStorage } from "./invariant/storage.js";
import {
  formatRefusal,
  MAX_INVARIANT_RETRIES,
  runInvariantPipeline,
  validateResponse,
} from "./invariant/validate.js";

export {
  addInvariant,
  createInvariantStorage,
  emptyInvariantSet,
  formatInvariantSet,
  formatInvariantsPrompt,
  formatRefusal,
  formatViolationsPrompt,
  InvariantLoader,
  invariantSnapshot,
  MAX_INVARIANT_RETRIES,
  normalizeInvariantSet,
  parseInvariantSpec,
  parseInvariantType,
  parseSetId,
  removeInvariant,
  runInvariantPipeline,
  validateResponse,
};

export class InvariantService {
  constructor({ storage, loader } = {}) {
    if (!storage) {
      throw new Error("InvariantService: нужно хранилище инвариантов");
    }
    this.storage = storage;
    this.loader = loader ?? new InvariantLoader(storage);
  }

  async create(setId) {
    const id = parseSetId(setId, "set_id");
    if (await this.storage.exists(id)) {
      throw new Error(`Набор инвариантов уже есть: ${id}`);
    }
    return this.storage.save(emptyInvariantSet(id));
  }

  load(setId) {
    return this.loader.load(setId);
  }

  tryLoad(setId) {
    return this.loader.tryLoad(setId);
  }

  async list() {
    return this.storage.list();
  }

  async add(setId, typeToken, argTokens = []) {
    const current = await this.loader.load(setId);
    const spec = parseInvariantSpec(typeToken, argTokens);
    const result = addInvariant(current, spec);
    await this.storage.save(result.set);
    return result;
  }

  async remove(setId, idOrType) {
    const current = await this.loader.load(setId);
    const result = removeInvariant(current, idOrType);
    await this.storage.save(result.set);
    return result;
  }

  async delete(setId) {
    const id = parseSetId(setId, "set_id");
    if (!(await this.storage.exists(id))) {
      throw new Error(`Набор инвариантов не найден: ${id}`);
    }
    await this.storage.delete(id);
    return id;
  }

  format(set) {
    return formatInvariantSet(set);
  }
}

export function formatInvariantCreated(set) {
  return `Набор инвариантов ${set.id} создан. Добавьте правила: invariant add ${set.id} stack NodeJS JavaScript`;
}

export function formatInvariantAdded(result) {
  return `Инвариант ${result.set.id}: + ${result.item.description}`;
}

export function formatInvariantRemoved(result) {
  if (result.item) {
    return `Инвариант ${result.set.id}: удалено ${result.item.id} (${result.item.description})`;
  }
  return `Инвариант ${result.set.id}: очищен набор (${result.count})`;
}

export function formatInvariantDeleted(setId, detached = []) {
  const names = detached.map((item) => item?.name ?? item).filter(Boolean);
  if (!names.length) return `Набор инвариантов ${setId} удалён`;
  return `Набор инвариантов ${setId} удалён; отключён от ${names.join(", ")}`;
}

export function formatInvariantList(sets) {
  if (!sets.length) return "Инварианты: (пусто)";
  return [
    `Инварианты (${sets.length}):`,
    ...sets.map((item) => {
      const snap = invariantSnapshot(item);
      const types = snap.types.length ? snap.types.join(", ") : "пусто";
      return `  ${snap.id}  ${snap.count}  [${types}]`;
    }),
  ].join("\n");
}

export function formatInvariantCheck(result) {
  if (!result) return "";
  const inv = (result.violations ?? []).filter((item) => item.kind !== "stage");
  if (result.refused) {
    if (!inv.length) return "";
    const names = inv.map((item) => item.description).join("; ");
    return `инварианты: ответ отклонён (${names})`;
  }
  if (result.attempts > 1) {
    if (Array.isArray(result.retryKinds) && !result.retryKinds.includes("invariant")) {
      return "";
    }
    return `инварианты: нарушение, повтор ${result.attempts - 1}`;
  }
  return "";
}

export { cloneInvariantSet };
