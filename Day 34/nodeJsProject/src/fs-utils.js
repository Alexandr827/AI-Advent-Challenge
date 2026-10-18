import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function writeJsonAtomic(filePath, data, space = 2) {
  mkdirSync(dirname(filePath), { recursive: true });
  const body =
    typeof data === "string"
      ? data
      : `${JSON.stringify(data, null, space)}\n`;
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, filePath);
}
