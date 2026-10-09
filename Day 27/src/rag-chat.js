import { tokensOf, normalizeText } from "./doc-index/embed.js";
import {
  composeCitedReply,
  formatLawBlock,
  isWeakLawContext,
  parseCitedAnswer,
  sharedStemCount,
} from "./doc-index/rag.js";

export const CHAT_HISTORY_LIMIT = 80;
export const CHAT_HISTORY_WINDOW = 8;

export const CHAT_ABSTAIN_REPLY =
  "Не знаю. Уточните, пожалуйста, о какой норме закона «О рекламе» идёт речь.";

const CHAT_INSTRUCTION = [
  "Мини-чат по Федеральному закону «О рекламе». Ответь только по фрагментам ниже.",
  "Память задачи обязательна: держи цель диалога, не переспрашивай уже уточнённое и не противоречь зафиксированным ограничениям и терминам.",
  "Формат строго из трёх блоков:",
  "Ответ: кратко, с номером статьи и с учётом цели.",
  "Источники:",
  "- source | section | chunk_id",
  "Цитаты:",
  "- «дословный фрагмент из текста чанка, без пересказа»",
  "Если нормы во фрагментах нет — так и напиши в ответе и не выдумывай цитату.",
].join("\n");

const GOAL_LINE =
  /^(?:\/goal|цель|задача(?:\s+диалога)?|моя\s+цель)\s*[:—–-]\s*(.+)$/iu;
const CLARIFY_LINE =
  /^(?:\/clarify|уточняю|уточнение)\s*[:—–-]\s*(.+)$/iu;
const CLARIFY_PHRASE =
  /^(?:речь(?:\s+ид[её]т)?\s+о|имею\s+в\s+виду)\s*[:—–-]?\s*(.+)$/iu;
const CONSTRAINT_LINE = /^(?:\/constraint|ограничение)\s*[:—–-]\s*(.+)$/iu;
const TERM_LINE = /^(?:\/term|термин)\s*[:—–-]\s*(.+)$/iu;
const FIXED_LINE =
  /^(?:фиксируем|считаем,?\s+что|считай,?\s+что)\s*[:—–-]?\s*(.+)$/iu;

const FOLLOW_UP =
  /напомн|повтор|зафиксир|именно|этот|эта|это|этом|этой|такие|такой|наш/iu;
const DOMAIN =
  /табак|алкогол|оферт|хранен|дистанц|социальн|политическ|никотин|объ[её]м|годов/iu;

function fold(text) {
  return normalizeText(String(text ?? "").replace(/\s+/g, " ").trim());
}

export function emptyChatState() {
  return { goal: "", clarifications: [], constraints: [], history: [] };
}

export function normalizeChatState(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const clarifications = [];
  const seenClarifications = new Set();
  for (const item of Array.isArray(src.clarifications) ? src.clarifications : []) {
    const text = String(item?.text ?? "").trim();
    if (!text) continue;
    const key = fold(text);
    if (seenClarifications.has(key)) continue;
    seenClarifications.add(key);
    clarifications.push({ text });
  }

  const constraints = [];
  const seenConstraints = new Set();
  for (const item of Array.isArray(src.constraints) ? src.constraints : []) {
    const kind = item?.kind === "term" || item?.kind === "fixed" ? item.kind : "constraint";
    const term = String(item?.term ?? "").trim();
    const value = String(item?.value ?? "").trim();
    if (!value) continue;
    const key = `${kind}\0${fold(term)}\0${fold(value)}`;
    if (seenConstraints.has(key)) continue;
    seenConstraints.add(key);
    constraints.push({ kind, term, value });
  }

  const history = [];
  for (const item of Array.isArray(src.history) ? src.history : []) {
    if (item?.role !== "user" && item?.role !== "assistant") continue;
    const content = String(item?.content ?? "");
    if (!content) continue;
    history.push({
      role: item.role,
      content,
      ts: Number.isFinite(item.ts) ? item.ts : 0,
    });
  }

  return {
    goal: String(src.goal ?? "").trim(),
    clarifications,
    constraints,
    history: history.slice(-CHAT_HISTORY_LIMIT),
  };
}

