import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { saveChanges, writeOrigin, readOrigin } from "../src/save.js";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("saveChanges copies edited and new files back and deletes removed ones", async () => {
  const origin = await tempDir("file-assistant-origin-");
  const workspace = await tempDir("file-assistant-work-");
  const baseline = await tempDir("file-assistant-base-");

  await fs.mkdir(path.join(origin, "src"));
  await fs.writeFile(path.join(origin, "README.md"), "# old\n");
  await fs.writeFile(path.join(origin, "src", "index.ts"), "export const n = 1;\n");
  await fs.writeFile(path.join(origin, "src", "gone.ts"), "export const gone = true;\n");
  await fs.mkdir(path.join(origin, "node_modules"));
  await fs.writeFile(path.join(origin, "node_modules", "pkg.js"), "module.exports = 1;\n");

  await fs.cp(origin, baseline, { recursive: true });
  await fs.cp(origin, workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "README.md"), "# new\n");
  await fs.mkdir(path.join(workspace, "docs"));
  await fs.writeFile(path.join(workspace, "docs", "guide.md"), "# guide\n");
  await fs.rm(path.join(workspace, "src", "gone.ts"));

  const result = await saveChanges({
    workspaceDir: workspace,
    originPath: origin,
    kind: "directory",
    baselineDir: baseline,
  });

  assert.deepEqual(result.written, ["README.md", "docs/guide.md"]);
  assert.deepEqual(result.removed, ["src/gone.ts"]);
  assert.equal(await fs.readFile(path.join(origin, "README.md"), "utf8"), "# new\n");
  assert.equal(await fs.readFile(path.join(origin, "docs", "guide.md"), "utf8"), "# guide\n");
  assert.equal(
    await fs.readFile(path.join(origin, "src", "index.ts"), "utf8"),
    "export const n = 1;\n",
  );
  await assert.rejects(fs.access(path.join(origin, "src", "gone.ts")));
  assert.equal(
    await fs.readFile(path.join(origin, "node_modules", "pkg.js"), "utf8"),
    "module.exports = 1;\n",
  );
});

test("saveChanges leaves the original untouched when nothing changed", async () => {
  const origin = await tempDir("file-assistant-same-");
  const workspace = await tempDir("file-assistant-same-work-");
  const baseline = await tempDir("file-assistant-same-base-");
  await fs.writeFile(path.join(origin, "README.md"), "# same\n");
  await fs.copyFile(path.join(origin, "README.md"), path.join(workspace, "README.md"));
  await fs.copyFile(path.join(origin, "README.md"), path.join(baseline, "README.md"));

  const result = await saveChanges({
    workspaceDir: workspace,
    originPath: origin,
    kind: "directory",
    baselineDir: baseline,
  });

  assert.deepEqual(result.written, []);
  assert.deepEqual(result.removed, []);
  assert.equal(await fs.readFile(path.join(origin, "README.md"), "utf8"), "# same\n");
});

test("saveChanges writes a single imported file back to its original path", async () => {
  const root = await tempDir("file-assistant-one-");
  const origin = path.join(root, "api.ts");
  const workspace = await tempDir("file-assistant-one-work-");
  const baseline = await tempDir("file-assistant-one-base-");
  await fs.writeFile(origin, "export const v = 1;\n");
  await fs.writeFile(path.join(baseline, "api.ts"), "export const v = 1;\n");
  await fs.writeFile(path.join(workspace, "api.ts"), "export const v = 2;\n");

  const result = await saveChanges({
    workspaceDir: workspace,
    originPath: origin,
    kind: "file",
    baselineDir: baseline,
  });

  assert.deepEqual(result.written, ["api.ts"]);
  assert.equal(await fs.readFile(origin, "utf8"), "export const v = 2;\n");
});

test("readOrigin round-trips a record", async () => {
  const file = path.join(await tempDir("file-assistant-origin-file-"), "source.json");
  await writeOrigin({ path: "/tmp/NodeJSproject", kind: "directory" }, file);
  assert.deepEqual(await readOrigin(file), {
    path: "/tmp/NodeJSproject",
    kind: "directory",
  });
});
