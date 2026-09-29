import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { LlmAgent } from "../src/agent.js";
import { helpText, parseAskCommand, parseCommand } from "../src/cli.js";
import { connectMcp, formatMcpCatalog, listMcpCatalog, listMcpTools } from "../src/mcp-client.js";
import {
  PIPELINE_ASK_EXAMPLES,
  parseAskMcpRequest,
  planMcpFromAsk,
  runAskMcpRequest,
  featureSlug,
  runFeaturePipeline,
  saveFeatureFile,
  searchFeature,
  summarizeFeature,
  toolText,
} from "../src/mcp-pipeline.js";
import { parsePipelineArgs, runPipelineCli } from "../scripts/mcp-pipeline.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

describe("feature pipeline functions", () => {
  it("finds a known symbol and summarizes it with a README quote", () => {
    const search = searchFeature("git_status", { root: repoRoot });
    assert.equal(search.ok, true);
    const data = JSON.parse(search.text);
    assert.equal(data.feature, "git_status");
    assert.equal(data.query, "git_status");
    const hit = data.hits.find((row) => row.file === "src/mcp-server.js");
    assert.ok(hit);
    assert.match(hit.excerpt, /git_status/);

    const summary = summarizeFeature(search.text, { root: repoRoot });
    assert.equal(summary.ok, true);
    assert.match(summary.text, new RegExp(hit.excerpt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const quote = summary.text
      .split("\n")
      .find((line) => line.startsWith("> ") && line.length > 12);
    assert.ok(quote);
    const snippet = quote.slice(2, 42);
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    assert.ok(readme.includes(snippet));
  });

  it("returns an empty hit list without an error", () => {
    const token = `no_such_${Date.now()}_feature`;
    const search = searchFeature(token, { root: repoRoot });
    const data = JSON.parse(search.text);
    assert.deepEqual(data.hits, []);
    assert.equal(search.ok, true);
    const summary = summarizeFeature(search.text, { root: repoRoot });
    assert.equal(summary.ok, true);
    assert.match(summary.text, /Найдено: 0/);
  });

  it("rejects invalid summarize JSON and summarizes plain text", () => {
    const broken = summarizeFeature("{", { root: repoRoot });
    assert.equal(broken.ok, false);
    assert.match(broken.text, /невалидный JSON/);
    const plain = summarizeFeature("Вот тебе текст А", { root: repoRoot });
    assert.equal(plain.ok, true);
    assert.match(plain.text, /текст А/);
  });

  it("writes НАЗВАНИЕ_ФИЧИ.md and refuses a path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-pipeline-"));
    try {
      const saved = saveFeatureFile(
        { feature: "НАЗВАНИЕ ФИЧИ", content: "сводка\n" },
        { root: dir },
      );
      assert.equal(saved.ok, true);
      assert.equal(readFileSync(join(dir, "НАЗВАНИЕ_ФИЧИ.md"), "utf8"), "сводка\n");
      const described = saveFeatureFile(
        { feature: "стратегия", content: "# стратегия\n\nНайдено: 1\n", summarized: true },
        { root: dir },
      );
      assert.equal(described.ok, true);
      const describedText = readFileSync(join(dir, "стратегия.md"), "utf8");
      assert.match(describedText, /## Описание/);
      assert.match(describedText, /summarize_feature/);
      assert.match(describedText, /## Результаты/);
      assert.match(describedText, /Найдено: 1/);
      assert.equal(featureSlug("git status"), "git_status");

      const blocked = saveFeatureFile({ feature: "../", content: "x" }, { root: dir });
      assert.equal(blocked.ok, false);
      assert.match(blocked.text, /путь/);
      assert.deepEqual(readdirSync(dir).sort(), ["НАЗВАНИЕ_ФИЧИ.md", "стратегия.md"]);

      const outside = saveFeatureFile(
        { feature: "../secret", content: "x" },
        { root: dir },
      );
      assert.equal(outside.ok, false);
      assert.equal(existsSync(join(dir, "..", "secret.md")), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stops the chain when summarize returns isError and does not write a file", async () => {
    const calls = [];
    const file = join(repoRoot, "chain_stop_probe.md");
    await rm(file, { force: true });
    const result = await runFeaturePipeline(
      async (req) => {
        calls.push(req.name);
        if (req.name === "summarize_feature") {
          return {
            isError: true,
            content: [{ type: "text", text: "summarize_feature: невалидный JSON в search" }],
          };
        }
        return {
          isError: false,
          content: [{ type: "text", text: "{\"feature\":\"chain_stop_probe\",\"query\":\"chain_stop_probe\",\"hits\":[]}\n" }],
        };
      },
      { query: "chain_stop_probe" },
    );
    assert.equal(result.ok, false);
    assert.deepEqual(calls, ["search_feature", "summarize_feature"]);
    assert.equal(existsSync(file), false);
  });
});

describe("feature pipeline CLI", () => {
  it("parses one step and the full query", () => {
    assert.deepEqual(parsePipelineArgs(["--step", "search", "--query", "git_status"]), {
      step: "search",
      query: "git_status",
      searchFile: "",
      search: "",
      feature: "",
      contentFile: "",
      content: "",
    });
  });

  it("runs only the requested step", async () => {
    const calls = [];
    const result = await runPipelineCli(["--step", "search", "--query", "git_status"], {
      callTool: async (req) => {
        calls.push(req);
        return { content: [{ type: "text", text: "only-search\n" }] };
      },
      log() {},
      error() {},
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "search_feature");
    assert.deepEqual(calls[0].arguments, { query: "git_status" });
  });

  it("parses REPL feature commands and lists terminal commands in help", () => {
    assert.deepEqual(parseCommand("feature search git status"), {
      type: "feature",
      action: "search",
      query: "git status",
    });
    assert.deepEqual(parseCommand("feature summarize"), {
      type: "feature",
      action: "summarize",
    });
    assert.deepEqual(parseCommand("feature save"), {
      type: "feature",
      action: "save",
    });
    assert.deepEqual(parseCommand("feature run git_status"), {
      type: "feature",
      action: "run",
      query: "git_status",
    });
    assert.deepEqual(
      parseAskCommand([
        "pipeline",
        "--mcp",
        "найти",
        "фичу",
        "стратегия",
      ]),
      {
        type: "ask",
        target: "pipeline",
        mcp: true,
        rag: undefined,
        text: "найти фичу стратегия",
      },
    );
    assert.equal(parseCommand("ask pipeline --no-mcp просто текст").mcp, false);
    assert.equal(parseCommand("ask pipeline просто текст").mcp, undefined);
    assert.deepEqual(parseCommand("mcp"), { type: "mcp" });
    assert.deepEqual(parseCommand("mcp list"), { type: "mcp" });
    const help = helpText();
    assert.match(help, /--mcp\|--no-mcp/);
    assert.match(help, /^ {2}mcp /m);
    assert.match(help, /mcp-tool summarize/);
    assert.match(help, /search, summarize и save/);
    for (const line of PIPELINE_ASK_EXAMPLES) {
      assert.ok(help.includes(line));
    }
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    for (const line of PIPELINE_ASK_EXAMPLES) {
      assert.ok(readme.includes(line), line);
    }
    assert.match(readme, /ask/);
  });
});

describe("ask calls the named mcp tool", () => {
  it("parses one tool and a chain from the ask text", () => {
    assert.deepEqual(
      parseAskMcpRequest("Вот тебе текст А, прогони через mcp-tool summarize"),
      {
        tools: ["summarize_feature"],
        payload: "Вот тебе текст А",
        feature: "",
      },
    );
    assert.deepEqual(
      parseAskMcpRequest("прогони git_status через mcp-tool search, summarize и save"),
      {
        tools: ["search_feature", "summarize_feature", "saveToFile"],
        payload: "git_status",
        feature: "",
      },
    );
    assert.equal(parseAskMcpRequest("просто спроси статус"), null);
    assert.equal(planMcpFromAsk("найти фичу стратегия и сохрани", { mcp: false }), null);
    const planned = planMcpFromAsk(
      "найти в проекте nodejsproject про реализацию фичи стратегия, краткой резюмируй и сохрани в виде файла в папке проекта",
      { mcp: true },
    );
    assert.deepEqual(planned.tools, ["search_feature", "summarize_feature", "saveToFile"]);
    assert.equal(planned.payload, "стратегия");
    assert.equal(planned.feature, "стратегия");
  });

  it("passes the previous tool text into the next", async () => {
    const calls = [];
    const result = await runAskMcpRequest(
      {
        tools: ["search_feature", "summarize_feature"],
        payload: "git_status",
        feature: "",
      },
      async (req) => {
        calls.push(req);
        if (req.name === "search_feature") {
          return { content: [{ type: "text", text: "search-body" }] };
        }
        return { content: [{ type: "text", text: "summary-body" }] };
      },
    );
    assert.equal(result.ok, true);
    assert.equal(calls[1].arguments.search, "search-body");
    assert.equal(result.steps[1].text, "summary-body");
  });

  it("ask runs only summarize and does not call the model", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-ask-"));
    writeFileSync(join(dir, "README.md"), "readme\n", "utf8");
    const agent = new LlmAgent({
      id: "1",
      name: "pipe",
      model: "composer-2.5",
      runtime: "local",
      apiKey: "test-key",
      cwd: dir,
      compress: false,
    });
    const { reply, tools } = await agent.ask(
      "Вот тебе текст А, прогони через mcp-tool summarize",
    );
    assert.equal(tools.calls.length, 1);
    assert.equal(tools.calls[0].tool, "summarize_feature");
    assert.equal(tools.calls[0].arguments.search, "Вот тебе текст А");
    assert.match(reply, /mcp-tool summarize_feature отработал/);
    assert.match(reply, /mcp-client → mcp-server/);
    assert.doesNotMatch(reply, /search_feature отработал/);
    assert.match(reply, /текст А/);
    assert.equal(agent.status, "ready");
    await rm(dir, { recursive: true, force: true });
  });

  it("ask runs search, summarize and save in one request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-ask-chain-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "demo.js"), "export function city_time() {}\n", "utf8");
    writeFileSync(join(dir, "README.md"), "Инструмент city_time показывает время городов.\n", "utf8");
    const agent = new LlmAgent({
      id: "1",
      name: "pipe",
      model: "composer-2.5",
      runtime: "local",
      apiKey: "test-key",
      cwd: dir,
      compress: false,
    });
    const { reply, tools } = await agent.ask(
      "прогони city_time через mcp-tool search, summarize и save",
    );
    assert.deepEqual(
      tools.calls.map((call) => call.tool),
      ["search_feature", "summarize_feature", "saveToFile"],
    );
    assert.equal(tools.calls[1].arguments.search, tools.calls[0].resultText);
    assert.equal(tools.calls[2].arguments.content, tools.calls[1].resultText);
    const cityFile = readFileSync(join(dir, "city_time.md"), "utf8");
    assert.match(cityFile, /## Описание/);
    assert.match(cityFile, /## Результаты/);
    assert.ok(cityFile.includes(tools.calls[1].resultText.trim()));
    assert.match(reply, /mcp-tool search_feature отработал/);
    assert.match(reply, /mcp-tool summarize_feature отработал/);
    assert.match(reply, /mcp-tool saveToFile отработал/);
    assert.match(reply, /Сохранено:/);
    await rm(dir, { recursive: true, force: true });
  });

  it("ask --mcp runs search, summarize and save for a feature sentence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-ask-strategy-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "src", "strategy.js"),
      "export const strategy = \"стратегия контекста\";\n",
      "utf8",
    );
    writeFileSync(join(dir, "README.md"), "Стратегия контекста описана в strategy.js.\n", "utf8");
    const agent = new LlmAgent({
      id: "1",
      name: "pipeline",
      model: "composer-2.5",
      runtime: "local",
      apiKey: "test-key",
      cwd: dir,
      compress: false,
    });
    const { reply, tools } = await agent.ask(
      "найти в проекте nodejsproject про реализацию фичи стратегия, краткой резюмируй и сохрани в виде файла в папке проекта. Напиши где именно сохранил суммаризированный файл",
      { mcp: true },
    );
    assert.deepEqual(
      tools.calls.map((call) => call.tool),
      ["search_feature", "summarize_feature", "saveToFile"],
    );
    assert.equal(tools.calls[1].arguments.search, tools.calls[0].resultText);
    assert.equal(tools.calls[2].arguments.content, tools.calls[1].resultText);
    const saved = join(dir, "стратегия.md");
    const savedText = readFileSync(saved, "utf8");
    assert.match(savedText, /## Описание/);
    assert.match(savedText, /## Результаты/);
    assert.ok(savedText.includes(tools.calls[1].resultText.trim()));
    assert.match(reply, /mcp-tool saveToFile отработал/);
    assert.match(reply, /Сохранено:/);
    assert.match(reply, /стратегия\.md/);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("feature pipeline over MCP", () => {
  let client;

  after(async () => {
    if (client) await client.close();
    await rm(join(process.cwd(), "solo_save.md"), { force: true });
    await rm(join(process.cwd(), "solo_search_token_xyz.md"), { force: true });
  });

  it("lists demo-mcp and the tools registered on it", async () => {
    const catalog = await listMcpCatalog(repoRoot);
    const text = formatMcpCatalog(catalog);
    assert.match(text, /^demo-mcp \(stdio\)/m);
    assert.match(text, /search_feature:/);
    assert.match(text, /summarize_feature:/);
    assert.match(text, /saveToFile:/);
    assert.match(text, /git_status:/);
  });

  it("lists the three tools", async () => {
    client = await connectMcp();
    const tools = await listMcpTools(client);
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes("search_feature"));
    assert.ok(names.includes("summarize_feature"));
    assert.ok(names.includes("saveToFile"));
    assert.equal(names.includes("pipeline"), false);
    const search = tools.find((tool) => tool.name === "search_feature");
    assert.equal(search.inputSchema.properties.query.type, "string");
    const summary = tools.find((tool) => tool.name === "summarize_feature");
    assert.equal(summary.inputSchema.properties.search.type, "string");
    const save = tools.find((tool) => tool.name === "saveToFile");
    assert.equal(save.inputSchema.properties.feature.type, "string");
    assert.equal(save.inputSchema.properties.content.type, "string");
  });

  it("does not run the other tools from a single call", async () => {
    client = client ?? (await connectMcp());
    const searchFile = join(process.cwd(), "solo_search_token_xyz.md");
    await rm(searchFile, { force: true });
    const search = await client.callTool({
      name: "search_feature",
      arguments: { query: "solo_search_token_xyz" },
    });
    assert.notEqual(search.isError, true);
    assert.equal(existsSync(searchFile), false);

    const save = await client.callTool({
      name: "saveToFile",
      arguments: { feature: "solo_save" },
    });
    assert.equal(save.isError, true);
    assert.match(toolText(save), /content/);
    assert.doesNotMatch(toolText(save), /"hits"/);
    assert.equal(existsSync(join(process.cwd(), "solo_save.md")), false);
  });

  it("passes each tool's text into the next and writes the same summary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-pipeline-chain-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "demo.js"), "export function city_time() {}\n", "utf8");
    writeFileSync(join(dir, "README.md"), "Инструмент city_time показывает время городов.\n", "utf8");
    const local = await connectMcp({ cwd: dir });
    try {
      const result = await runFeaturePipeline((req) => local.callTool(req), {
        query: "city_time",
      });
      assert.equal(result.ok, true);
      assert.deepEqual(
        result.steps.map((step) => step.name),
        ["search_feature", "summarize_feature", "saveToFile"],
      );
      assert.equal(result.steps[1].arguments.search, result.steps[0].text);
      assert.equal(result.steps[2].arguments.content, result.steps[1].text);
      const file = join(dir, "city_time.md");
      const disk = readFileSync(file, "utf8");
      assert.match(disk, /## Описание/);
      assert.match(disk, /## Результаты/);
      assert.ok(disk.includes(result.steps[1].text.trim()));
      assert.match(result.steps[1].text, /city_time\(\)/);
      assert.match(result.steps[1].text, /время городов/);
      assert.match(result.steps[2].text, /Сохранено:/);
    } finally {
      await local.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stops on a real summarize error and does not write the file", async () => {
    client = client ?? (await connectMcp());
    const calls = [];
    const file = join(process.cwd(), "chain_stop_probe.md");
    await rm(file, { force: true });
    const result = await runFeaturePipeline(
      async (req) => {
        calls.push(req.name);
        if (req.name === "summarize_feature") {
          return client.callTool({
            name: "summarize_feature",
            arguments: { search: "{" },
          });
        }
        return client.callTool(req);
      },
      { query: "chain_stop_probe" },
    );
    assert.equal(result.ok, false);
    assert.equal(result.steps[1].isError, true);
    assert.deepEqual(calls, ["search_feature", "summarize_feature"]);
    assert.equal(existsSync(file), false);
  });
});