function splitTerm(body) {
  const text = String(body ?? "").trim();
  const match = text.match(/^(.{1,80}?)\s*[—–=:]\s*(.+)$/u);
  if (!match) return { term: "", value: text };
  return { term: match[1].trim(), value: match[2].trim() };
}

export function parseMemoryLine(line) {
  const text = String(line ?? "").trim();
  if (!text) return null;
  let match = GOAL_LINE.exec(text);
  if (match) return { kind: "goal", text: match[1].trim() };
  match = CLARIFY_LINE.exec(text) ?? CLARIFY_PHRASE.exec(text);
  if (match) return { kind: "clarify", text: match[1].trim() };
  match = TERM_LINE.exec(text);
  if (match) {
    const pair = splitTerm(match[1]);
    return { kind: "term", term: pair.term, value: pair.value || pair.term, text: match[1].trim() };
  }
  match = CONSTRAINT_LINE.exec(text);
  if (match) return { kind: "constraint", term: "", value: match[1].trim(), text: match[1].trim() };
  match = FIXED_LINE.exec(text);
  if (match) return { kind: "fixed", term: "", value: match[1].trim(), text: match[1].trim() };
  return null;
}

function upsertConstraint(state, parsed) {
  if (parsed.kind === "term" && parsed.term) {
    const key = fold(parsed.term);
    const index = state.constraints.findIndex(
      (item) => item.kind === "term" && fold(item.term) === key,
    );
    const next = { kind: "term", term: parsed.term, value: parsed.value };
    if (index >= 0) state.constraints[index] = next;
    else state.constraints.push(next);
    return;
  }
  const value = parsed.value;
  if (!value) return;
  const kind = parsed.kind === "fixed" ? "fixed" : "constraint";
  const key = fold(value);
  if (state.constraints.some((item) => item.kind === kind && fold(item.value) === key)) return;
  state.constraints.push({ kind, term: "", value });
}

export function applyUserMemory(state, userText) {
  const next = normalizeChatState(state);
  for (const line of String(userText ?? "").split(/\n/)) {
    const parsed = parseMemoryLine(line);
    if (!parsed?.text && !parsed?.value) continue;
    if (parsed.kind === "goal") {
      if (parsed.text) next.goal = parsed.text;
      continue;
    }
    if (parsed.kind === "clarify") {
      if (!parsed.text) continue;
      const key = fold(parsed.text);
      if (!next.clarifications.some((item) => fold(item.text) === key)) {
        next.clarifications.push({ text: parsed.text });
      }
      continue;
    }
    upsertConstraint(next, parsed);
  }
  return next;
}

function contentTokens(text) {
  return tokensOf(text).filter((token) => token.length >= 4);
}

export function needsTaskMemory(userText) {
  const question = String(userText ?? "").trim();
  if (contentTokens(question).length < 5) return true;
  if (/^(?:а|и|ну|тогда)\s/iu.test(question)) return true;
  return FOLLOW_UP.test(question);
}

export function memoryBits(state) {
  const src = normalizeChatState(state);
  const bits = [];
  if (src.goal) bits.push(src.goal);
  for (const item of src.constraints) {
    bits.push(item.kind === "term" && item.term ? `${item.term} ${item.value}` : item.value);
  }
  return bits.filter(Boolean);
}

const FACETS = [
  {
    test: /табак|никотин/iu,
    anchor: /табак|никотин/iu,
    query: "товары реклама которых не допускается табак никотинсодержащая",
  },
  {
    test: /алкогол/iu,
    anchor: /алкогол/iu,
    query: "реклама алкогольной продукции сто метров медицинские образовательные",
  },
  {
    test: /социальн/iu,
    anchor: /социальн/iu,
    query: "социальная реклама пять процентов годовой объем",
  },
  {
    test: /оферт/iu,
    anchor: /оферт/iu,
    query: "срок действия рекламы признаваемой офертой",
  },
  {
    test: /хранен|хранить/iu,
    anchor: /хранен/iu,
    query: "срок хранения рекламных материалов копии",
  },
  {
    test: /дистанцион/iu,
    anchor: /дистанцион/iu,
    query: "дистанционный способ продажи наименование место нахождения ОГРН",
  },
  {
    test: /политическ|агитац/iu,
    anchor: /политическ|агитац/iu,
    query: "политическая реклама предвыборная агитация не распространяется",
  },
];

