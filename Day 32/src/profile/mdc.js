function parseFrontmatter(block) {
  const out = {};
  for (const line of String(block ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf(":");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value === "true") out[key] = true;
    else if (value === "false") out[key] = false;
    else out[key] = value;
  }
  return out;
}

export function parseEntries(body) {
  const out = {};
  for (const line of String(body ?? "").split("\n")) {
    const match = line.match(
      /^\s*(?:[-*]\s+)?(?:\*\*)?([A-Za-zА-Яа-яЁё0-9_.-]+)(?:\*\*)?\s*[:=]\s*(.+?)\s*$/u,
    );
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2].trim();
    if (!key || !value || value === "(пусто)") continue;
    out[key] = value;
  }
  return out;
}

export function parseMdc(text) {
  const raw = String(text ?? "");
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: raw, entries: parseEntries(raw) };
  }
  const frontmatter = parseFrontmatter(match[1]);
  const body = match[2] ?? "";
  return { frontmatter, body, entries: parseEntries(body) };
}

function yamlValue(value) {
  const text = String(value ?? "");
  if (text === "true" || text === "false") return text;
  if (/[:#]/.test(text) || /\s/.test(text)) return JSON.stringify(text);
  return text;
}

export function serializeMdc({
  description,
  kind,
  user,
  alwaysApply = true,
  title,
  entries = {},
}) {
  const items = Object.entries(entries).filter(
    ([, value]) => String(value ?? "").trim() && String(value).trim() !== "(пусто)",
  );
  const body = items.length
    ? items.map(([key, value]) => `- ${key}: ${value}`).join("\n")
    : "";
  return [
    "---",
    `description: ${yamlValue(description)}`,
    `alwaysApply: ${alwaysApply ? "true" : "false"}`,
    `kind: ${kind}`,
    `user: ${user}`,
    "---",
    "",
    `# ${title}`,
    "",
    body,
    "",
  ].join("\n");
}

export function serializeProfileMarkdown({ userId, name }) {
  const title = name || userId || "profile";
  const lines = [
    "---",
    `user: ${userId}`,
    `name: ${yamlValue(name || "")}`,
    "---",
    "",
    `# Profile: ${title}`,
    "",
    `- user_id: ${userId}`,
  ];
  if (name) lines.push(`- name: ${name}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}
