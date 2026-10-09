import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export async function serveStdio(createServer, label) {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error(`${label} listening on stdio`);
}

export function isMainModule(importMetaUrl) {
  return (
    Boolean(process.argv[1]) &&
    importMetaUrl === pathToFileURL(resolve(process.argv[1])).href
  );
}
