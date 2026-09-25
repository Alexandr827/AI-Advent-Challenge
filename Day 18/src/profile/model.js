export const SECTION_STYLE = "style";
export const SECTION_CONSTRAINTS = "constraints";
export const SECTION_CONTEXT = "context";

export const PROFILE_SECTIONS = [
  SECTION_STYLE,
  SECTION_CONSTRAINTS,
  SECTION_CONTEXT,
];

export const STYLE_LENGTH = "length";
export const STYLE_TONE = "tone";
export const STYLE_EXAMPLES = "examples";
export const STYLE_LANGUAGE = "language";

export const CONSTRAINT_STACK = "stack";
export const CONSTRAINT_ARCHITECTURE = "architecture";
export const CONSTRAINT_DEPENDENCIES = "dependencies";
export const CONSTRAINT_APIS = "apis";

export const CONTEXT_ROLE = "role";
export const CONTEXT_PROJECT = "project";
export const CONTEXT_TEAM = "team";
export const CONTEXT_DEADLINE = "deadline";

const SECTION_ALIASES = {
  style: SECTION_STYLE,
  стиль: SECTION_STYLE,
  constraints: SECTION_CONSTRAINTS,
  constraint: SECTION_CONSTRAINTS,
  ограничения: SECTION_CONSTRAINTS,
  ограничение: SECTION_CONSTRAINTS,
  context: SECTION_CONTEXT,
  контекст: SECTION_CONTEXT,
};

const KEY_ALIASES = {
  [SECTION_STYLE]: {
    length: STYLE_LENGTH,
    объём: STYLE_LENGTH,
    объем: STYLE_LENGTH,
    ответы: STYLE_LENGTH,
    verbosity: STYLE_LENGTH,
    tone: STYLE_TONE,
    тон: STYLE_TONE,
    examples: STYLE_EXAMPLES,
    example: STYLE_EXAMPLES,
    code: STYLE_EXAMPLES,
    примеры: STYLE_EXAMPLES,
    код: STYLE_EXAMPLES,
    language: STYLE_LANGUAGE,
    lang: STYLE_LANGUAGE,
    язык: STYLE_LANGUAGE,
  },
  [SECTION_CONSTRAINTS]: {
    stack: CONSTRAINT_STACK,
    стек: CONSTRAINT_STACK,
    architecture: CONSTRAINT_ARCHITECTURE,
    архитектура: CONSTRAINT_ARCHITECTURE,
    arch: CONSTRAINT_ARCHITECTURE,
    dependencies: CONSTRAINT_DEPENDENCIES,
    dependency: CONSTRAINT_DEPENDENCIES,
    deps: CONSTRAINT_DEPENDENCIES,
    зависимости: CONSTRAINT_DEPENDENCIES,
    apis: CONSTRAINT_APIS,
    api: CONSTRAINT_APIS,
  },
  [SECTION_CONTEXT]: {
    role: CONTEXT_ROLE,
    роль: CONTEXT_ROLE,
    project: CONTEXT_PROJECT,
    проект: CONTEXT_PROJECT,
    team: CONTEXT_TEAM,
    команда: CONTEXT_TEAM,
    deadline: CONTEXT_DEADLINE,
    дедлайн: CONTEXT_DEADLINE,
    срок: CONTEXT_DEADLINE,
  },
};

const KEY_TITLES = {
  [SECTION_STYLE]: {
    [STYLE_LENGTH]: "объём ответа",
    [STYLE_TONE]: "тон",
    [STYLE_EXAMPLES]: "примеры кода",
    [STYLE_LANGUAGE]: "язык ответа",
  },
  [SECTION_CONSTRAINTS]: {
    [CONSTRAINT_STACK]: "стек",
    [CONSTRAINT_ARCHITECTURE]: "архитектура",
    [CONSTRAINT_DEPENDENCIES]: "зависимости",
    [CONSTRAINT_APIS]: "api",
  },
  [SECTION_CONTEXT]: {
    [CONTEXT_ROLE]: "роль",
    [CONTEXT_PROJECT]: "проект",
    [CONTEXT_TEAM]: "команда",
    [CONTEXT_DEADLINE]: "дедлайн",
  },
};

