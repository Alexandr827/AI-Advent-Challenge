import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { connectMcp, listMcpTools } from "../src/mcp-client.js";
import {
  CITY_TIMEZONES,
  formatCityTimes,
  formatDeviceTime,
} from "../src/mcp-server.js";

function toolText(result) {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

describe("mcp connection", () => {
  let client;

  after(async () => {
    if (client) await client.close();
  });

  it("connects and lists tools from the local MCP server", async () => {
    client = await connectMcp();
    const tools = await listMcpTools(client);
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["add", "city_time", "device_time", "echo"]);
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
});
