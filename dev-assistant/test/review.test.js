import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cliRoot, connectionPath, saveConnection } from "../src/connection.js";
import { indexProjectDocs } from "../src/rag/project.js";
import {
  buildReviewQuery,
  collectRangeDiff,
  collectReviewDiff,
  detectBugMarkers,
  loadDiffSource,
  parseChangedFilesFromDiff,
  resolveDefaultBase,
  runProjectReview,
} from "../src/review.js";

const roots = [];

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function tempDir(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function reviewFixture() {
  const root = await tempDir("dev-assistant-review-");
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "docs"));
  writeFileSync(
    join(root, "README.md"),
    "# Архитектура\n\nКоманды разбираются в src/cli.js, функция parseCommand.\n",
  );
  writeFileSync(join(root, "docs", "guide.md"), "# Гайд\n\nИсходники в каталоге src.\n");
  writeFileSync(join(root, "src", "cli.js"), "export function parseCommand(line) {\n  return line;\n}\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.email=dev@example.com", "-c", "user.name=dev", "commit", "-m", "init"],
    { cwd: root },
  );
  writeFileSync(
    join(root, "src", "cli.js"),
    "export function parseCommand(line) {\n  // TODO: validate\n  return line;\n}\n",
  );
  execFileSync("git", ["add", "src/cli.js"], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.email=dev@example.com", "-c", "user.name=dev", "commit", "-m", "add todo"],
    { cwd: root },
  );
  await indexProjectDocs(root);
  return root;
}

describe("review diff", () => {
  it("читает patch из файла и по URL", async () => {
    const root = await tempDir("dev-assistant-diff-file-");
    const patch = [
      "diff --git a/src/a.js b/src/a.js",
      "--- a/src/a.js",
      "+++ b/src/a.js",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const patchPath = join(root, "change.patch");
    writeFileSync(patchPath, patch);
    const fromFile = await loadDiffSource(patchPath);
    assert.equal(fromFile, patch);
    assert.deepEqual(parseChangedFilesFromDiff(fromFile), ["src/a.js"]);

    const fromUrl = await loadDiffSource("https://api.github.com/pulls/1.diff", {
      fetch: async () => ({
        ok: true,
        text: async () => patch,
      }),
    });
    assert.equal(fromUrl, patch);

    const { changedFiles, diffText } = await collectReviewDiff(root, { diffSource: patchPath });
    assert.deepEqual(changedFiles, ["src/a.js"]);
    assert.match(diffText, /\+new/);
  });

  it("использует origin/main, если локальной main нет", async () => {
    const root = await tempDir("dev-assistant-origin-main-");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "README.md"), "# doc\n");
    writeFileSync(join(root, "src", "x.js"), "export const v = 1;\n");
    execFileSync("git", ["init", "-b", "main"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync(
      "git",
      ["-c", "user.email=dev@example.com", "-c", "user.name=dev", "commit", "-m", "base"],
      { cwd: root },
    );
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    execFileSync("git", ["checkout", "-b", "feature"], { cwd: root });
    writeFileSync(join(root, "src", "x.js"), "export const v = 2;\n");
    execFileSync("git", ["add", "src/x.js"], { cwd: root });
    execFileSync(
      "git",
      ["-c", "user.email=dev@example.com", "-c", "user.name=dev", "commit", "-m", "feature"],
      { cwd: root },
    );
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", baseSha], { cwd: root });
    execFileSync("git", ["branch", "-D", "main"], { cwd: root });

    assert.equal(await resolveDefaultBase(root), "origin/main");
    const { changedFiles, diffText } = await collectRangeDiff(root);
    assert.ok(changedFiles.includes("src/x.js"));
    assert.match(diffText, /v = 2/);
  });

  it("на main без коммитов берёт незакоммиченные правки", async () => {
    const root = await tempDir("dev-assistant-wt-");
    writeFileSync(join(root, "README.md"), "# x\n");
    execFileSync("git", ["init", "-b", "main"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync(
      "git",
      ["-c", "user.email=dev@example.com", "-c", "user.name=dev", "commit", "-m", "init"],
      { cwd: root },
    );
    writeFileSync(join(root, "README.md"), "# changed\n");
    const { changedFiles, diffText, range } = await collectRangeDiff(root);
    assert.equal(range.mode, "working-tree");
    assert.ok(changedFiles.includes("README.md"));
    assert.match(diffText, /changed/);
  });

  it("собирает diff диапазона и запрос для RAG", async () => {
    const root = await reviewFixture();
    const base = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: root, encoding: "utf8" }).trim();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const { changedFiles, diffText } = await collectRangeDiff(root, { base, head });
    assert.ok(changedFiles.includes("src/cli.js"));
    assert.match(diffText, /TODO/);
    const query = buildReviewQuery(changedFiles, diffText);
    assert.match(query, /src\/cli\.js/);
    assert.ok(detectBugMarkers(diffText).length > 0);
  });
});

describe("runProjectReview", () => {
  it("без модели возвращает три раздела, файл и источник README", async () => {
    const root = await reviewFixture();
    const base = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: root, encoding: "utf8" }).trim();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const result = await runProjectReview(root, { base, head, allowModel: false });
    assert.match(result.reply, /## Потенциальные баги/);
    assert.match(result.reply, /## Архитектурные проблемы/);
    assert.match(result.reply, /## Рекомендации/);
    assert.match(result.reply, /src\/cli\.js/);
    assert.match(result.reply, /README\.md \|/);
    assert.equal(result.usedModel, false);
  });

  it("передаёт diff и попадания в generate", async () => {
    const root = await reviewFixture();
    const base = execFileSync("git", ["rev-parse", "HEAD~1"], { cwd: root, encoding: "utf8" }).trim();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    let payload;
    const result = await runProjectReview(root, {
      base,
      head,
      generate: async (ctx) => {
        payload = ctx;
        return "## Потенциальные баги\nok\n\n## Архитектурные проблемы\n-\n\n## Рекомендации\n-";
      },
    });
    assert.ok(payload?.diffText?.includes("TODO"));
    assert.ok(payload?.docHits?.length || payload?.codeHits?.length);
    assert.match(result.reply, /Потенциальные баги/);
    assert.equal(result.usedModel, true);
  });
});

describe("npm run review", () => {
  it("без аргумента берёт корень из connection.json", async () => {
    const project = await reviewFixture();
    const connFile = connectionPath(cliRoot);
    const backup = existsSync(connFile) ? readFileSync(connFile) : null;
    saveConnection(project);
    try {
      const script = join(cliRoot, "scripts", "ai-review.js");
      const out = execFileSync("node", [script], {
        cwd: cliRoot,
        encoding: "utf8",
      });
      assert.match(out, /## Потенциальные баги/);
      assert.match(out, /src\/cli\.js/);
    } finally {
      if (backup) writeFileSync(connFile, backup);
      else rmSync(connFile, { force: true });
    }
  });
});
