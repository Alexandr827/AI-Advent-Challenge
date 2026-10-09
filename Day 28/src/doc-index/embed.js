export const EMBED_DIM = 256;

export function normalizeText(text) {
  return String(text ?? "")
    .toLowerCase()
    .replaceAll("ё", "е");
}

export function tokensOf(text) {
  return normalizeText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function addFeature(vec, feature, weight) {
  const hash = fnv1a(feature);
  const index = hash % EMBED_DIM;
  const sign = (hash & 1) === 0 ? 1 : -1;
  vec[index] += sign * weight;
}

export function embed(text) {
  const vec = new Float32Array(EMBED_DIM);
  for (const token of tokensOf(text)) {
    addFeature(vec, token, 1);
    const padded = ` ${token} `;
    for (let i = 0; i < padded.length - 2; i++) {
      addFeature(vec, padded.slice(i, i + 3), 0.5);
    }
  }
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }
  return vec;
}

export function cosine(left, right) {
  const size = Math.min(left.length, right.length);
  let score = 0;
  for (let i = 0; i < size; i++) score += left[i] * right[i];
  return score;
}
