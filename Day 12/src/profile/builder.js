import {
  formatStyleValue,
  hasPersonalization,
  keyTitle,
  normalizeProfile,
  PROFILE_SECTIONS,
  SECTION_STYLE,
  sectionTitle,
} from "./model.js";

function sectionLines(section, entries) {
  const list = Object.entries(entries ?? {});
  if (!list.length) return [];
  const lines = [`[${sectionTitle(section)}]`];
  for (const [key, value] of list) {
    const shown =
      section === SECTION_STYLE ? formatStyleValue(key, value) : value;
    lines.push(`- ${keyTitle(section, key)}: ${shown}`);
  }
  return lines;
}

export function formatProfilePrompt(profile) {
  const src = normalizeProfile(profile);
  if (!hasPersonalization(src)) return "";
  const lines = [];
  const who = [src.userId, src.name].filter(Boolean).join(" / ");
  lines.push(
    `Персонализация${who ? ` (${who})` : ""} — соблюдай в этом ответе; не противоречь без новой явной записи.`,
  );
  for (const section of PROFILE_SECTIONS) {
    lines.push(...sectionLines(section, src[section]));
  }
  return lines.filter(Boolean).join("\n");
}

export function joinPromptParts(parts, query) {
  const blocks = parts.filter((item) => String(item ?? "").trim());
  const text = String(query ?? "");
  if (!blocks.length) return text;
  if (!text) return blocks.join("\n\n");
  return `${blocks.join("\n\n")}\n\n${text}`;
}

export function buildPrompt({
  system = "",
  profile = null,
  memory = "",
  facts = "",
  summary = "",
  history = "",
  query = "",
  includeSystem = true,
  includeMemory = true,
  includeHistory = true,
} = {}) {
  const profileBlock = formatProfilePrompt(profile);
  const parts = [];
  if (includeSystem && system) parts.push(system);
  if (profileBlock) parts.push(profileBlock);
  if (includeMemory && memory) parts.push(memory);
  if (facts) parts.push(facts);
  if (includeHistory && summary) parts.push(summary);
  if (includeHistory && history) parts.push(history);
  return joinPromptParts(parts, query);
}

export async function runProfilePipeline({
  loader,
  userId,
  system = "",
  query,
  memory = "",
  facts = "",
  summary = "",
  history = "",
  includeSystem = true,
  includeMemory = true,
  includeHistory = true,
  generate,
}) {
  if (typeof generate !== "function") {
    throw new Error("Profile pipeline: нужен generate()");
  }
  const profile = userId ? await loader.load(userId) : normalizeProfile({});
  const prompt = buildPrompt({
    system,
    profile,
    memory,
    facts,
    summary,
    history,
    query,
    includeSystem,
    includeMemory,
    includeHistory,
  });
  const response = await generate(prompt);
  return { profile, prompt, response };
}
