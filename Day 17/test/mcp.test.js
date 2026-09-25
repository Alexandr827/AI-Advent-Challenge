import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { connectMcp, listMcpTools, projectMcpServers } from "../src/mcp-client.js";
import {
  collectRunEvents,
  extractToolText,
  foldRunEvent,
  formatToolTrace,
  normalizeToolEvent,
  toolMatches,
} from "../src/mcp-trace.js";
import {
  CITY_TIMEZONES,
  formatCityTimes,
  formatDeviceTime,
  gitStatus,
} from "../src/mcp-server.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function toolText(result) {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

describe("mcp agent wiring", () => {
  it("points the agent at the project MCP server", () => {
    const servers = projectMcpServers(repoRoot);
    const demo = servers["demo-mcp"];
    assert.equal(demo.type, "stdio");
    assert.equal(demo.command, process.execPath);
    assert.equal(demo.cwd, repoRoot);
    assert.equal(demo.args[0].endsWith("mcp-server.js"), true);
  });

  it("reads an MCP tool result out of a completed tool_call", () => {
    const event = {
      type: "tool_call",
      name: "mcp",
      status: "completed",
      call_id: "call-1",
      args: {
        toolName: "add",
        providerIdentifier: "demo-mcp",
        args: { a: 17, b: 25 },
      },
      result: {
        status: "success",
        value: {
          content: [{ text: { text: "42" } }],
          isError: false,
        },
      },
    };
    const call = normalizeToolEvent(event);
    assert.equal(call.tool, "add");
    assert.deepEqual(call.arguments, { a: 17, b: 25 });
    assert.equal(call.resultText, "42");
    assert.equal(extractToolText({ content: [{ type: "text", text: "42" }] }), "42");
    assert.equal(toolMatches(call, "add"), true);
    assert.match(formatToolTrace(call), /MCP add completed/);

    const state = { offered: [], calls: [] };
    foldRunEvent(state, { type: "tool_call", name: "mcp", status: "running", call_id: "call-1", args: event.args });
    foldRunEvent(state, event);
    assert.equal(state.calls.length, 1);
    assert.equal(state.calls[0].status, "completed");
    assert.equal(state.calls[0].resultText, "42");
  });

  it("collects a stream into one completed MCP call", async () => {
    const args = {
      toolName: "git_status",
      providerIdentifier: "demo-mcp",
      args: { repo: repoRoot },
    };
    async function* stream() {
      yield { type: "system", subtype: "init", tools: ["mcp"], run_id: "run-1" };
      yield { type: "tool_call", name: "mcp", status: "running", call_id: "call-git", args };
      yield {
        type: "tool_call",
        name: "mcp",
        status: "completed",
        call_id: "call-git",
        args,
        result: {
          status: "success",
          value: { content: [{ text: { text: "## main" } }] },
        },
      };
    }
    const log = await collectRunEvents({
      id: "run-1",
      supports: () => true,
      stream,
    });
    assert.deepEqual(log.offered, ["mcp"]);
    assert.equal(log.runId, "run-1");
    assert.equal(log.calls.length, 1);
    assert.equal(log.calls[0].tool, "git_status");
    assert.equal(log.calls[0].resultText, "## main");
    assert.match(formatToolTrace(log.calls[0]), /MCP git_status completed → ## main/);
  });
});

describe("mcp connection", () => {
  let client;

  after(async () => {
    if (client) await client.close();
  });

  it("connects and lists tools from the local MCP server", async () => {
    client = await connectMcp();
    const tools = await listMcpTools(client);
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "add",
      "city_time",
      "device_time",
      "echo",
      "git_status",
    ]);
    assert.ok(tools.every((tool) => typeof tool.description === "string"));
  });

  it("device_time returns the machine clock and timezone", async () => {
    client = client ?? (await connectMcp());
    const result = await client.callTool({ name: "device_time", arguments: {} });
    const text = toolText(result);
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} GMT[+-]\d/);
    assert.ok(text.includes(`(${tz})`));
    assert.match(formatDeviceTime(), new RegExp(`\\(${tz}\\)`));
  });

  it("city_time returns Moscow and Beijing time with zones", async () => {
    client = client ?? (await connectMcp());
    const result = await client.callTool({ name: "city_time", arguments: {} });
    const text = toolText(result);
    assert.match(text, /Москва:/);
    assert.match(text, /Пекин:/);
    assert.match(text, /Europe\/Moscow/);
    assert.match(text, /Asia\/Shanghai/);
    assert.equal(CITY_TIMEZONES.moscow.timeZone, "Europe/Moscow");
    assert.equal(CITY_TIMEZONES.beijing.timeZone, "Asia/Shanghai");
    assert.match(formatCityTimes(), /GMT\+0?3/);
    assert.match(formatCityTimes(), /GMT\+0?8/);
  });

  it("git_status describes repo and returns git status", async () => {
    client = client ?? (await connectMcp());
    const tools = await listMcpTools(client);
    const tool = tools.find((item) => item.name === "git_status");
    assert.ok(tool);
    assert.match(tool.description, /git status/);
    const repoField = tool.inputSchema?.properties?.repo;
    assert.equal(repoField?.type, "string");
    assert.equal(typeof repoField?.description, "string");
    assert.ok(repoField.description.length > 0);

    const result = await client.callTool({
      name: "git_status",
      arguments: { repo: repoRoot },
    });
    const expected = execFileSync(
      "git",
      ["status", "--porcelain=v1", "-b"],
      { cwd: repoRoot, encoding: "utf8" },
    ).replace(/\s+$/u, "");
    assert.equal(toolText(result), expected);
    assert.notEqual(result.isError, true);

    const direct = await gitStatus(repoRoot);
    assert.equal(direct.ok, true);
    assert.equal(direct.text, expected);
  });

  it("git_status returns an error for a path that is not a repository", async () => {
    client = client ?? (await connectMcp());
    const empty = await mkdtemp(join(tmpdir(), "mcp-git-"));
    try {
      const result = await client.callTool({
        name: "git_status",
        arguments: { repo: empty },
      });
      assert.equal(result.isError, true);
      assert.match(toolText(result), /not a git repository/i);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
