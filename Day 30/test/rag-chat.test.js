import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { LlmAgent } from "../src/agent.js";
import { helpText, parseCommand } from "../src/cli.js";
import { loadLaw } from "../src/doc-index/corpus.js";
import { indexChunks } from "../src/doc-index/pipeline.js";
import { quotesAreGrounded, retrieveLawContext } from "../src/doc-index/rag.js";
import { writeIndex } from "../src/doc-index/store.js";
import { loadState, saveState } from "../src/store.js";
import {
  applyUserMemory,
  emptyChatState,
  formatChatState,
  goalHeld,
  groundedChatAnswer,
  parseMemoryLine,
  retrievalText,
  runChatSession,
  runChatTurn,
  sourcesOnEveryTurn,
} from "../src/rag-chat.js";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const scenarios = JSON.parse(readFileSync(join(projectRoot, "data/rag-chat-scenarios.json"), "utf8"));
const tmpDirs = [];

after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "rag-chat-"));
  tmpDirs.push(dir);
  return dir;
}

function lawIndex() {
  const dir = tempDir();
  const indexPath = join(dir, "law.sqlite");
  writeIndex(indexPath, indexChunks(loadLaw(projectRoot)));
  return indexPath;
}

describe("память задачи", () => {
  it("фиксирует цель, уточнения и термины и не затирает цель следующим вопросом", () => {
    let state = applyUserMemory(emptyChatState(), "Цель: чеклист дистанционной продажи.");
    state = applyUserMemory(state, "Уточняю: продавец — ИП.");
    state = applyUserMemory(state, "Термин: дистанционный способ — продажа без осмотра товара.");
    state = applyUserMemory(state, "Ограничение: только 38-ФЗ.");
    state = applyUserMemory(state, "Фиксируем: срок хранения — календарный год.");
    state = applyUserMemory(state, "Сколько хранить рекламные материалы?");
    assert.equal(state.goal, "чеклист дистанционной продажи.");
    assert.deepEqual(
      state.clarifications.map((item) => item.text),
      ["продавец — ИП."],
    );
    assert.equal(state.constraints[0].kind, "term");
    assert.equal(state.constraints[0].term, "дистанционный способ");
    assert.match(state.constraints[1].value, /38-ФЗ/);
    assert.equal(state.constraints[2].kind, "fixed");
    assert.equal(parseMemoryLine("имею в виду книги").kind, "clarify");
    assert.match(formatChatState(state), /Цель: чеклист дистанционной продажи/);
    assert.match(retrievalText(state, "А какой срок для этого?"), /календарный год/);
    assert.equal(
      retrievalText(state, "Сколько хранить рекламные материалы или их копии?"),
      "Сколько хранить рекламные материалы или их копии?",
    );
  });

  it("повторяет термин новым значением и не дублирует уточнение", () => {
    let state = applyUserMemory(emptyChatState(), "Термин: годовой объём — прошлый год.");
    state = applyUserMemory(state, "Термин: годовой объём — календарный год.");
    state = applyUserMemory(state, "Уточняю: город не важен.");
    state = applyUserMemory(state, "Уточняю: город не важен.");
    const terms = state.constraints.filter((item) => item.kind === "term");
    assert.equal(terms.length, 1);
    assert.equal(terms[0].value, "календарный год.");
    assert.equal(state.clarifications.length, 1);
  });
});

