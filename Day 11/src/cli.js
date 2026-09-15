import { parseCompressEvery } from "./context.js";
import {
  isKindToken,
  parseKind,
  parseLayer,
  parseLayerToken,
} from "./memory.js";
import { parseStrategy, parseWindow } from "./strategy.js";
import { parseContextLimit } from "./tokens.js";

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
    contextLimit: undefined,
    compress: undefined,
    compressEvery: undefined,
    strategy: undefined,
    window: undefined,
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
    if (token === "--limit") {
      flags.contextLimit = parseContextLimit(
        takeValue(tokens, ++i, token),
        token,
      );
      continue;
    }
    if (token === "--compress") {
      flags.compress = true;
      continue;
    }
    if (token === "--no-compress") {
      flags.compress = false;
      continue;
    }
    if (token === "--compress-every") {
      flags.compressEvery = parseCompressEvery(
        takeValue(tokens, ++i, token),
        token,
      );
      continue;
    }
    if (token === "--strategy") {
      flags.strategy = parseStrategy(takeValue(tokens, ++i, token), token);
      continue;
    }
    if (token === "--window") {
      flags.window = parseWindow(takeValue(tokens, ++i, token), token);
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Неизвестный флаг: ${token}`);
    }
    throw new Error(`Неожиданный аргумент: ${token}`);
  }

  return flags;
}

function parseStrategyCommand(rest) {
  if (!rest.length) {
    throw new Error(
      "Использование: strategy <name|id> [sliding|facts|branching|full] [--window N]",
    );
  }
  const flags = {
    type: "strategy",
    target: rest[0],
    strategy: undefined,
    window: undefined,
  };
  for (let i = 1; i < rest.length; i++) {
    const token = rest[i];
    if (token === "--window") {
      flags.window = parseWindow(takeValue(rest, ++i, token), token);
      continue;
    }
    if (token.startsWith("--")) {
      throw new Error(`Неизвестный флаг: ${token}`);
    }
    if (flags.strategy) {
      throw new Error(`Неожиданный аргумент: ${token}`);
    }
    flags.strategy = parseStrategy(token, "strategy");
  }
  return flags;
}

function parseRememberCommand(rest) {
  if (rest.length < 3) {
    throw new Error(
      "Использование: remember <name|id> <short|working|long[:profile|decisions|knowledge]> <ключ>: <значение>",
    );
  }
  const target = rest[0];
  const parsed = parseLayerToken(rest[1], "remember");
  let kind = parsed.kind;
  let payloadStart = 2;
  if (parsed.layer === "long" && !kind && rest[2] && isKindToken(rest[2])) {
    kind = parseKind(rest[2], "remember");
    payloadStart = 3;
  }
  const payload = rest.slice(payloadStart).join(" ");
  if (!payload.trim()) {
    throw new Error(
      "Использование: remember <name|id> <short|working|long[:kind]> <ключ>: <значение>",
    );
  }
  return {
    type: "remember",
    target,
    layer: parsed.layer,
    kind,
    payload,
  };
}

function parseForgetCommand(rest) {
  if (rest.length < 2 || rest.length > 4) {
    throw new Error(
      "Использование: forget <name|id> <short|working|long[:profile|decisions|knowledge]> [ключ]",
    );
  }
  const target = rest[0];
  const parsed = parseLayerToken(rest[1], "forget");
  let kind = parsed.kind;
  let index = 2;
  if (parsed.layer === "long" && !kind && rest[2] && isKindToken(rest[2])) {
    kind = parseKind(rest[2], "forget");
    index = 3;
  }
  const key = rest[index];
  if (rest.length > index + 1) {
    throw new Error(`Неожиданный аргумент: ${rest[index + 1]}`);
  }
  return {
    type: "forget",
    target,
    layer: parsed.layer,
    kind,
    key,
  };
}

function parseMemoryCommand(rest) {
  if (!rest.length || rest.length > 2) {
    throw new Error("Использование: memory <name|id> [short|working|long]");
  }
  return {
    type: "memory",
    target: rest[0],
    layer: rest[1] ? parseLayer(rest[1], "memory") : undefined,
  };
}

function parseTaskCommand(rest) {
  if (!rest.length) {
    throw new Error("Использование: task <name|id> [start [название] | clear]");
  }
  const target = rest[0];
  if (rest.length === 1) {
    return { type: "task", target, action: "show" };
  }
  const action = rest[1].toLowerCase();
  if (action === "clear" || action === "reset") {
    if (rest.length !== 2) {
      throw new Error("Использование: task <name|id> clear");
    }
    return { type: "task", target, action: "clear" };
  }
  if (action === "start" || action === "new") {
    return {
      type: "task",
      target,
      action: "start",
      title: rest.slice(2).join(" "),
    };
  }
  throw new Error("Использование: task <name|id> [start [название] | clear]");
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

  if (cmd === "tokens") {
    if (rest.length !== 1) {
      throw new Error("Использование: tokens <name|id>");
    }
    return { type: "tokens", target: rest[0] };
  }

  if (cmd === "strategy") {
    return parseStrategyCommand(rest);
  }

  if (cmd === "window") {
    if (rest.length !== 2) {
      throw new Error("Использование: window <name|id> N");
    }
    return {
      type: "window",
      target: rest[0],
      window: parseWindow(rest[1], "window"),
    };
  }

  if (cmd === "facts") {
    if (rest.length !== 1) {
      throw new Error("Использование: facts <name|id>");
    }
    return { type: "facts", target: rest[0] };
  }

  if (cmd === "checkpoint") {
    if (rest.length !== 1) {
      throw new Error("Использование: checkpoint <name|id>");
    }
    return { type: "checkpoint", target: rest[0] };
  }

  if (cmd === "branch") {
    if (rest.length !== 3) {
      throw new Error("Использование: branch <name|id> <ветка1> <ветка2>");
    }
    return {
      type: "branch",
      target: rest[0],
      branchA: rest[1],
      branchB: rest[2],
    };
  }

  if (cmd === "use") {
    if (rest.length !== 2) {
      throw new Error("Использование: use <name|id> <ветка>");
    }
    return { type: "use", target: rest[0], branch: rest[1] };
  }

  if (cmd === "branches") {
    if (rest.length !== 1) {
      throw new Error("Использование: branches <name|id>");
    }
    return { type: "branches", target: rest[0] };
  }

  if (cmd === "remember") {
    return parseRememberCommand(rest);
  }

  if (cmd === "forget") {
    return parseForgetCommand(rest);
  }

  if (cmd === "memory") {
    return parseMemoryCommand(rest);
  }

  if (cmd === "task") {
    return parseTaskCommand(rest);
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
    '  spawn [--name NAME] [--model MODEL] [--system "..."] [--runtime local|cloud] [--count N] [--limit N]',
    "                            [--compress] [--compress-every N] [--no-compress]",
    "                            [--strategy sliding|facts|branching|full] [--window N]",
    "                            --limit N — лимит контекста (токены) этого агента",
    "                            --compress — сжимать историю (последние N как есть, старше в summary)",
    "                            --compress-every N — порог сжатия, по умолчанию через CURSOR_COMPRESS_EVERY; включает --compress",
    "                            --no-compress — выключить сжатие (если в .env включено)",
    "                            --strategy — управление контекстом: sliding | facts | branching | full",
    "                            --window N — последние N сообщений для sliding и facts (по умолчанию 8)",
    "  ask <name|id> <текст>     реплика идёт в messages (краткосрочный диалог)",
    "                            префикс: /short | /working | /long[:profile|decisions|knowledge] …",
    "                            — сначала запись в слой, затем тот же текст уходит в модель",
    "",
    "  Память (short / working / long у каждого агента; не путать со strategy facts):",
    "  remember <name|id> <short|working|long[:kind]> <ключ>: <значение>",
    "                            явная запись (long: profile | decisions | knowledge)",
    "  forget <name|id> <short|working|long[:kind]> [ключ]",
    "                            слой или ключ; forget short без ключа — также messages и summary",
    "  memory <name|id> [short|working|long]",
    "                            показать записи (слои раздельны)",
    "  task <name|id> [start [название] | clear]",
    "                            start — новая задача, очищает только working; long не трогает",
    "  strategy <name|id> [sliding|facts|branching|full] [--window N]",
    "                            без стратегии — показать текущую; со стратегией — переключить",
    "  window <name|id> N      размер окна для sliding / facts",
    "  facts <name|id>         показать key-value память (стратегия facts)",
    "  checkpoint <name|id>    сохранить чекпоинт (стратегия branching)",
    "  branch <name|id> A B    две ветки от чекпоинта (или от текущего места)",
    "  use <name|id> <ветка>   переключиться на ветку",
    "  branches <name|id>      список веток",
    "  tokens <name|id>        затраченные токены агента (история, последний ход, сумма)",
    "  list                    memory=s/w/l — число записей по слоям",
    "  kill <name|id>          удаляет агента и его сохранённую историю",
    "  kill all",
    "  help",
    "  exit",
  ].join("\n");
}
