import { existsSync } from "node:fs";
import { embed, normalizeText, tokensOf } from "./embed.js";
import { openIndex, searchChunks } from "./store.js";

export const LAW_CANDIDATE_K = 12;
export const LAW_TOP_K = 4;
export const LAW_SCORE_THRESHOLD = 0.36;
export const LAW_MIN_SHARED_STEMS = 2;

const LAW_INSTRUCTION =
  "Фрагменты Федерального закона «О рекламе». Опирайся на них и укажи номер статьи. Если нормы во фрагментах нет — так и скажи.";

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

export function lawSources(hits) {
  return (hits ?? []).map((hit) => ({
    section: hit.section,
    chunk_id: hit.chunk_id,
    score: hit.score,
    file: hit.file,
  }));
}

export function formatLawSources(sources) {
  return (sources ?? [])
    .map((source) => `- ${source.section} [${source.chunk_id}] ${Number(source.score).toFixed(3)}`)
    .join("\n");
}

function foldQuestion(text) {
  return normalizeText(String(text ?? "").replace(/\s+/g, " ").trim());
}

export function formatLawQuality(query, reply, sources, questions = []) {
  const item = (questions ?? []).find((question) => foldQuestion(question.question) === foldQuestion(query));
  if (!item) return "Качество: вопрос не из контрольного набора";
  let expectHit = false;
  try {
    expectHit = new RegExp(item.pattern, "i").test(String(reply ?? ""));
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

export async function answerWithRag(query, { indexPath, retrieve, generate, k, threshold, mode, candidateK } = {}) {
  if (typeof generate !== "function") {
    throw new Error("answerWithRag: нужен generate()");
  }
  const found = typeof retrieve === "function"
    ? retrieve(query)
    : attachLawContext(query, { indexPath, k, threshold, mode, candidateK });
  const hits = Array.isArray(found) ? found : [];
  const law = formatLawBlock(hits);
  const reply = await generate({ query, law, hits });
  return { reply, law, hits, sources: lawSources(hits) };
}
