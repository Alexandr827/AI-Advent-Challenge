import { resolve } from "node:path";
import { cliRoot, requireConnection } from "../src/connection.js";
import { installPrWorkflow, resolveAssistantRepo } from "../src/pr-pipeline.js";

function usage() {
  console.log(`Использование:
  npm run pr:pipeline -- install [корень-проекта]
      Кладёт в проект ${".github/workflows/ai-review.yml"} — при pull_request запускается AI-ревью.

Переменные:
  DEV_ASSISTANT_GITHUB_REPO  (по умолчанию Alexandr827/AI-Advent-Challenge)
  DEV_ASSISTANT_GITHUB_REF   (по умолчанию main)

Локально до создания PR:
  npm run review
  node scripts/ai-review.js --root /путь/к/проекту --base origin/main --head HEAD
`);
}

const argv = process.argv.slice(2);
const command = argv[0];
const rest = argv.slice(1);

function projectRootFromArgs() {
  const pathArg = rest.find((item) => !item.startsWith("--"));
  return pathArg ? resolve(pathArg) : requireConnection(cliRoot);
}

if (!command || command === "help" || command === "-h") {
  usage();
  process.exit(0);
}

const projectRoot = projectRootFromArgs();

if (command === "install") {
  const assistant = await resolveAssistantRepo(projectRoot);
  const result = installPrWorkflow(projectRoot, { assistant });
  console.log(`Записано: ${result.target}`);
  console.log(`dev-assistant: ${result.assistant.repo}@${result.assistant.ref}`);
  console.log("");
  console.log("Дальше в репозитории проекта:");
  console.log(`  cd ${projectRoot}`);
  console.log(`  git add ${".github/workflows/ai-review.yml"}`);
  console.log('  git commit -m "ci: AI-ревью PR"');
  console.log("  git push");
  console.log("  gh pr create ...   # при открытии PR workflow стартует на GitHub");
  process.exit(0);
}

usage();
process.exit(1);
