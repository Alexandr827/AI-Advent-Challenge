import { existsSync } from "node:fs";
import { estimateTokens } from "../tokens.js";
import { embed, normalizeText, tokensOf } from "./embed.js";
import { openIndex, searchChunks } from "./store.js";

export const LAW_CANDIDATE_K = 12;
export const LAW_TOP_K = 4;
export const LAW_SCORE_THRESHOLD = 0.36;
export const LAW_MIN_SHARED_STEMS = 2;

const LAW_INSTRUCTION = [
  "Фрагменты Федерального закона «О рекламе». Ответь только по ним, без знаний вне фрагментов.",
  "Формат строго из трёх блоков:",
  "Ответ: кратко, с номером статьи.",
  "Источники:",
  "- source | section | chunk_id",
  "Цитаты:",
  "- «дословный фрагмент из текста чанка, без пересказа»",
  "Если нормы во фрагментах нет — так и напиши в ответе и не выдумывай цитату.",
].join("\n");

export const LAW_ABSTAIN_REPLY =
  "Не знаю. Уточните, пожалуйста, о какой норме закона «О рекламе» идёт речь.";

const MIN_QUOTE_LENGTH = 12;

const LAW_EXPANSIONS = [
  {
    test: /хран/i,
    extra: "срок хранения рекламных материалов копии",
  },
  {
    test: /оферт/i,
    extra: "срок действия рекламы признаваемой офертой",
  },
  {
    test: /основн[а-яё]*\s+понят|объект реклам|определен[а-яё]*\s+реклам/i,
    extra: "основные понятия реклама информация неопределенному кругу лиц объект рекламирования",
  },
  {
    test: /политическ|предвыборн|агитац/i,
    extra: "сфера применения политическая реклама предвыборная агитация не распространяется",
  },
  {
    test: /табак|никотин/i,
    extra: "товары реклама которых не допускается табак никотинсодержащая",
  },
  {
    test: /дистанцион/i,
    extra: "дистанционный способ продажи наименование место нахождения ОГРН",
  },
  {
    test: /стимулир/i,
    extra: "стимулирующее мероприятие сроки проведения источник информации организатор",
  },
  {
    test: /алкогол/i,
    extra: "реклама алкогольной продукции сто метров медицинские образовательные",
  },
  {
    test: /социальн/i,
    extra: "социальная реклама пять процентов годовой объем рекламораспространитель",
  },
  {
    test: /ненадлежащ|цел[иь]\s+закон|добросовестн/i,
    extra: "цели закона добросовестная конкуренция единство экономического пространства",
  },
];

export function sharedStemCount(query, text) {
  const queryStems = stemsOf(query);
  if (!queryStems.size) return 0;
  const textStems = stemsOf(text);
  let count = 0;
  for (const stem of queryStems) {
    if (textStems.has(stem)) count += 1;
  }
  return count;
}

/** Первые 4 символа длинных токенов (не лингвистический stemmer). */
function stemsOf(text) {
  const stems = new Set();
  for (const token of tokensOf(text)) {
    if (token.length >= 4) stems.add(token.slice(0, 4));
  }
  return stems;
}

export function rewriteLawQuery(query) {
  const text = String(query ?? "").trim();
  if (!text) return "";
  const folded = normalizeText(text);
  const extras = [];
  for (const rule of LAW_EXPANSIONS) {
    if (rule.test.test(folded)) extras.push(rule.extra);
  }
  if (!extras.length) return text;
  return `${text} ${extras.join(" ")}`;
}

export function selectLawHits(
  hits,
  threshold = LAW_SCORE_THRESHOLD,
  query = "",
  minSharedStems = LAW_MIN_SHARED_STEMS,
) {
  if (!hits?.length || hits[0].score < threshold) return [];
  return hits.filter(
    (hit) => hit.score >= threshold && sharedStemCount(query, hit.text) >= minSharedStems,
  );
}

