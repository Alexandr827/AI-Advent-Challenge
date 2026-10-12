import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { helpText, parseCommand } from "../src/cli.js";
import {
  changeConnection,
  clearConnection,
  readConnection,
  requireConnection,
  saveConnection,
} from "../src/connection.js";
import { loadDocument } from "../src/rag/load.js";
import {
  collectProjectDocs,
  indexProjectDocs,
  retrieveProjectContext,
} from "../src/rag/project.js";
import { gitBranch, gitDiff, listFiles } from "../src/mcp-project.js";
import { answerProjectHelp } from "../src/assistant.js";

const roots = [];

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function tempDir(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function fixture() {
  const root = await tempDir("dev-assistant-");
  mkdirSync(join(root, "docs"));
  mkdirSync(join(root, "db"));
  mkdirSync(join(root, "node_modules"));
  mkdirSync(join(root, "data"));
  writeFileSync(
    join(root, "README.md"),
    "# Структура\n\nКаталог src хранит CLI. PROJECT_LAYOUT_MARKER. Команды: spawn, ask, /help.\n",
  );
  writeFileSync(
    join(root, "docs", "guide.md"),
    "# Обзор\n\nДокументация проекта лежит в каталоге docs.\n",
  );
  writeFileSync(
    join(root, "db", "schema.sql"),
    "CREATE TABLE tasks (id INTEGER PRIMARY KEY);\n",
  );
  writeFileSync(
    join(root, "openapi.yaml"),
    "openapi: 3.0.0\ninfo:\n  title: Tasks API\npaths:\n  /tasks:\n    get:\n      summary: list tasks\n",
  );
  writeFileSync(join(root, "node_modules", "openapi.json"), "{ \"openapi\": \"3.0.0\" }\n");
  writeFileSync(join(root, "data", "secret.sql"), "CREATE TABLE secret (id INTEGER);\n");
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.email=dev@example.com", "-c", "user.name=dev", "commit", "-m", "init"],
    { cwd: root },
  );
  return root;
}

describe("connect", () => {
  it("разбирает connect и запоминает корень проекта", async () => {
    assert.deepEqual(parseCommand('connect "/tmp/my project"'), {
      type: "connect",
      path: "/tmp/my project",
    });
    assert.throws(() => parseCommand("connect"), /connect <путь>/);

    const cli = await tempDir("dev-assistant-cli-");
    const project = await fixture();
    assert.equal(readConnection(cli), null);
    assert.throws(() => requireConnection(cli), /Сначала подключите проект/);
    const saved = saveConnection(project, cli);
    assert.equal(readConnection(cli), saved);
    assert.equal(requireConnection(cli), project);
  });

  it("отключает только активный путь и переключает проект", async () => {
    assert.deepEqual(parseCommand("disconnect /tmp/proj"), {
      type: "disconnect",
      path: "/tmp/proj",
    });
    assert.deepEqual(parseCommand("change connect /tmp/other"), {
      type: "change-connect",
      path: "/tmp/other",
    });
    assert.deepEqual(parseCommand("whereami"), { type: "whereami" });
    assert.throws(() => parseCommand("whereami extra"), /whereami/);
    assert.throws(() => parseCommand("change"), /change connect/);
    assert.match(helpText(), /disconnect <путь>/);
    assert.match(helpText(), /change connect <путь>/);
    assert.match(helpText(), /whereami/);

    const cli = await tempDir("dev-assistant-cli-");
    const first = await fixture();
    const second = await fixture();
    saveConnection(first, cli);
    assert.throws(() => clearConnection(second, cli), /другой проект/);
    assert.equal(clearConnection(first, cli), first);
    assert.equal(readConnection(cli), null);

    const switched = changeConnection(second, cli);
    assert.equal(switched.previous, null);
    assert.equal(switched.path, second);
    assert.throws(() => changeConnection(second, cli), /Уже подключён/);
    const again = changeConnection(first, cli);
    assert.equal(again.previous, second);
    assert.equal(again.path, first);
    assert.equal(readConnection(cli), first);
  });
});

