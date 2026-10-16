import { renameSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { featureSlug } from "./mcp-pipeline.js";
import { isMainModule, serveStdio } from "./mcp-serve.js";

function insideRoot(root, filePath) {
  const base = resolve(root);
  const target = resolve(filePath);
  const rel = relative(base, target);
  return rel !== "" && !rel.startsWith("..") && !rel.includes(sep);
}

export function saveBrief({ title, content }, { root }) {
  const raw = String(title ?? "").trim();
  if (!raw) return { ok: false, text: "save_brief: пустой title" };
  if (raw.includes("..") || raw.includes("/") || raw.includes("\\")) {
    return { ok: false, text: "save_brief: имя не должно содержать путь" };
  }
  if (content == null || String(content).trim() === "") {
    return { ok: false, text: "save_brief: пустой content" };
  }
  const slug = featureSlug(raw);
  if (!slug) return { ok: false, text: "save_brief: пустое имя файла" };
  const fileName = `${slug}.md`;
  const filePath = resolve(root, fileName);
  if (!insideRoot(root, filePath)) {
    return { ok: false, text: "save_brief: путь вне каталога проекта" };
  }
  const body = `# ${raw}\n\n${String(content).trim()}\n`;
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, filePath);
  return { ok: true, text: `Сохранено: ${filePath}`, path: filePath };
}

export function createBriefServer() {
  const server = new McpServer({
    name: "brief-mcp",
    version: "1.0.0",
  });

  server.registerTool(
    "save_brief",
    {
      description:
        "Пишет markdown-сводку <title>.md в корень каталога сервера. Путь в имени запрещён",
      inputSchema: z.object({
        title: z.string().describe("Заголовок и имя файла: пробелы станут _"),
        content: z.string().describe("Текст сводки из предыдущих шагов"),
      }),
    },
    async ({ title, content }) => {
      const result = saveBrief({ title, content }, { root: process.cwd() });
      return {
        content: [{ type: "text", text: result.text }],
        ...(result.ok ? {} : { isError: true }),
      };
    },
  );

  return server;
}

if (isMainModule(import.meta.url)) {
  await serveStdio(createBriefServer, "brief-mcp");
}
