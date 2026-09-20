import { parseCompressEvery } from "./context.js";
import {
  isKindToken,
  parseKind,
  parseLayer,
  parseLayerToken,
} from "./memory.js";
import {
  parseSection,
  parseSectionKey,
  parseUserId,
} from "./profile.js";
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
    profileId: undefined,
    invariantSetId: undefined,
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
    if (token === "--profile") {
      flags.profileId = parseUserId(takeValue(tokens, ++i, token), "--profile");
      continue;
    }
    if (token === "--invariants" || token === "--invariant") {
      flags.invariantSetId = parseUserId(
        takeValue(tokens, ++i, token),
        token,
      );
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

function parseProfileCommand(rest) {
  if (!rest.length) {
    throw new Error(
      "Использование: profile create <user_id> [--name NAME] | list | delete <user_id> | attach <агент> <user_id> | detach <агент> | <user_id> [clear [секция [ключ]] | name <имя>]",
    );
  }
  const head = rest[0].toLowerCase();
  if (head === "create") {
    if (rest.length < 2) {
      throw new Error("Использование: profile create <user_id> [--name NAME]");
    }
    const flags = { type: "profile", action: "create", userId: parseUserId(rest[1], "user_id"), name: "" };
    for (let i = 2; i < rest.length; i++) {
      if (rest[i] === "--name") {
        flags.name = takeValue(rest, ++i, "--name");
        continue;
      }
      if (rest[i].startsWith("--")) {
        throw new Error(`Неизвестный флаг: ${rest[i]}`);
      }
      flags.name = flags.name
        ? `${flags.name} ${rest[i]}`
        : rest.slice(i).join(" ");
      break;
    }
    return flags;
  }
  if (head === "list") {
    if (rest.length !== 1) throw new Error("Использование: profile list");
    return { type: "profile", action: "list" };
  }
  if (head === "delete" || head === "remove" || head === "rm") {
    if (rest.length !== 2) {
      throw new Error("Использование: profile delete <user_id>");
    }
    return {
      type: "profile",
      action: "delete",
      userId: parseUserId(rest[1], "user_id"),
    };
  }
  if (head === "attach") {
    if (rest.length !== 3) {
      throw new Error("Использование: profile attach <агент> <user_id>");
    }
    return {
      type: "profile",
      action: "attach",
      target: rest[1],
      userId: parseUserId(rest[2], "user_id"),
    };
  }
  if (head === "detach") {
    if (rest.length !== 2) {
      throw new Error("Использование: profile detach <агент>");
    }
    return { type: "profile", action: "detach", target: rest[1] };
  }
  const userId = parseUserId(rest[0], "user_id");
  if (rest.length === 1) {
    return { type: "profile", action: "show", userId };
  }
  const action = rest[1].toLowerCase().replace(/:$/, "");
  if (action === "show" || action === "get") {
    if (rest.length !== 2) throw new Error("Использование: profile <user_id>");
    return { type: "profile", action: "show", userId };
  }
  if (action === "name" || action === "имя") {
    const name = rest.slice(2).join(" ").trim();
    if (!name) throw new Error("Использование: profile <user_id> name <имя>");
    return { type: "profile", action: "name", userId, name };
  }
  if (action === "clear" || action === "reset") {
    return {
      type: "profile",
      action: "clear",
      userId,
      section: rest[2],
      key: rest[3],
    };
  }
  if (action === "delete" || action === "remove" || action === "rm") {
    if (rest.length !== 2) {
      throw new Error("Использование: profile delete <user_id>");
    }
    return { type: "profile", action: "delete", userId };
  }
  throw new Error(
    "Использование: profile <user_id> | profile <user_id> name <имя> | profile <user_id> clear [секция [ключ]] | profile delete <user_id>",
  );
}

function parseSectionSetCommand(section, rest) {
  if (!rest.length) {
    throw new Error(
      `Использование: ${section} <user_id> [<ключ> <значение>]`,
    );
  }
  const userId = parseUserId(rest[0], "user_id");
  if (rest.length === 1) {
    return { type: section, action: "show", userId, section };
  }
  if (rest.length < 3) {
    throw new Error(
      `Использование: ${section} <user_id> <ключ> <значение>`,
    );
  }
  return {
    type: section,
    action: "set",
    userId,
    section,
    key: parseSectionKey(section, rest[1], section),
    value: rest.slice(2).join(" ").trim(),
  };
}

function parseInvariantCommand(rest) {
  if (!rest.length) {
    throw new Error(
      "Использование: invariant create <set_id> | list | delete <set_id> | attach <агент> <set_id> | detach <агент> | add <set_id> <тип> … | rm <set_id> [id] | <set_id>",
    );
  }
  const head = rest[0].toLowerCase();
  if (head === "create") {
    if (rest.length !== 2) {
      throw new Error("Использование: invariant create <set_id>");
    }
    return {
      type: "invariant",
      action: "create",
      setId: parseUserId(rest[1], "set_id"),
    };
  }
  if (head === "list") {
    if (rest.length !== 1) throw new Error("Использование: invariant list");
    return { type: "invariant", action: "list" };
  }
  if (head === "delete" || head === "remove") {
    if (rest.length !== 2) {
      throw new Error("Использование: invariant delete <set_id>");
    }
    return {
      type: "invariant",
      action: "delete",
      setId: parseUserId(rest[1], "set_id"),
    };
  }
  if (head === "attach") {
    if (rest.length !== 3) {
      throw new Error("Использование: invariant attach <агент> <set_id>");
    }
    return {
      type: "invariant",
      action: "attach",
      target: rest[1],
      setId: parseUserId(rest[2], "set_id"),
    };
  }
  if (head === "detach") {
    if (rest.length !== 2) {
      throw new Error("Использование: invariant detach <агент>");
    }
    return { type: "invariant", action: "detach", target: rest[1] };
  }
  if (head === "add") {
    if (rest.length < 3) {
      throw new Error(
        "Использование: invariant add <set_id> <stack|arch|budget|maxdeps|nobanned|decision|apis> …",
      );
    }
    return {
      type: "invariant",
      action: "add",
      setId: parseUserId(rest[1], "set_id"),
      specType: rest[2],
      specArgs: rest.slice(3),
    };
  }
  if (head === "rm") {
    if (rest.length < 2 || rest.length > 3) {
      throw new Error("Использование: invariant rm <set_id> [id|тип]");
    }
    return {
      type: "invariant",
      action: "rm",
      setId: parseUserId(rest[1], "set_id"),
      itemId: rest[2],
    };
  }
  const setId = parseUserId(rest[0], "set_id");
  if (rest.length === 1) {
    return { type: "invariant", action: "show", setId };
  }
  const action = rest[1].toLowerCase();
  if (action === "show" || action === "get") {
    if (rest.length !== 2) throw new Error("Использование: invariant <set_id>");
    return { type: "invariant", action: "show", setId };
  }
  if (action === "add") {
    if (rest.length < 3) {
      throw new Error(
        "Использование: invariant <set_id> add <stack|arch|budget|maxdeps|nobanned|decision|apis> …",
      );
    }
    return {
      type: "invariant",
      action: "add",
      setId,
      specType: rest[2],
      specArgs: rest.slice(3),
    };
  }
  if (action === "rm" || action === "clear") {
    return {
      type: "invariant",
      action: "rm",
      setId,
      itemId: rest[2],
    };
  }
  if (action === "delete") {
    if (rest.length !== 2) {
      throw new Error("Использование: invariant delete <set_id>");
    }
    return { type: "invariant", action: "delete", setId };
  }
  throw new Error(
    "Использование: invariant create|list|delete|attach|detach|add|rm | invariant <set_id>",
  );
}

function parsePreferCommand(rest) {
  if (rest.length < 4) {
    throw new Error(
      "Использование: prefer <user_id> <style|constraints|context> <ключ> <значение>",
    );
  }
  const section = parseSection(rest[1], "prefer");
  return {
    type: section,
    action: "set",
    userId: parseUserId(rest[0], "user_id"),
    section,
    key: parseSectionKey(section, rest[2], "prefer"),
    value: rest.slice(3).join(" ").trim(),
  };
}

function parseTaskCommand(rest) {
  if (!rest.length) {
    throw new Error(
      "Использование: task <name|id> [start [название] | clear | plan … | approve | next [шаг] | current … | transition STATE | continue]",
    );
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
  if (action === "status" || action === "show") {
    if (rest.length !== 2) {
      throw new Error("Использование: task <name|id> [show]");
    }
    return { type: "task", target, action: "show" };
  }
  if (action === "continue" || action === "resume" || action === "продолжай") {
    if (rest.length !== 2) {
      throw new Error("Использование: task <name|id> continue");
    }
    return { type: "task", target, action: "continue" };
  }
  if (action === "plan") {
    const items = rest.slice(2).join(" ").trim();
    if (!items) {
      throw new Error(
        "Использование: task <name|id> plan пункт | пункт | пункт",
      );
    }
    return { type: "task", target, action: "plan", items };
  }
  if (action === "approve" || action === "утвердить") {
    if (rest.length !== 2) {
      throw new Error("Использование: task <name|id> approve");
    }
    return { type: "task", target, action: "approve" };
  }
  if (action === "next" || action === "next_step") {
    return {
      type: "task",
      target,
      action: "next",
      current: rest.slice(2).join(" "),
    };
  }
  if (action === "transition" || action === "go" || action === "goto") {
    if (rest.length !== 3) {
      throw new Error(
        "Использование: task <name|id> transition planning|execution|validation|done",
      );
    }
    return { type: "task", target, action: "transition", state: rest[2] };
  }
  if (action === "current" || action === "step") {
    const current = rest.slice(2).join(" ").trim();
    if (!current) {
      throw new Error("Использование: task <name|id> current <описание шага>");
    }
    return { type: "task", target, action: "current", current };
  }
  throw new Error(
    "Использование: task <name|id> [start [название] | clear | plan … | approve | next [шаг] | current … | transition STATE | continue]",
  );
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

  if (cmd === "profile") {
    return parseProfileCommand(rest);
  }

  if (cmd === "invariant" || cmd === "invariants") {
    return parseInvariantCommand(rest);
  }

  if (cmd === "style") {
    return parseSectionSetCommand("style", rest);
  }

  if (cmd === "constraints") {
    return parseSectionSetCommand("constraints", rest);
  }

  if (cmd === "context") {
    return parseSectionSetCommand("context", rest);
  }

  if (cmd === "prefer") {
    return parsePreferCommand(rest);
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
    "                            [--strategy sliding|facts|branching|full] [--window N] [--profile USER] [--invariants SET]",
    "                            --limit N — лимит контекста (токены) этого агента",
    "                            --compress — сжимать историю (последние N как есть, старше в summary)",
    "                            --compress-every N — порог сжатия, по умолчанию через CURSOR_COMPRESS_EVERY; включает --compress",
    "                            --no-compress — выключить сжатие (если в .env включено)",
    "                            --strategy — управление контекстом: sliding | facts | branching | full",
    "                            --window N — последние N сообщений для sliding и facts (по умолчанию 8)",
    "                            --profile USER — подключить профиль персонализации к агенту",
    "                            --invariants SET — подключить набор жёстких инвариантов",
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
    "  task <name|id>            показать этап, шаг, план и working (алиас: show | status)",
    "  task <name|id> start [название]",
    "                            новая задача в PLANNING: очищает только working (KV + автомат),",
    "                            long и профиль не трогает. Пишется название, план остаётся пустым",
    "  task <name|id> plan пункт | пункт | пункт",
    "                            явно записать план в working.machine.plan (разделители: |  ;  перевод строки).",
    "                            Этап не меняется — всё ещё PLANNING, пока нет approve",
    "  task <name|id> approve     только из PLANNING и только если план не пустой:",
    "                            → EXECUTION, шаг 1/N, current = первый пункт",
    "  task <name|id> next [шаг]  отметить current как сделанный, взять следующий пункт плана",
    "  task <name|id> current <описание>",
    "                            сменить текст текущего шага, не меняя этап",
    "  task <name|id> transition planning|execution|validation|done",
    "                            смена этапа только по таблице; скип — ошибка",
    "                            (planning→execution после плана; execution→validation|planning;",
    "                            validation→done|execution; done — конец.",
    "                            Нельзя: planning→validation|done, execution→done,",
    "                            execution без утверждённого плана)",
    "  task <name|id> continue    пауза/продолжить: печать сохранённого состояния, модель не вызывается",
    "  task <name|id> clear       очистить working (как forget working): и KV-заметки, и автомат",
    "                            План сам не появляется от start. Явно: task plan … Затем approve.",
    "                            ask на PLANNING может записать план маркером PLAN_SET в ответе модели.",
    "                            remember working — заметки в entries; это не план автомата.",
    "  profile create <user_id> [--name NAME]",
    "                            создать профиль в отдельном хранилище (rules *.mdc / db / api)",
    "  profile list | profile <user_id> | profile <user_id> name <имя>",
    "  profile delete <user_id> | profile rm <user_id>",
    "                            удалить профиль из хранилища; отключает его у агентов",
    "  profile attach <агент> <user_id> | profile detach <агент>",
    "  profile <user_id> clear [style|constraints|context [ключ]]",
    "  style <user_id> <ключ> <значение>",
    "                            length/tone/examples/language — краткие|подробные, формальный|разговорный,",
    "                            с/без примеров кода, язык ответа",
    "  constraints <user_id> <ключ> <значение>",
    "                            stack / architecture / dependencies / apis",
    "  context <user_id> <ключ> <значение>",
    "                            role / project / team / deadline",
    "  prefer <user_id> <style|constraints|context> <ключ> <значение>",
    "                            алиас для секций профиля; блок идёт в каждый ask",
    "  invariant create <set_id>  набор жёстких правил отдельно от диалога",
    "  invariant add <set_id> stack|arch|budget|maxdeps|nobanned|decision|apis …",
    "                            stack NodeJS JavaScript | arch MVVM | budget 100000 |",
    "                            maxdeps 5 | nobanned RxJava | decision REST без GraphQL | apis free",
    "  invariant <set_id> | list | rm <set_id> [id] | delete <set_id>",
    "  invariant attach <агент> <set_id> | invariant detach <агент>",
    "                            в каждый ask: [INVARIANTS] → LLM → проверка; при нарушении — повтор,",
    "                            затем отказ. Нарушающий черновик в диалог не попадает",
    "  strategy <name|id> [sliding|facts|branching|full] [--window N]",
    "                            без стратегии — показать текущую; со стратегией — переключить",
    "  window <name|id> N      размер окна для sliding / facts",
    "  facts <name|id>         показать key-value память (стратегия facts)",
    "  checkpoint <name|id>    сохранить чекпоинт (стратегия branching)",
    "  branch <name|id> A B    две ветки от чекпоинта (или от текущего места)",
    "  use <name|id> <ветка>   переключиться на ветку",
    "  branches <name|id>      список веток",
    "  tokens <name|id>        затраченные токены агента (история, последний ход, сумма)",
    "  list                    memory=s/w/l — слои памяти; task=этап шаг/всего; profile=user_id; invariants=set_id",
    "  kill <name|id>          удаляет агента и его сохранённую историю",
    "  kill all",
    "  help",
    "  exit",
  ].join("\n");
}
