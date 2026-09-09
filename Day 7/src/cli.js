export function tokenize(line) {
  const tokens = [];
  let current = "";
  let quote = null;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\" && i + 1 < line.length) {
        current += line[++i];
        continue;
      }
      if (ch === quote) {
        quote = null;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (quote) {
    throw new Error("Незакрытая кавычка");
  }
  if (current) tokens.push(current);
  return tokens;
}

function takeValue(tokens, index, flag) {
  const value = tokens[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Нужно значение для ${flag}`);
  }
  return value;
}

function parseSpawn(tokens) {
  const flags = {
    type: "spawn",
    name: undefined,
    model: undefined,
    systemPrompt: undefined,
    runtime: undefined,
    count: 1,
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--name") {
      flags.name = takeValue(tokens, ++i, token);
      continue;
    }
    if (token === "--model") {
      flags.model = takeValue(tokens, ++i, token);
      continue;
    }
    if (token === "--system") {
      flags.systemPrompt = takeValue(tokens, ++i, token);
      continue;
    }
    if (token === "--runtime") {
      flags.runtime = takeValue(tokens, ++i, token);
      continue;
    }
    if (token === "--count") {
      const raw = takeValue(tokens, ++i, token);
      const count = Number(raw);
      if (!Number.isInteger(count) || count < 1) {
        throw new Error("--count должен быть целым числом >= 1");
      }
      flags.count = count;
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Неизвестный флаг: ${token}`);
    }
    throw new Error(`Неожиданный аргумент: ${token}`);
  }

  return flags;
}

export function parseCommand(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed) return { type: "empty" };

  const tokens = tokenize(trimmed);
  const cmd = tokens[0].toLowerCase();
  const rest = tokens.slice(1);

  if (cmd === "help" || cmd === "?") return { type: "help" };
  if (cmd === "exit" || cmd === "quit") return { type: "exit" };

  if (cmd === "list") {
    if (rest.length) {
      throw new Error("list не принимает аргументы");
    }
    return { type: "list" };
  }

  if (cmd === "spawn") {
    return parseSpawn(rest);
  }

  if (cmd === "ask") {
    if (rest.length < 2) {
      throw new Error("Использование: ask <name|id> <текст>");
    }
    return {
      type: "ask",
      target: rest[0],
      text: rest.slice(1).join(" "),
    };
  }

  if (cmd === "kill") {
    if (rest.length === 1 && rest[0].toLowerCase() === "all") {
      return { type: "kill", all: true };
    }
    if (rest.length !== 1) {
      throw new Error("Использование: kill <name|id> | kill all");
    }
    return { type: "kill", all: false, target: rest[0] };
  }

  throw new Error(`Неизвестная команда: ${tokens[0]}. Введите help.`);
}

export function helpText() {
  return [
    "Команды:",
    '  spawn [--name NAME] [--model MODEL] [--system "..."] [--runtime local|cloud] [--count N]',
    "  ask <name|id> <текст>",
    "  list",
    "  kill <name|id>          удаляет агента и его сохранённую историю",
    "  kill all",
    "  help",
    "  exit",
  ].join("\n");
}
