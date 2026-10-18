import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { indexLaw } from "../src/doc-index/pipeline.js";
import { quotesAreGrounded, retrieveLawContext } from "../src/doc-index/rag.js";
import {
  goalHeld,
  groundedChatAnswer,
  runChatSession,
  sourcesOnEveryTurn,
} from "../src/rag-chat.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lawPath = resolve(projectRoot, "data", "doc-index", "law.sqlite");
if (!existsSync(lawPath)) indexLaw(projectRoot);

const scenarios = JSON.parse(
  readFileSync(resolve(projectRoot, "data", "rag-chat-scenarios.json"), "utf8"),
);

const promptsMissed = [];

function retrieve(query) {
  return retrieveLawContext(query, { indexPath: lawPath, mode: "filtered" }).hits;
}

const report = {
  at: new Date().toISOString(),
  mode: "local-grounded",
  index: "data/doc-index/law.sqlite",
  scenarios: [],
};

for (const scenario of scenarios) {
  const seenPrompts = [];
  const session = await runChatSession(scenario.messages, {
    retrieve,
    generate: async (payload) => {
      seenPrompts.push(payload.prompt);
      if (payload.state.goal && !payload.prompt.includes(payload.state.goal)) {
        promptsMissed.push(`${scenario.id}#${seenPrompts.length}`);
      }
      return groundedChatAnswer(payload);
    },
  });
  const kept = goalHeld(session.turns);
  const sourced = sourcesOnEveryTurn(session.turns);
  const grounded = session.turns.every((turn) => quotesAreGrounded(turn.quotes, turn.hits));
  const row = {
    id: scenario.id,
    title: scenario.title,
    turns: session.turns.length,
    goal: session.state.goal,
    goalKept: kept,
    sourcesEveryTurn: sourced,
    quotesGrounded: grounded,
    clarifications: session.state.clarifications.map((item) => item.text),
    constraints: session.state.constraints.map((item) =>
      item.term ? `${item.term}: ${item.value}` : item.value,
    ),
    history: session.state.history.length,
    promptsWithGoal: seenPrompts.filter((prompt) => prompt.includes(session.state.goal)).length,
    messages: session.turns.map((turn, index) => ({
      n: index + 1,
      user: scenario.messages[index],
      abstained: turn.abstained,
      sources: turn.sources.map((source) => source.section),
      goal: turn.state.goal,
    })),
  };
  report.scenarios.push(row);
  console.log(
    `${scenario.id}: ходов ${row.turns}, цель ${kept ? "сохранена" : "ПОТЕРЯНА"}, источники ${sourced ? "на каждом ходе" : "НЕ НА КАЖДОМ"}, цитаты ${grounded ? "из чанков" : "НЕ ИЗ ЧАНКОВ"}`,
  );
  for (const message of row.messages) {
    const source = message.sources[0] ?? (message.abstained ? "отказ" : "нет");
    console.log(`  ${message.n}. ${source}`);
  }
}

const outPath = resolve(projectRoot, "data", "rag-chat-report.json");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`отчёт: ${outPath}`);

const failed = report.scenarios.some(
  (row) => !row.goalKept || !row.sourcesEveryTurn || !row.quotesGrounded || row.turns < 10,
);
if (failed || promptsMissed.length) {
  console.error(promptsMissed.length ? `цель не попала в промпт: ${promptsMissed.join(", ")}` : "сценарий не удержал цель или источники");
  process.exit(1);
}
