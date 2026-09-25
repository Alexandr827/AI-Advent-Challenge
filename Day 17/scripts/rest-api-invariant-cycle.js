import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../src/env.js";
import { AgentPool } from "../src/pool.js";
import { buildPrompt } from "../src/profile.js";
import {
  createInvariantStorage,
  formatInvariantAdded,
  formatInvariantCheck,
  formatInvariantCreated,
  formatInvariantsPrompt,
  InvariantService,
} from "../src/invariant.js";
import { formatAskTokenLine } from "../src/tokens.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(resolve(projectRoot, ".env"));

const API_KEY = process.env.CURSOR_API_KEY?.trim();
const MODEL = process.env.CURSOR_MODEL ?? "composer-2.5";
const RUNTIME = (process.env.CURSOR_RUNTIME ?? "local").toLowerCase();

if (!API_KEY) {
  console.error("Задайте CURSOR_API_KEY в .env");
  process.exit(1);
}

const SYSTEM =
  "Отвечай по-русски, кратко, на уровне проектирования. Не пиши полные реализации.";
const SET_ID = "bpmn";
const AGENT = "helper";
const DESIGN = "Спроектируй мне REST API";
const CONFLICT = "Давай сделаем это на C# и ASP.NET";

const ADD = [
  ["stack", ["NodeJS", "JavaScript"]],
  ["arch", ["MVVM"]],
  ["budget", ["100000"]],
  ["maxdeps", ["5"]],
  ["nobanned", ["RxJava"]],
  ["decision", ["REST без GraphQL"]],
  ["apis", ["free"]],
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function persist(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

async function askWithRetry(agent, text, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await agent.ask(text);
    } catch (err) {
      lastErr = err;
      console.error(`# retry ${i}/${attempts}: ${err.message ?? err}`);
      await sleep(2000 * i);
    }
  }
  throw lastErr;
}

const outPath = resolve(projectRoot, "data", "rest-api-invariant-cycle.json");
const storePath = resolve(projectRoot, "data", "rest-api-invariant-agents.json");
const invariantPath = resolve(projectRoot, "data", "invariant-bench.json");

const invariants = new InvariantService({
  storage: createInvariantStorage({ path: invariantPath }),
});

const pool = new AgentPool({
  apiKey: API_KEY,
  defaultModel: MODEL,
  defaultRuntime: RUNTIME,
  cwd: projectRoot,
  storePath,
  invariantLoader: invariants.loader,
});

const transcript = [];
function line(text = "") {
  transcript.push(text);
  console.log(text);
}

const report = {
  model: MODEL,
  runtime: RUNTIME,
  at: new Date().toISOString(),
  systemPrompt: SYSTEM,
  turns: [],
  prompt: "",
  transcript: "",
};

try {
  if (await invariants.loader.exists(SET_ID)) {
    await invariants.delete(SET_ID);
  }

  line("npm start");
  line("CLI-хост агентов. Модель по умолчанию: composer-2.5, runtime: local. Лимит: 100.");
  line(
    "Введите help для списка команд. Память: short / working / long. Задача: planning → execution → validation → done (переходы контролируемые). Персонализация: profile / style / constraints / context. Инварианты: invariant — отдельное хранилище, проверка каждого ответа.",
  );
  line(">");
  line(`> invariant create ${SET_ID}`);
  const created = await invariants.create(SET_ID);
  line(formatInvariantCreated(created));

  for (const [type, args] of ADD) {
    line(`> invariant add ${SET_ID} ${type} ${args.join(" ")}`);
    const added = await invariants.add(SET_ID, type, args);
    line(formatInvariantAdded(added));
  }

  line(`> invariant ${SET_ID}`);
  const set = await invariants.load(SET_ID);
  line(invariants.format(set));

  const spawnLine = `> spawn --name ${AGENT} --invariants ${SET_ID} --no-compress --strategy full --system "${SYSTEM}"`;
  line(spawnLine);
  const existing = pool.get(AGENT);
  if (existing) await pool.kill(AGENT);
  const [agent] = pool.spawn({
    name: AGENT,
    strategy: "full",
    compress: false,
    systemPrompt: SYSTEM,
    invariantSetId: SET_ID,
  });
  line(`Создано: 1`);
  line(
    `  #${agent.id}  ${agent.name}  model=${agent.model}  runtime=${agent.runtime}  ${agent.status}  messages=0 compress=off  memory=s0/w0/l0  invariants=${SET_ID}`,
  );

  report.prompt = buildPrompt({
    system: SYSTEM,
    invariants: formatInvariantsPrompt(set),
    query: DESIGN,
  });
  line("");
  line("# Промпт первого ask (system + [INVARIANTS] + вопрос):");
  line(report.prompt);
  line("");

  const asks = [
    { id: "design", query: DESIGN },
    { id: "conflict", query: CONFLICT },
  ];

  for (const item of asks) {
    line(`> ask ${AGENT} ${item.query}`);
    line(`→ ${agent.name}:`);
    const { reply, tokens, invariants: pipeline } = await askWithRetry(
      agent,
      item.query,
    );
    const checkLine = formatInvariantCheck(pipeline);
    if (checkLine) line(checkLine);
    line(reply.trim() || "(пусто)");
    line(formatAskTokenLine(tokens));
    line("");
    report.turns.push({
      id: item.id,
      query: item.query,
      reply: reply.trim(),
      checkLine: checkLine || "",
      pipeline: {
        ok: pipeline?.ok ?? null,
        refused: pipeline?.refused ?? false,
        attempts: pipeline?.attempts ?? 1,
        violations: (pipeline?.violations ?? []).map((row) => row.description),
      },
      tokenLine: formatAskTokenLine(tokens),
      occupancy: tokens.occupancy,
      usage: tokens.usage,
    });
    persist(outPath, { ...report, transcript: transcript.join("\n") });
  }

  line(`> tokens ${AGENT}`);
  line(`Инварианты: ${SET_ID} (${set.items.length}: ${set.items.map((i) => i.type).join(", ")})`);
  line(formatAskTokenLine(agent.tokenReport));

  report.atEnd = new Date().toISOString();
  report.transcript = transcript.join("\n");
  persist(outPath, report);
  console.error(`\nSaved ${outPath}`);
} finally {
  await pool.disposeAll();
}