export function rerankLawHits(
  hits,
  query = "",
  {
    threshold = LAW_SCORE_THRESHOLD,
    minSharedStems = LAW_MIN_SHARED_STEMS,
    k = LAW_TOP_K,
  } = {},
) {
  if (!hits?.length) return [];
  let best = hits[0].score;
  for (const hit of hits) {
    if (hit.score > best) best = hit.score;
  }
  if (!(best >= threshold)) return [];
  const queryStems = stemsOf(query).size || 1;
  const ranked = [];
  for (const hit of hits) {
    const body = `${hit.section ?? ""}\n${hit.text ?? ""}`;
    const stems = sharedStemCount(query, body);
    if (hit.score < threshold || stems < minSharedStems) continue;
    ranked.push({ hit, rerank: hit.score * (stems / queryStems) });
  }
  ranked.sort((left, right) => right.rerank - left.rerank || right.hit.score - left.hit.score);
  return ranked.slice(0, k).map((item) => item.hit);
}

export function formatLawBlock(hits) {
  if (!hits?.length) return "";
  const lines = [LAW_INSTRUCTION];
  for (const hit of hits) {
    lines.push("", `[${hit.chunk_id}] ${hit.section}`, hit.text);
  }
  return lines.join("\n");
}

const FIT_MIN_CHARS = 80;

/**
 * Укладывает уже отобранные чанки в бюджет токенов окна локальной модели.
 * Сначала отбрасывается хвост (самые слабые), затем укорачивается текст оставшихся.
 * Индекс не пересобирается.
 */
export function fitLawHits(hits, { budgetTokens } = {}) {
  const source = (Array.isArray(hits) ? hits : []).map((hit) => ({
    ...hit,
    text: String(hit?.text ?? ""),
  }));
  const budget = Number(budgetTokens);
  if (!source.length || !Number.isFinite(budget)) {
    return { hits: source, law: formatLawBlock(source), dropped: 0, shortened: false };
  }
  const kept = source.slice();
  while (kept.length > 1 && estimateTokens(formatLawBlock(kept)) > budget) {
    kept.pop();
  }
  let shortened = false;
  let guard = 0;
  while (kept.length && estimateTokens(formatLawBlock(kept)) > budget && guard < 10000) {
    guard += 1;
    const index = kept.length - 1;
    const text = kept[index].text;
    if (kept.length > 1 && text.length <= FIT_MIN_CHARS) {
      kept.pop();
      continue;
    }
    if (text.length <= 1) break;
    const over = estimateTokens(formatLawBlock(kept)) - budget;
    const cut = Math.max(1, over * 4);
    const next = text.slice(0, Math.max(1, text.length - cut));
    if (next.length >= text.length) break;
    kept[index] = { ...kept[index], text: next };
    shortened = true;
  }
  return {
    hits: kept,
    law: formatLawBlock(kept),
    dropped: source.length - kept.length,
    shortened,
  };
}

export function lawSources(hits) {
  return (hits ?? []).map((hit) => ({
    source: hit.source ?? "",
    section: hit.section,
    chunk_id: hit.chunk_id,
    score: hit.score,
    file: hit.file,
  }));
}

export function formatLawSources(sources) {
  return (sources ?? [])
    .map((source) => {
      const title = [source.source, source.section].filter(Boolean).join(" | ");
      return `- ${title} [${source.chunk_id}] ${Number(source.score).toFixed(3)}`;
    })
    .join("\n");
}

export function isWeakLawContext(hits, threshold = LAW_SCORE_THRESHOLD) {
  if (!hits?.length) return true;
  let best = -Infinity;
  for (const hit of hits) {
    const score = Number(hit?.score);
    if (score > best) best = score;
  }
  return !(best >= threshold);
}

