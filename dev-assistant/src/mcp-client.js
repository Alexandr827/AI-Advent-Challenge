import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export function mcpProjectScript() {
  return fileURLToPath(new URL("./mcp-project.js", import.meta.url));
}

export function projectMcpServer(cwd) {
  return {
    type: "stdio",
    command: process.execPath,
    args: [mcpProjectScript()],
    cwd,
  };
}

export async function connectProjectMcp(cwd) {
  const spec = projectMcpServer(cwd);
  const client = new Client({
    name: "project-mcp-client",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    stderr: "pipe",
  });
  await client.connect(transport);
  return client;
}