describe("команда chat", () => {
  it("разбирает ход, состояние и очистку", () => {
    assert.equal(helpText().includes("chat <name|id> [--temperature N] [--max-tokens N] [--context N] <текст>"), true);
    assert.deepEqual(parseCommand("chat law state"), {
      type: "chat",
      action: "state",
      target: "law",
    });
    assert.deepEqual(parseCommand("chat clear law"), {
      type: "chat",
      action: "clear",
      target: "law",
    });
    assert.equal(parseCommand('chat law Сколько хранить материалы').text, "Сколько хранить материалы");
    assert.throws(() => parseCommand("chat law"), /chat/);
  });

  it("хранит сессию на агенте отдельно от истории ask", () => {
    const dir = tempDir();
    const storePath = join(dir, "agents.json");
    const agent = new LlmAgent({
      id: "1",
      name: "law",
      model: "composer-2.5",
      apiKey: "test",
      cwd: dir,
      chat: {
        goal: "чеклист",
        clarifications: [{ text: "книги" }],
        constraints: [{ kind: "constraint", term: "", value: "только 38-ФЗ" }],
        history: [
          { role: "user", content: "Цель: чеклист", ts: 1 },
          { role: "assistant", content: "Ответ: да", ts: 2 },
        ],
      },
    });
    assert.equal(agent.chatState.goal, "чеклист");
    assert.equal(agent.messages.length, 0);
    saveState(storePath, { nextId: 2, agents: [agent.toJSON()] });
    const loaded = loadState(storePath);
    assert.equal(loaded.agents[0].chat.goal, "чеклист");
    assert.equal(loaded.agents[0].chat.clarifications[0].text, "книги");
    assert.equal(loaded.agents[0].chat.history.length, 2);
    assert.equal(agent.clearChat().goal, "");
  });
});

describe("длинные сценарии мини-чата", () => {
  const indexPath = lawIndex();

  for (const scenario of scenarios) {
    it(`${scenario.id}: цель держится, источники на каждом из ${scenario.messages.length} ходов`, async () => {
      assert.ok(scenario.messages.length >= 10);
      assert.ok(scenario.messages.length <= 15);
      const prompts = [];
      const session = await runChatSession(scenario.messages, {
        retrieve: (query) => retrieveLawContext(query, { indexPath, mode: "filtered" }).hits,
        generate: async (payload) => {
          prompts.push(payload.prompt);
          assert.match(payload.prompt, /Память задачи/);
          assert.equal(payload.prompt.includes(payload.state.goal), true);
          for (const item of payload.state.clarifications) {
            assert.equal(payload.prompt.includes(item.text), true);
          }
          for (const item of payload.state.constraints) {
            assert.equal(payload.prompt.includes(item.value), true);
          }
          return groundedChatAnswer(payload);
        },
      });
      assert.equal(session.turns.length, scenario.messages.length);
      assert.equal(goalHeld(session.turns), true);
      assert.equal(session.state.goal, scenario.expect.goal);
      assert.deepEqual(
        session.state.clarifications.map((item) => item.text),
        scenario.expect.clarifications,
      );
      const blob = session.state.constraints
        .map((item) => `${item.term} ${item.value}`)
        .join("\n");
      for (const piece of scenario.expect.constraints) {
        assert.equal(blob.includes(piece), true, piece);
      }
      assert.equal(sourcesOnEveryTurn(session.turns), true);
      assert.equal(session.state.history.length, scenario.messages.length * 2);
      for (const [n, articles] of Object.entries(scenario.mustCite ?? {})) {
        const turn = session.turns[Number(n) - 1];
        const blob = turn.sources.map((source) => source.section).join("\n");
        for (const article of articles) {
          assert.equal(blob.includes(article), true, `${scenario.id} ход ${n}: ${article}`);
        }
      }
      assert.equal(prompts.length, scenario.messages.length);
      for (const turn of session.turns) {
        assert.equal(turn.reply.includes(session.state.goal), true);
        assert.equal(quotesAreGrounded(turn.quotes, turn.hits), true);
        assert.match(turn.reply, /Источники:\n- 38-ФЗ \|/);
      }
      const late = prompts[prompts.length - 1];
      assert.equal(late.includes(scenario.expect.goal), true);
      assert.match(late, /Последние реплики диалога/);
    });
  }

  it("без релевантного контекста всё равно печатает блок источников и не зовёт модель", async () => {
    let calls = 0;
    const turn = await runChatTurn(emptyChatState(), "Какая завтра погода в Москве?", {
      retrieve: () => [],
      generate: async () => {
        calls += 1;
        return "жарко";
      },
    });
    assert.equal(calls, 0);
    assert.equal(turn.abstained, true);
    assert.match(turn.reply, /Источники:\n- нет \| порог не пройден/);
    assert.equal(turn.state.history.length, 2);
  });
});
