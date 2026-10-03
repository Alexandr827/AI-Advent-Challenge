import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export function mcpScriptPath(fileName) {
  return fileURLToPath(new URL(`./${fileName}`, import.meta.url));
}

export function mcpServerPath() {
  return mcpScriptPath("mcp-server.js");
}

function stdioServer(fileName, cwd) {
  return {
    type: "stdio",
    command: process.execPath,
    args: [mcpScriptPath(fileName)],
    cwd,
  };
}

export function projectMcpServers(cwd = process.cwd()) {
  return {
    "demo-mcp": stdioServer("mcp-server.js", cwd),
    "weather-mcp": stdioServer("mcp-weather.js", cwd),
    "clock-mcp": stdioServer("mcp-clock.js", cwd),
    "brief-mcp": stdioServer("mcp-brief.js", cwd),
  };
}

export async function connectMcp(options = {}) {
  const client = new Client({
    name: options.clientName ?? "demo-mcp-client",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: options.command ?? process.execPath,
    args: options.args ?? [mcpServerPath()],
    stderr: options.stderr ?? "pipe",
    cwd: options.cwd,
    ...(options.env ? { env: options.env } : {}),
  });
  await client.connect(transport);
  return client;
}

export async function connectNamedMcp(name, cwd = process.cwd(), options = {}) {
  const spec = projectMcpServers(cwd)[name];
  if (!spec) {
    throw new Error(`MCP-сервер не зарегистрирован: ${name}`);
  }
  return connectMcp({
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd ?? cwd,
    env: spec.env,
    clientName: `${name}-client`,
    stderr: options.stderr,
  });
}

export async function listMcpTools(client) {
  const { tools } = await client.listTools();
  return tools;
}

export async function listMcpCatalog(cwd = process.cwd()) {
  const servers = projectMcpServers(cwd);
  const catalog = [];
  for (const [name, spec] of Object.entries(servers)) {
    const client = await connectMcp({
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd ?? cwd,
      env: spec.env,
      clientName: `${name}-client`,
    });
    try {
      const tools = await listMcpTools(client);
      catalog.push({
        name,
        type: spec.type ?? "stdio",
        command: spec.command ?? "",
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
        })),
      });
    } finally {
      await client.close();
    }
  }
  return catalog;
}

export function formatMcpCatalog(catalog) {
  const lines = [];
  for (const server of catalog ?? []) {
    lines.push(`${server.name} (${server.type})`);
    const tools = Array.isArray(server.tools) ? server.tools : [];
    if (!tools.length) {
      lines.push("  инструментов нет");
      continue;
    }
    for (const tool of tools) {
      lines.push(`  ${tool.name}: ${tool.description}`);
    }
  }
  return lines.join("\n");
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
