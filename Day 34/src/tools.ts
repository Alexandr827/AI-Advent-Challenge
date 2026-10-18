import type { SDKCustomTool } from "@cursor/sdk";
import { projectRoots, resolveProjectSource } from "./discover.js";
import { takeBaseline } from "./diff.js";
import { writeOrigin } from "./save.js";
import { WORKSPACE_DIR } from "./paths.js";
import { importSource } from "./workspace.js";

export const ASSISTANT_PREFACE = [
  "If the user names a project, call import_project with that directory name before reading or editing any files.",
  "The tool copies the project into the workspace and leaves the original unchanged.",
  "Then complete the request using only the imported files.",
].join(" ");

export function createImportProjectTool(): SDKCustomTool {
  return {
    description: [
      "Copy a local project into the file-assistant workspace.",
      "Pass the project directory name, for example NodeJSproject, or an absolute path.",
      "Call this before reading or editing when the user names a project.",
      "The original project is not modified.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Project directory name, such as NodeJSproject, or an absolute path.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: {
      title: "Import project",
      destructiveHint: true,
      idempotentHint: true,
    },
    async execute(args) {
      const name = typeof args.name === "string" ? args.name : "";
      try {
        const source = await resolveProjectSource(name, projectRoots());
        const result = await importSource(source, WORKSPACE_DIR);
        await writeOrigin({ path: result.source, kind: result.kind });
        await takeBaseline(WORKSPACE_DIR);
        console.log(
          `\n[import] ${source} → ${result.copiedTo} (${result.files} files)`,
        );
        return `Imported ${result.files} files from ${source} into the workspace. The original project was not modified. Continue the task using the imported files.`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      }
    },
  };
}
