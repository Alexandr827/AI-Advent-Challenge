import { existsSync } from "node:fs";
import { embed, tokensOf } from "./embed.js";
import { openIndex, searchChunks } from "./store.js";

export const LAW_TOP_K = 4;
export const LAW_SCORE_THRESHOLD = 0.36;
export const LAW_MIN_SHARED_STEMS = 2;

const LAW_INSTRUCTION =
  "Фрагменты Федерального закона «О рекламе». Опирайся на них и укажи номер статьи. Если нормы во фрагментах нет — так и скажи.";

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

export function attachLawContext(query, { indexPath, k = LAW_TOP_K, threshold = LAW_SCORE_THRESHOLD } = {}) {
  if (!indexPath || !existsSync(indexPath)) return [];
  const db = openIndex(indexPath, { readOnly: true });
  try {
    const hits = searchChunks(db, embed(query), { strategy: "structural", k });
    return selectLawHits(hits, threshold, query);
  } finally {
    db.close();
  }
}