const SECTION_TITLES = {
  [SECTION_STYLE]: "стиль",
  [SECTION_CONSTRAINTS]: "ограничения",
  [SECTION_CONTEXT]: "контекст",
};

const STYLE_VALUE_HINTS = {
  [STYLE_LENGTH]: [
    [STYLE_LENGTH, /^(brief|short|кратк)/i, "brief"],
    [STYLE_LENGTH, /^(detailed|long|подробн)/i, "detailed"],
  ],
  [STYLE_TONE]: [
    [STYLE_TONE, /^(formal|формальн)/i, "formal"],
    [STYLE_TONE, /^(casual|informal|разговорн)/i, "casual"],
  ],
  [STYLE_EXAMPLES]: [
    [STYLE_EXAMPLES, /^(none|no|без|false|0)/i, "none"],
    [STYLE_EXAMPLES, /^(code|yes|with|с\s|пример|true|1)/i, "code"],
  ],
  [STYLE_LANGUAGE]: [
    [STYLE_LANGUAGE, /^(ru|рус)/i, "ru"],
    [STYLE_LANGUAGE, /^(en|англ)/i, "en"],
  ],
};

const STYLE_VALUE_LABELS = {
  [STYLE_LENGTH]: { brief: "краткие ответы", detailed: "подробные ответы" },
  [STYLE_TONE]: { formal: "формальный", casual: "разговорный" },
  [STYLE_EXAMPLES]: { code: "с примерами кода", none: "без примеров кода" },
  [STYLE_LANGUAGE]: { ru: "русский", en: "английский" },
};

export function parseUserId(raw, flag = "user_id") {
  const id = String(raw ?? "").trim();
  if (!id) {
    throw new Error(`${flag} не может быть пустым`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(
      `${flag} только латиница, цифры, точка, подчёркивание и дефис`,
    );
  }
  return id;
}

export function parseSection(raw, flag = "секция профиля") {
  const key = String(raw ?? "")
    .trim()
    .replace(/:$/, "")
    .toLowerCase();
  const section = SECTION_ALIASES[key];
  if (!section) {
    throw new Error(
      `${flag} должен быть style, constraints или context (стиль / ограничения / контекст)`,
    );
  }
  return section;
}

export function canonicalSectionKey(section, raw) {
  const map = KEY_ALIASES[section];
  if (!map) return "";
  const key = String(raw ?? "")
    .trim()
    .replace(/:$/, "")
    .toLowerCase();
  return map[key] || "";
}

export function parseSectionKey(section, raw, flag = "ключ") {
  const target = parseSection(section, flag);
  const key = String(raw ?? "")
    .trim()
    .replace(/:$/, "");
  if (!key) {
    throw new Error(`${flag} не может быть пустым`);
  }
  return canonicalSectionKey(target, key) || key;
}

export function sectionTitle(section) {
  return SECTION_TITLES[parseSection(section)] ?? section;
}

export function keyTitle(section, key) {
  const target = parseSection(section);
  return KEY_TITLES[target]?.[key] ?? key;
}

export function emptyProfile(userId = "") {
  return {
    userId: userId ? String(userId) : "",
    name: "",
    style: {},
    constraints: {},
    context: {},
  };
}

function normalizeMap(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return {};
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(row)) {
    const key = String(rawKey ?? "").trim();
    const value = String(rawValue ?? "").trim();
    if (key && value && value !== "(пусто)") out[key] = value;
  }
  return out;
}

function canonicalizeMap(section, row) {
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(normalizeMap(row))) {
    const key = canonicalSectionKey(section, rawKey) || rawKey;
    const value =
      section === SECTION_STYLE
        ? normalizeStyleValue(key, rawValue)
        : rawValue;
    if (!out[key]) out[key] = value;
  }
  return out;
}