export function retrievalText(state, userText) {
  const question = String(userText ?? "").trim();
  const marked = question.split(/\n/).some((line) => parseMemoryLine(line));
  if (DOMAIN.test(question) && contentTokens(question).length >= 4) return question;
  if (!marked && !needsTaskMemory(question)) return question;
  return [question, question, ...memoryBits(state)].join(" ");
}

export function matchingFacets(userText) {
  const text = String(userText ?? "");
  return FACETS.filter((facet) => facet.test.test(text));
}

function bestFacetHit(hits, facet) {
  const sectionAnchored = (hits ?? []).filter((hit) => facet.anchor.test(hit.section ?? ""));
  const bodyAnchored = (hits ?? []).filter((hit) =>
    facet.anchor.test(`${hit.section ?? ""}\n${hit.text ?? ""}`),
  );
  const pool = sectionAnchored.length ? sectionAnchored : bodyAnchored.length ? bodyAnchored : (hits ?? []);
  let best = null;
  let bestRank = -1;
  for (const hit of pool) {
    const body = `${hit.section ?? ""}\n${hit.text ?? ""}`;
    const stems = sharedStemCount(facet.query, body);
    if (!stems) continue;
    const rank = stems * 10 + sharedStemCount(facet.query, hit.section ?? "");
    if (rank > bestRank || (rank === bestRank && Number(hit.score) > Number(best?.score))) {
      bestRank = rank;
      best = hit;
    }
  }
  return best;
}

export function collectChatHits(retrieve, state, userText) {
  const searchQuery = retrievalText(state, userText);
  const primary = retrieve(searchQuery);
  const base = Array.isArray(primary) ? primary : [];
  const facets = matchingFacets(userText);
  if (facets.length < 2) return { searchQuery, hits: base };
  const hits = [];
  const seen = new Set();
  for (const facet of facets) {
    const picked = bestFacetHit(retrieve(facet.query), facet);
    if (!picked?.chunk_id || seen.has(picked.chunk_id)) continue;
    seen.add(picked.chunk_id);
    hits.push(picked);
  }
  for (const hit of base) {
    if (hits.length >= 4) break;
    if (!hit?.chunk_id || seen.has(hit.chunk_id)) continue;
    seen.add(hit.chunk_id);
    hits.push(hit);
  }
  return { searchQuery, hits: hits.slice(0, 4) };
}

export function formatConstraint(item) {
  if (item?.kind === "term" && item.term) return `термин «${item.term}»: ${item.value}`;
  if (item?.kind === "fixed") return `фиксируем: ${item.value}`;
  return `ограничение: ${item?.value ?? ""}`;
}

export function formatTaskMemory(state) {
  const src = normalizeChatState(state);
  const lines = ["Память задачи (держи её до конца диалога):"];
  lines.push(`Цель: ${src.goal || "не задана"}`);
  lines.push("Уже уточнено:");
  if (!src.clarifications.length) lines.push("- пока ничего");
  else {
    for (const item of src.clarifications) lines.push(`- ${item.text}`);
  }
  lines.push("Зафиксированные ограничения и термины:");
  if (!src.constraints.length) lines.push("- пока ничего");
  else {
    for (const item of src.constraints) lines.push(`- ${formatConstraint(item)}`);
  }
  return lines.join("\n");
}

export function formatChatState(state) {
  const src = normalizeChatState(state);
  return `${formatTaskMemory(src)}\nИстория: ${src.history.length} сообщ.`;
}

export function formatChatMemoryLine(state) {
  const src = normalizeChatState(state);
  const goal = src.goal ? `«${src.goal}»` : "не задана";
  return `Память задачи: цель ${goal}; уточнений ${src.clarifications.length}; ограничений ${src.constraints.length}`;
}

function historyForPrompt(history, window) {
  return history.slice(-window).map((item) => {
    if (item.role !== "assistant") return item;
    const answer = parseCitedAnswer(item.content);
    return { ...item, content: answer || item.content };
  });
}

