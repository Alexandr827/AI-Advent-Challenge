export const DEFAULT_COMPRESS_EVERY = 3;
const SUMMARY_CLIP = 240;

export function formatHistory(messages) {
  return messages
    .map((item) => `${item.role === "user" ? "User" : "Assistant"}: ${item.content}`)
    .join("\n\n");
}

export function parseCompressEvery(raw, flag = "--compress-every") {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${flag} должен быть целым числом >= 1`);
  }
  return n;
}

export function normalizeCompressEvery(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_COMPRESS_EVERY;
}

export function normalizeCompress(value, { legacy = false } = {}) {
  if (typeof value === "boolean") return value;
  if (legacy) return true;
  return false;
}

export function envCompress() {
  const raw = process.env.CURSOR_COMPRESS?.trim().toLowerCase();
  if (!raw) return false;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function envCompressEvery() {
  const raw = process.env.CURSOR_COMPRESS_EVERY?.trim();
  if (!raw) return DEFAULT_COMPRESS_EVERY;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_COMPRESS_EVERY;
}

export function resolveCompressConfig({ compress, compressEvery } = {}) {
  const every =
    compressEvery != null ? normalizeCompressEvery(compressEvery) : envCompressEvery();
  let enabled;
  if (typeof compress === "boolean") {
    enabled = compress;
  } else if (compressEvery != null) {
    enabled = true;
  } else {
    enabled = envCompress();
  }
  return { compress: enabled, compressEvery: every };
}

export function normalizeSummarizedCount(value, messageCount = 0) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return 0;
  return Math.min(n, messageCount);
}

export function promptMessages(messages, summarizedCount = 0) {
  const list = Array.isArray(messages) ? messages : [];
  return list.slice(normalizeSummarizedCount(summarizedCount, list.length));
}

export function pendingToSummarize(
  messages,
  summarizedCount = 0,
  every = DEFAULT_COMPRESS_EVERY,
) {
  const window = normalizeCompressEvery(every);
  const list = Array.isArray(messages) ? messages : [];
  const covered = normalizeSummarizedCount(summarizedCount, list.length);
  const end = Math.max(covered, list.length - window);
  const pending = list.slice(covered, end);
  const n = pending.length - (pending.length % window);
  return n > 0 ? pending.slice(0, n) : [];
}

function clipText(text) {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= SUMMARY_CLIP) return s;
  return `${s.slice(0, SUMMARY_CLIP)}…`;
}

export function foldSummary(previous, batch) {
  const chunk = (Array.isArray(batch) ? batch : [])
    .map((item) => {
      const role = item?.role === "user" ? "User" : "Assistant";
      return `${role}: ${clipText(item?.content)}`;
    })
    .filter((line) => !line.endsWith(": "))
    .join("\n");
  if (!chunk) return String(previous ?? "");
  const prev = String(previous ?? "").trim();
  return prev ? `${prev}\n${chunk}` : chunk;
}
