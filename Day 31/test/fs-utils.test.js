import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeJsonAtomic } from "../src/fs-utils.js";

const tmpDirs = [];

after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("writeJsonAtomic", () => {
  it("writes valid json and uses tmp rename", () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-utils-"));
    tmpDirs.push(dir);
    const target = join(dir, "data.json");
    writeJsonAtomic(target, { ok: true, n: 1 });
    assert.equal(existsSync(`${target}.tmp`), false);
    const parsed = JSON.parse(readFileSync(target, "utf8"));
    assert.deepEqual(parsed, { ok: true, n: 1 });
  });
});
