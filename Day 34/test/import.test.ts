import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { shouldSkip } from "../src/ignore.js";
import { importSource, resolveFocusFile } from "../src/workspace.js";

test("shouldSkip drops dependencies, git metadata, and secret env files", () => {
  assert.equal(shouldSkip("node_modules/leftpad/index.js"), true);
  assert.equal(shouldSkip(".git/config"), true);
  assert.equal(shouldSkip(".env"), true);
  assert.equal(shouldSkip(".env.local"), true);
  assert.equal(shouldSkip(".env.example"), false);
  assert.equal(shouldSkip("src/index.ts"), false);
});

test("importSource copies a project without secrets or dependencies", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-assistant-src-"));
  const dest = await fs.mkdtemp(path.join(os.tmpdir(), "file-assistant-dest-"));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "index.ts"), "export const n = 1;\n");
  await fs.writeFile(path.join(root, ".env"), "CURSOR_API_KEY=secret\n");
  await fs.writeFile(path.join(root, ".env.example"), "CURSOR_API_KEY=\n");
  await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(path.join(root, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");

  const result = await importSource(root, dest);

  assert.equal(result.kind, "directory");
  assert.equal(result.files, 2);
  assert.equal(
    await fs.readFile(path.join(dest, "src", "index.ts"), "utf8"),
    "export const n = 1;\n",
  );
  await assert.rejects(fs.access(path.join(dest, ".env")));
  await assert.rejects(fs.access(path.join(dest, "node_modules")));
  assert.equal(
    await fs.readFile(path.join(dest, ".env.example"), "utf8"),
    "CURSOR_API_KEY=\n",
  );
});

test("importSource copies one file into an empty destination", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-assistant-file-"));
  const dest = await fs.mkdtemp(path.join(os.tmpdir(), "file-assistant-file-dest-"));
  const source = path.join(root, "api.ts");
  await fs.writeFile(source, "export function api() {}\n");

  const result = await importSource(source, dest);

  assert.equal(result.kind, "file");
  assert.equal(result.files, 1);
  assert.equal(
    await fs.readFile(path.join(dest, "api.ts"), "utf8"),
    "export function api() {}\n",
  );
});

test("importSource refuses a destination inside the source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-assistant-overlap-"));
  const dest = path.join(root, "nested");
  await fs.mkdir(dest);
  await fs.writeFile(path.join(dest, "keep.txt"), "keep");

  await assert.rejects(importSource(root, dest), /overlaps/);
  assert.equal(await fs.readFile(path.join(dest, "keep.txt"), "utf8"), "keep");
});

test("resolveFocusFile accepts a file inside the project and rejects a path outside it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-assistant-focus-"));
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "api.ts"), "export {}\n");

  assert.equal(await resolveFocusFile(root, "src/api.ts"), "src/api.ts");
  await assert.rejects(resolveFocusFile(root, "../api.ts"), /inside the project/);
});