function foldSpace(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function verbatimSpan(chunk, quote) {
  const needle = foldSpace(quote);
  if (needle.length < MIN_QUOTE_LENGTH) return "";
  const parts = needle.split(" ").filter(Boolean).map(escapeRegExp);
  if (!parts.length) return "";
  const match = new RegExp(parts.join("\\s+")).exec(String(chunk ?? ""));
  return match ? match[0] : "";
}

export function parseCitedAnswer(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return "";
  const heading = "(?:^|\\n)\\s*(?:\\*\\*|__)?";
  let cut = raw.length;
  const sourcesAt = raw.search(new RegExp(`${heading}Источники\\s*(?:\\*\\*|__)?\\s*:`, "i"));
  const quotesAt = raw.search(new RegExp(`${heading}Цитаты\\s*(?:\\*\\*|__)?\\s*:`, "i"));
  if (sourcesAt >= 0) cut = Math.min(cut, sourcesAt);
  if (quotesAt >= 0) cut = Math.min(cut, quotesAt);
  let body = raw.slice(0, cut).trim();
  let previous;
  do {
    previous = body;
    body = body.replace(/^\s*(?:\*\*|__)?Ответ(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*/i, "").trim();
  } while (body !== previous);
  return body;
}

function quoteCandidates(text) {
  const raw = String(text ?? "");
  const found = [];
  for (const match of raw.matchAll(/«([^»]+)»/g)) {
    if (foldSpace(match[1]).length >= MIN_QUOTE_LENGTH) found.push(match[1]);
  }
  for (const match of raw.matchAll(/"([^"]+)"/g)) {
    if (foldSpace(match[1]).length >= MIN_QUOTE_LENGTH) found.push(match[1]);
  }
  const marker = raw.search(/(?:^|\n)\s*(?:\*\*|__)?Цитаты\s*(?:\*\*|__)?\s*:/i);
  if (marker >= 0) {
    let body = raw.slice(marker).replace(/^.*?Цитаты\s*(?:\*\*|__)?\s*:\s*/is, "");
    const next = body.search(/(?:^|\n)\s*(?:\*\*|__)?Источники\s*(?:\*\*|__)?\s*:/i);
    if (next >= 0) body = body.slice(0, next);
    for (const line of body.split("\n")) {
      const cleaned = line
        .replace(/^\s*[-*]\s*/, "")
        .replace(/^\[[^\]]+\]\s*/, "")
        .replace(/^[«"]/, "")
        .replace(/[»"]$/, "")
        .trim();
      if (foldSpace(cleaned).length >= MIN_QUOTE_LENGTH) found.push(cleaned);
    }
  }
  return found;
}

function excerptQuote(hit, focusText) {
  const text = String(hit?.text ?? "").trim();
  if (!text) return "";
  const sentences = text.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
  let best = "";
  let bestScore = 0;
  for (const sentence of sentences) {
    const score = sharedStemCount(focusText, sentence);
    if (score > bestScore) {
      bestScore = score;
      best = sentence;
    }
  }
  if (bestScore > 0 && best) return best;
  return text.slice(0, 240).trim();
}

export function formatCitedReply(answer, sources, quotes) {
  const lines = [`Ответ: ${String(answer ?? "").trim()}`, "", "Источники:"];
  for (const source of sources ?? []) {
    lines.push(`- ${source.source ?? ""} | ${source.section ?? ""} | ${source.chunk_id ?? ""}`);
  }
  lines.push("", "Цитаты:");
  for (const item of quotes ?? []) {
    lines.push(`- [${item.chunk_id}] «${item.quote}»`);
  }
  return lines.join("\n");
}

export function composeCitedReply(modelReply, hits) {
  const sources = lawSources(hits);
  const answer = parseCitedAnswer(modelReply);
  const quotes = [];
  const seen = new Set();
  const pushQuote = (hit, quote) => {
    const span = String(quote ?? "").trim();
    if (!span || !hit?.chunk_id) return;
    const key = `${hit.chunk_id}\0${foldSpace(span)}`;
    if (seen.has(key)) return;
    seen.add(key);
    quotes.push({
      quote: span,
      chunk_id: hit.chunk_id,
      section: hit.section ?? "",
      source: hit.source ?? "",
    });
  };
  for (const candidate of quoteCandidates(modelReply)) {
    for (const hit of hits ?? []) {
      const span = verbatimSpan(hit.text, candidate);
      if (!span) continue;
      pushQuote(hit, span);
      break;
    }
  }
  for (const hit of hits ?? []) {
    if (quotes.some((item) => item.chunk_id === hit.chunk_id)) continue;
    pushQuote(hit, excerptQuote(hit, answer));
  }
  return {
    reply: formatCitedReply(answer, sources, quotes),
    sources,
    quotes,
    abstained: false,
  };
}

export function quotesAreGrounded(quotes, hits) {
  if (!quotes?.length) return false;
  return quotes.every((item) => {
    const hit = (hits ?? []).find((candidate) => candidate.chunk_id === item.chunk_id);
    return Boolean(hit) && Boolean(verbatimSpan(hit.text, item.quote));
  });
}

export function citationAligned(answer, quotes, pattern) {
  let re;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    return false;
  }
  if (!re.test(String(answer ?? ""))) return false;
  return (quotes ?? []).some((item) => re.test(String(item?.quote ?? "")));
}

function foldQuestion(text) {
  return normalizeText(String(text ?? "").replace(/\s+/g, " ").trim());
}

export function formatLawQuality(query, reply, sources, questions = []) {
  const item = (questions ?? []).find((question) => foldQuestion(question.question) === foldQuestion(query));
  if (!item) return "Качество: вопрос не из контрольного набора";
  let expectHit = false;
  try {
    expectHit = new RegExp(item.pattern, "i").test(parseCitedAnswer(reply));
  } catch {
    expectHit = false;
  }
  const sourceHit = (sources ?? []).some((source) => String(source.section ?? "").startsWith(item.article));
  return `Качество: ожидание ${expectHit ? "да" : "нет"}, статья ${sourceHit ? "да" : "нет"}`;
}

export function retrieveLawContext(
  query,
  {
    indexPath,
    mode = "filtered",
    k = LAW_TOP_K,
    candidateK = LAW_CANDIDATE_K,
    threshold = LAW_SCORE_THRESHOLD,
    minSharedStems = LAW_MIN_SHARED_STEMS,
  } = {},
) {
  const plain = mode === "plain";
  const searchQuery = plain ? String(query ?? "").trim() : rewriteLawQuery(query);
  if (!indexPath || !existsSync(indexPath)) {
    return { hits: [], candidates: 0, dropped: 0, searchQuery };
  }
  const db = openIndex(indexPath, { readOnly: true });
  try {
    const fetched = searchChunks(db, embed(searchQuery), {
      strategy: "structural",
      k: plain ? k : candidateK,
    });
    if (plain) {
      return { hits: fetched, candidates: fetched.length, dropped: 0, searchQuery };
    }
    const hits = rerankLawHits(fetched, searchQuery, { threshold, minSharedStems, k });
    return {
      hits,
      candidates: fetched.length,
      dropped: fetched.length - hits.length,
      searchQuery,
    };
  } finally {
    db.close();
  }
}

export function attachLawContext(query, options = {}) {
  return retrieveLawContext(query, options).hits;
}

export async function answerWithRag(
  query,
  { indexPath, retrieve, generate, k, threshold = LAW_SCORE_THRESHOLD, mode, candidateK } = {},
) {
  if (typeof generate !== "function") {
    throw new Error("answerWithRag: нужен generate()");
  }
  const found = typeof retrieve === "function"
    ? retrieve(query)
    : attachLawContext(query, { indexPath, k, threshold, mode, candidateK });
  const hits = Array.isArray(found) ? found : [];
  if (isWeakLawContext(hits, threshold)) {
    return {
      reply: LAW_ABSTAIN_REPLY,
      law: "",
      hits,
      sources: [],
      quotes: [],
      abstained: true,
    };
  }
  const law = formatLawBlock(hits);
  const modelReply = await generate({ query, law, hits });
  const cited = composeCitedReply(modelReply, hits);
  return { reply: cited.reply, law, hits, sources: cited.sources, quotes: cited.quotes, abstained: false };
}