describe("project docs RAG", () => {
  it("собирает README, docs, схему и API и не заходит в data и node_modules", async () => {
    const root = await fixture();
    assert.deepEqual(collectProjectDocs(root), [
      "README.md",
      "db/schema.sql",
      "docs/guide.md",
      "openapi.yaml",
    ]);
    const sql = await loadDocument("db/schema.sql", { root });
    const api = await loadDocument("openapi.yaml", { root });
    assert.equal(sql.role, "schema");
    assert.equal(sql.kind, "sql");
    assert.equal(api.role, "api");
    assert.equal(api.kind, "yaml");

    const indexed = await indexProjectDocs(root);
    assert.equal(existsSync(join(root, "data", "doc-index", "law.sqlite")), false);
    assert.equal(existsSync(join(root, "data", "doc-index", "corpus.sqlite")), false);
    assert.deepEqual(
      indexed.manifest.files.map((file) => [file.path, file.role]),
      [
        ["README.md", "doc"],
        ["db/schema.sql", "schema"],
        ["docs/guide.md", "doc"],
        ["openapi.yaml", "api"],
      ],
    );

    const found = retrieveProjectContext("как устроена структура каталогов", {
      indexPath: indexed.dbPath,
    });
    assert.ok(
      found.hits.some(
        (hit) => hit.file === "README.md" && hit.text.includes("PROJECT_LAYOUT_MARKER"),
      ),
    );
  });
});

describe("project MCP tools", () => {
  it("отдаёт ветку, список файлов и diff только внутри корня", async () => {
    const root = await fixture();
    const branch = await gitBranch(root, { root });
    assert.equal(branch.ok, true);
    assert.equal(branch.text, "main");

    const files = listFiles(root, { root });
    assert.equal(files.ok, true);
    assert.match(files.text, /^README\.md$/m);
    assert.match(files.text, /^docs\/guide\.md$/m);
    assert.match(files.text, /^db\/schema\.sql$/m);
    assert.doesNotMatch(files.text, /secret\.sql/);
    assert.doesNotMatch(files.text, /node_modules/);

    writeFileSync(
      join(root, "README.md"),
      "# Структура\n\nКаталог src хранит CLI. PROJECT_LAYOUT_MARKER. Команды: spawn, ask, /help.\nDIFF_MARKER\n",
    );
    const diff = await gitDiff(root, { root });
    assert.equal(diff.ok, true);
    assert.match(diff.text, /DIFF_MARKER/);

    const outside = await tempDir("dev-assistant-out-");
    const denied = await gitBranch(outside, { root });
    assert.equal(denied.ok, false);
    assert.match(denied.text, /внутри каталога проекта/);
  });
});

describe("/help", () => {
  it("отделяет /help от списка команд", () => {
    assert.equal(parseCommand("help").type, "help");
    assert.deepEqual(parseCommand("/help как устроена структура"), {
      type: "project-help",
      text: "как устроена структура",
    });
    assert.equal(parseCommand("/help").text, "");
    assert.match(helpText(), /\/help <вопрос>/);
  });

  it("отвечает по индексу и контексту MCP без модели", async () => {
    const root = await fixture();
    const calls = [];
    const result = await answerProjectHelp("как устроена структура проекта", {
      root,
      allowModel: false,
      callTool: async ({ name }) => {
        calls.push(name);
        const text = name === "git_branch" ? "main" : "README.md\ndocs/guide.md\nsrc/cli.js";
        return { content: [{ type: "text", text }] };
      },
    });
    assert.deepEqual(calls, ["git_branch", "list_files"]);
    assert.equal(result.usedModel, false);
    assert.match(result.reply, /PROJECT_LAYOUT_MARKER/);
    assert.match(result.reply, /README\.md \| Структура/);
    assert.match(result.reply, /Ветка: main/);
    assert.match(result.reply, /src\/cli\.js/);
  });

  it("без вопроса показывает подключение, а вопрос про ветку запрашивает diff", async () => {
    const root = await fixture();
    const connected = await answerProjectHelp("", {
      root,
      allowModel: false,
      callTool: async ({ name }) => ({
        content: [{ type: "text", text: name === "git_branch" ? "main" : "README.md" }],
      }),
    });
    assert.match(connected.reply, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(connected.reply, /project-mcp/);
    assert.match(connected.reply, /git_branch, list_files, git_diff/);
    assert.match(connected.reply, /README\.md \(doc\)/);
    assert.match(connected.reply, /db\/schema\.sql \(schema\)/);
    assert.match(connected.reply, /openapi\.yaml \(api\)/);
    assert.match(connected.reply, /Ветка: main/);

    const calls = [];
    const generated = await answerProjectHelp("какая ветка и что в diff", {
      root,
      generate: async () => "Сейчас ветка main.",
      callTool: async ({ name }) => {
        calls.push(name);
        const text = name === "git_diff" ? "Изменений нет." : "main";
        return { content: [{ type: "text", text }] };
      },
    });
    assert.deepEqual(calls, ["git_branch", "list_files", "git_diff"]);
    assert.equal(generated.usedModel, true);
    assert.match(generated.reply, /Сейчас ветка main/);
    assert.match(generated.reply, /Diff:\nИзменений нет/);
  });
});