export function buildChatPrompt({ state, history, query, hits }) {
  const recent = historyForPrompt(history ?? [], CHAT_HISTORY_WINDOW);
  const lines = [CHAT_INSTRUCTION, "", formatTaskMemory(state), ""];
  if (recent.length) {
    lines.push("Последние реплики диалога:");
    for (const item of recent) {
      lines.push(`${item.role === "user" ? "Пользователь" : "Ассистент"}: ${item.content}`);
    }
    lines.push("");
  }
  const law = formatLawBlock(hits);
  if (law) lines.push(law, "");
  lines.push(`Вопрос: ${String(query ?? "").trim()}`);
  return lines.join("\n");
}

export function formatChatAbstain(state) {
  const src = normalizeChatState(state);
  const goal = src.goal ? ` Цель диалога сохранена: «${src.goal}».` : "";
  return [
    `Ответ: ${CHAT_ABSTAIN_REPLY}${goal}`,
    "",
    "Источники:",
    "- нет | порог не пройден | —",
    "",
    "Цитаты:",
    "- нет дословного фрагмента",
  ].join("\n");
}

function appendTurn(state, userText, reply) {
  const next = normalizeChatState(state);
  const ts = Date.now();
  next.history.push(
    { role: "user", content: userText, ts },
    { role: "assistant", content: reply, ts: ts + 1 },
  );
  return normalizeChatState(next);
}

export function groundedChatAnswer({ state, hits }) {
  const top = hits?.[0];
  const sentence =
    String(top?.text ?? "")
      .split(/(?<=[.!?])\s+/)
      .map((part) => part.trim())
      .find((part) => part.length >= 20) ?? String(top?.text ?? "").slice(0, 240);
  const goal = state?.goal ? `С учётом цели «${state.goal}». ` : "";
  return `${goal}${sentence}`.trim();
}

export function goalHeld(turns) {
  let seen = "";
  for (const turn of turns ?? []) {
    const goal = String(turn?.state?.goal ?? "");
    if (!seen) {
      seen = goal;
      continue;
    }
    if (goal !== seen) return false;
  }
  return Boolean(seen);
}

export function sourcesOnEveryTurn(turns) {
  return (turns ?? []).every((turn) => {
    if (turn?.abstained) return false;
    if (!turn?.sources?.length) return false;
    if (!/(?:^|\n)Источники:\n- /.test(String(turn.reply ?? ""))) return false;
    return turn.sources.every((source) => source.source && source.section && source.chunk_id);
  });
}

export async function runChatTurn(state, userText, { retrieve, generate } = {}) {
  const text = String(userText ?? "").trim();
  if (!text) throw new Error("Пустой запрос");
  if (typeof retrieve !== "function") {
    throw new Error("runChatTurn: нужен retrieve()");
  }
  const next = applyUserMemory(state, text);
  const collected = collectChatHits(retrieve, next, text);
  const searchQuery = collected.searchQuery;
  const hits = collected.hits;
  if (isWeakLawContext(hits)) {
    const reply = formatChatAbstain(next);
    const stored = appendTurn(next, text, reply);
    return {
      reply,
      state: stored,
      sources: [],
      quotes: [],
      abstained: true,
      searchQuery,
      hits,
      prompt: "",
    };
  }
  if (typeof generate !== "function") {
    throw new Error("runChatTurn: нужен generate()");
  }
  const prompt = buildChatPrompt({
    state: next,
    history: next.history,
    query: text,
    hits,
  });
  const modelReply = await generate({
    query: text,
    hits,
    prompt,
    state: next,
    searchQuery,
  });
  const cited = composeCitedReply(modelReply, hits);
  return {
    reply: cited.reply,
    state: appendTurn(next, text, cited.reply),
    sources: cited.sources,
    quotes: cited.quotes,
    abstained: false,
    searchQuery,
    hits,
    prompt,
  };
}

export async function runChatSession(messages, options) {
  let state = emptyChatState();
  const turns = [];
  for (const text of messages ?? []) {
    const turn = await runChatTurn(state, text, options);
    state = turn.state;
    turns.push(turn);
  }
  return { state, turns };
}
