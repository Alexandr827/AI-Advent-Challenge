import { Agent, CursorAgentError } from "@cursor/sdk";
import { createImportProjectTool } from "./tools.js";

function requireApiKey(): string {
  const key = process.env.CURSOR_API_KEY?.trim();
  if (!key) {
    console.error(
      "CURSOR_API_KEY is not set. Export your Cursor API key before running.",
    );
    process.exit(1);
  }
  return key;
}

export async function runGoal(goal: string, cwd: string): Promise<void> {
  const apiKey = requireApiKey();
  const modelId = process.env.CURSOR_MODEL ?? "composer-2.5";

  try {
    await using agent = await Agent.create({
      apiKey,
      model: { id: modelId },
      local: {
        cwd,
        settingSources: [],
        customTools: {
          import_project: createImportProjectTool(),
        },
      },
      disallowedTools: ["shell", "task", "webSearch", "webFetch", "generateImage"],
    });

    const run = await agent.send(goal);
    console.log(`run id: ${run.id}`);
    if (run.requestId) {
      console.log(`request id: ${run.requestId}`);
    }

    for await (const event of run.stream()) {
      switch (event.type) {
        case "assistant":
          for (const block of event.message.content) {
            if (block.type === "text") {
              process.stdout.write(block.text);
            }
          }
          break;
        case "tool_call":
          console.log(`\n[tool] ${event.name}: ${event.status}`);
          break;
        case "status":
          console.log(`\n[status] ${event.status}`);
          break;
        default:
          break;
      }
    }

    const result = await run.wait();
    console.log(`\n\n--- run finished: ${result.status} ---`);

    if (result.status === "error") {
      if (result.error?.message) {
        console.error(result.error.message);
      }
      process.exit(2);
    }

    if (result.status === "cancelled") {
      process.exit(2);
    }
  } catch (err) {
    if (err instanceof CursorAgentError) {
      console.error(`startup failed: ${err.message}`);
      if (err.isRetryable) {
        console.error("(retryable)");
      }
      process.exit(1);
    }
    throw err;
  }
}
