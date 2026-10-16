import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const REVIEW_MARKER = "<!-- dev-assistant-review -->";

export async function upsertPrComment(cliRoot, number, body) {
  const text = `${REVIEW_MARKER}\n${body}`;
  const repo = process.env.REVIEW_TARGET_REPO?.trim() || process.env.GITHUB_REPOSITORY;
  if (!repo) return;
  const dataDir = resolve(cliRoot, "data");
  mkdirSync(dataDir, { recursive: true });
  const tmp = resolve(dataDir, "review-comment.md");
  writeFileSync(tmp, text, "utf8");
  try {
    const { stdout: listRaw } = await execFileAsync(
      "gh",
      ["api", `repos/${repo}/issues/${number}/comments`, "--paginate"],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    const comments = JSON.parse(listRaw);
    const existing = comments.find((item) => String(item.body ?? "").includes(REVIEW_MARKER));
    if (existing?.id) {
      const payloadPath = resolve(dataDir, "review-comment-payload.json");
      writeFileSync(payloadPath, JSON.stringify({ body: text }), "utf8");
      await execFileAsync(
        "gh",
        ["api", "--method", "PATCH", `repos/${repo}/issues/comments/${existing.id}`, "--input", payloadPath],
        { encoding: "utf8" },
      );
    } else {
      await execFileAsync("gh", ["pr", "comment", number, "--repo", repo, "--body-file", tmp], {
        encoding: "utf8",
      });
    }
  } catch (err) {
    console.error("Не удалось опубликовать комментарий в PR:", err?.message ?? err);
    process.exitCode = 0;
  }
}
