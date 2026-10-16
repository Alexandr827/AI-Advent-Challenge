import { resolve } from "node:path";
import { cliRoot, requireConnection } from "../src/connection.js";
import { upsertPrComment } from "../src/review-comment.js";
import { runProjectReview } from "../src/review.js";

function parseArgv(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--root") {
      flags.root = argv[++i];
      continue;
    }
    if (token === "--diff") {
      flags.diff = argv[++i];
      continue;
    }
    if (token === "--base") {
      flags.base = argv[++i];
      continue;
    }
    if (token === "--head") {
      flags.head = argv[++i];
      continue;
    }
    if (token.startsWith("--")) {
      console.error(`Неизвестный флаг: ${token}`);
      process.exit(1);
    }
    positional.push(token);
  }
  return { flags, positional };
}

const { flags, positional } = parseArgv(process.argv.slice(2));
const projectRoot = resolve(
  flags.root ?? positional[0] ?? requireConnection(cliRoot),
);

const result = await runProjectReview(projectRoot, {
  base: flags.base,
  head: flags.head,
  diffSource: flags.diff,
});

console.log(result.reply);

const prNumber = process.env.PR_NUMBER?.trim();
if (process.env.GITHUB_ACTIONS === "true" && prNumber) {
  await upsertPrComment(cliRoot, prNumber, result.reply);
}
