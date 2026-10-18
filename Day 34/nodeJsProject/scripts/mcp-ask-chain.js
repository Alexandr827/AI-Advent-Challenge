import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LlmAgent } from "../src/agent.js";
import { formatMcpCatalog, listMcpCatalog } from "../src/mcp-client.js";
import { PIPELINE_ASK_EXAMPLES } from "../src/mcp-pipeline.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const agent = new LlmAgent({
  id: "1",
  name: "pipe",
  model: "composer-2.5",
  runtime: "local",
  apiKey: "unused",
  cwd: projectRoot,
  compress: false,
});

console.log("> mcp");
console.log(formatMcpCatalog(await listMcpCatalog(projectRoot)));
console.log("");

for (const example of PIPELINE_ASK_EXAMPLES) {
  const text = example.replace(/^ask <agent>\s+/u, "");
  console.log(`> ask pipe ${text}`);
  const { reply, tools } = await agent.ask(text);
  for (const call of tools.calls) {
    console.log(`MCP ${call.tool} ${call.status}`);
  }
  console.log(`→ ${agent.name}:`);
  console.log(String(reply ?? "").trimEnd());
  console.log("");
}
