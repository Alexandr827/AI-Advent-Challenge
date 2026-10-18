import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertCursorApiKey,
  loadEnv,
  PLACEHOLDER_CURSOR_API_KEY,
  resolveCursorApiKey,
} from "../src/env.js";

const tmpDirs = [];

after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("env helpers", () => {
  it("loadEnv sets only valid keys and does not override existing", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-test-"));
    tmpDirs.push(dir);
    const path = join(dir, ".env");
    writeFileSync(
      path,
      "CURSOR_MODEL=from-file\nBAD-KEY=skip\nNODE_OPTIONS=evil\n",
      "utf8",
    );
    process.env.CURSOR_MODEL = "preset";
    loadEnv(path);
    assert.equal(process.env.CURSOR_MODEL, "preset");
    assert.equal(process.env["BAD-KEY"], undefined);
    delete process.env.NODE_OPTIONS;
  });

  it("assertCursorApiKey rejects placeholder", () => {
    assert.throws(
      () => assertCursorApiKey(PLACEHOLDER_CURSOR_API_KEY, { exit: false }),
      /реальный CURSOR_API_KEY/,
    );
    assert.equal(assertCursorApiKey("cursor_real_key_123", { exit: false }), "cursor_real_key_123");
  });

  it("resolveCursorApiKey skips the cloud key for lmstudio", () => {
    assert.equal(resolveCursorApiKey("", "lmstudio"), "");
    assert.equal(resolveCursorApiKey(PLACEHOLDER_CURSOR_API_KEY, "lmstudio"), "");
    assert.equal(resolveCursorApiKey("cursor_real_key_123", "lmstudio"), "cursor_real_key_123");
    assert.throws(
      () => resolveCursorApiKey(PLACEHOLDER_CURSOR_API_KEY, "local", { exit: false }),
      /реальный CURSOR_API_KEY/,
    );
  });
});
