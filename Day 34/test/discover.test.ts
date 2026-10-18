import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { findProjectDirs, resolveProjectSource } from "../src/discover.js";

async function makeProject(root: string, parts: string[]): Promise<string> {
  const dir = path.join(root, ...parts);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "README.md"), "# demo\n");
  return dir;
}

test("findProjectDirs returns a project nested one level under the root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-assistant-scan-"));
  const project = await makeProject(root, ["code", "NodeJSproject"]);
  await makeProject(root, ["code", "node_modules", "NodeJSproject"]);

  const matches = await findProjectDirs("NodeJSproject", [root]);

  assert.deepEqual(matches, [await fs.realpath(project)]);
});

test("findProjectDirs reports several directories with the same name", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-assistant-dup-"));
  await makeProject(root, ["a", "NodeJSproject"]);
  await makeProject(root, ["b", "NodeJSproject"]);

  const matches = await findProjectDirs("nodejsproject", [root]);

  assert.equal(matches.length, 2);
});

test("resolveProjectSource rejects a path disguised as a name", async () => {
  await assert.rejects(resolveProjectSource("../secret", ["/tmp"]), /single folder name/);
});

test("resolveProjectSource accepts an absolute directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "file-assistant-abs-"));
  const project = await makeProject(root, ["NodeJSproject"]);

  assert.equal(await resolveProjectSource(project, []), await fs.realpath(project));
});
