import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export function mcpServerPath() {
  return fileURLToPath(new URL("./mcp-server.js", import.meta.url));
}

export function projectMcpServers(cwd = process.cwd()) {
  return {
    "demo-mcp": {
      type: "stdio",
      command: process.execPath,
      args: [mcpServerPath()],
      cwd,
    },
  };
}

export async function connectMcp(options = {}) {
  const client = new Client({
    name: "demo-mcp-client",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: options.command ?? "node",
    args: options.args ?? [mcpServerPath()],
    stderr: options.stderr ?? "pipe",
  });
  await client.connect(transport);
  return client;
}

export async function listMcpTools(client) {
  const { tools } = await client.listTools();
  return tools;
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const client = await connectMcp({ stderr: "inherit" });
  try {
    const tools = await listMcpTools(client);
    console.log("MCP connected");
    console.log("tools:");
    for (const tool of tools) {
      console.log(`- ${tool.name}: ${tool.description ?? ""}`);
    }
    const status = await client.callTool({
      name: "git_status",
      arguments: {},
    });
    const text = (status.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    console.log("git_status:");
    console.log(text);
  } finally {
    await client.close();
  }
}
