import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "./fs-utils.js";

export const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function connectionPath(root = cliRoot) {
  return resolve(root, "data", "connection.json");
}

export function readConnection(root = cliRoot) {
  const file = connectionPath(root);
  if (!existsSync(file)) return null;
  const data = JSON.parse(readFileSync(file, "utf8"));
  const path = data?.path ? resolve(data.path) : null;
  if (!path || !existsSync(path)) return null;
  return path;
}

export function saveConnection(projectPath, root = cliRoot) {
  const abs = resolve(projectPath);
  if (!existsSync(abs)) {
    throw new Error(`Проект не найден: ${abs}`);
  }
  writeJsonAtomic(connectionPath(root), { path: abs });
  return abs;
}

export function clearConnection(projectPath, root = cliRoot) {
  const current = readConnection(root);
  if (!current) {
    throw new Error("Проект не подключён.");
  }
  const abs = resolve(projectPath);
  if (abs !== current) {
    throw new Error(`Подключён другой проект: ${current}`);
  }
  rmSync(connectionPath(root), { force: true });
  return current;
}

export function changeConnection(projectPath, root = cliRoot) {
  const abs = resolve(projectPath);
  if (!existsSync(abs)) {
    throw new Error(`Проект не найден: ${abs}`);
  }
  const previous = readConnection(root);
  if (previous === abs) {
    throw new Error(`Уже подключён: ${abs}`);
  }
  writeJsonAtomic(connectionPath(root), { path: abs });
  return { previous, path: abs };
}

export function requireConnection(root = cliRoot) {
  const path = readConnection(root);
  if (!path) {
    throw new Error("Сначала подключите проект: connect <путь>");
  }
  return path;
}