export function normalizeStyleValue(key, raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const hints = STYLE_VALUE_HINTS[key];
  if (!hints) return text;
  for (const [, re, canonical] of hints) {
    if (re.test(text)) return canonical;
  }
  return text;
}

export function formatStyleValue(key, value) {
  const text = String(value ?? "").trim();
  return STYLE_VALUE_LABELS[key]?.[text] ?? text;
}

export function normalizeProfile(row, fallbackId = "") {
  const userId = String(row?.userId ?? row?.user_id ?? fallbackId ?? "").trim();
  return {
    userId,
    name: String(row?.name ?? "").trim(),
    style: canonicalizeMap(SECTION_STYLE, row?.style),
    constraints: canonicalizeMap(SECTION_CONSTRAINTS, row?.constraints),
    context: canonicalizeMap(SECTION_CONTEXT, row?.context),
  };
}

export function cloneProfile(profile) {
  const src = normalizeProfile(profile);
  return {
    userId: src.userId,
    name: src.name,
    style: { ...src.style },
    constraints: { ...src.constraints },
    context: { ...src.context },
  };
}

function mapSize(map) {
  return Object.keys(map ?? {}).length;
}

export function profileCounts(profile) {
  const src = normalizeProfile(profile);
  return {
    style: mapSize(src.style),
    constraints: mapSize(src.constraints),
    context: mapSize(src.context),
  };
}

export function hasPersonalization(profile) {
  const src = normalizeProfile(profile);
  const counts = profileCounts(src);
  return (
    Boolean(src.name) ||
    counts.style + counts.constraints + counts.context > 0
  );
}

export function profileSnapshot(profile) {
  const src = normalizeProfile(profile);
  const counts = profileCounts(src);
  return {
    userId: src.userId,
    name: src.name,
    style: counts.style,
    constraints: counts.constraints,
    context: counts.context,
    active: hasPersonalization(src),
  };
}

export function setProfileEntry(profile, section, key, value) {
  const next = cloneProfile(profile);
  const target = parseSection(section);
  const parsedKey = parseSectionKey(target, key);
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error("Значение профиля не может быть пустым");
  }
  const stored =
    target === SECTION_STYLE ? normalizeStyleValue(parsedKey, text) : text;
  next[target][parsedKey] = stored;
  return { profile: next, section: target, key: parsedKey, value: stored };
}

export function clearProfileEntry(profile, section, key) {
  const next = cloneProfile(profile);
  if (!section) {
    const count =
      profileCounts(next).style +
      profileCounts(next).constraints +
      profileCounts(next).context +
      (next.name ? 1 : 0);
    next.name = "";
    next.style = {};
    next.constraints = {};
    next.context = {};
    return { profile: next, section: null, key: null, count };
  }
  const target = parseSection(section);
  if (!key) {
    const count = Object.keys(next[target]).length;
    next[target] = {};
    return { profile: next, section: target, key: null, count };
  }
  const parsedKey = parseSectionKey(target, key);
  if (!(parsedKey in next[target])) {
    throw new Error(
      `В секции «${sectionTitle(target)}» нет ключа: ${parsedKey}`,
    );
  }
  delete next[target][parsedKey];
  return { profile: next, section: target, key: parsedKey, count: 1 };
}

export function formatProfile(profile) {
  const src = normalizeProfile(profile);
  const lines = [
    `Профиль ${src.userId || "(без id)"}` + (src.name ? ` — ${src.name}` : ""),
  ];
  for (const section of PROFILE_SECTIONS) {
    lines.push(`  [${sectionTitle(section)}]`);
    const entries = Object.entries(src[section]);
    if (!entries.length) {
      lines.push("    (пусто)");
      continue;
    }
    for (const [key, value] of entries) {
      const shown =
        section === SECTION_STYLE ? formatStyleValue(key, value) : value;
      lines.push(`    ${keyTitle(section, key)}: ${shown}`);
    }
  }
  return lines.join("\n");
}
