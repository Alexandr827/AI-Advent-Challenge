import { relative, resolve, sep } from "node:path";

/** Каталог targetPath лежит внутри root (включая сам root). */
export function isPathInsideRoot(root, targetPath) {
  const base = resolve(root);
  const target = resolve(targetPath);
  const rel = relative(base, target);
  if (rel === "") return true;
  return !rel.startsWith("..") && !rel.includes(sep);
}
