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

  if (quote) throw new Error("Незакрытая кавычка");
  if (current) tokens.push(current);
  return tokens;
}

export function parseCommand(line) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed) return { type: "empty" };

  const tokens = tokenize(trimmed);
  const cmd = tokens[0].toLowerCase();
  const rest = tokens.slice(1);

  if (cmd === "help" || cmd === "?") return { type: "help" };
  if (cmd === "/help") return { type: "project-help", text: rest.join(" ").trim() };
  if (cmd === "exit" || cmd === "quit") return { type: "exit" };

  if (cmd === "connect") {
    if (!rest.length) throw new Error("Использование: connect <путь>");
    return { type: "connect", path: rest.join(" ") };
  }

  if (cmd === "disconnect") {
    if (!rest.length) throw new Error("Использование: disconnect <путь>");
    return { type: "disconnect", path: rest.join(" ") };
  }

  if (cmd === "change") {
    if (rest[0]?.toLowerCase() !== "connect" || rest.length < 2) {
      throw new Error("Использование: change connect <путь>");
    }
    return { type: "change-connect", path: rest.slice(1).join(" ") };
  }

  if (cmd === "whereami") {
    if (rest.length) throw new Error("whereami не принимает аргументы");
    return { type: "whereami" };
  }

  throw new Error(`Неизвестная команда: ${tokens[0]}. Введите help.`);
}

export function helpText() {
  return [
    "Команды:",
    "  connect <путь>         подключить ассистента к корню проекта.",
    "                            Путь запоминается в data/connection.json.",
    "                            RAG и MCP читают этот каталог, не каталог CLI.",
    "  disconnect <путь>      отключить проект. Путь должен совпасть с активным.",
    "  change connect <путь>  переключить ассистента на другой проект.",
    "  whereami               показать текущий активный проект.",
    "  /help                   куда подключён: файлы RAG, project-mcp, ветка, список файлов.",
    "  /help <вопрос>          ответ по документации и контексту проекта.",
    "                            Всегда: git_branch и list_files.",
    "                            git_diff — если вопрос про изменения, diff или ветку.",
    "                            Вопрос о структуре получает обзорный чанк README.",
    "                            Без LM Studio ответ собирается из найденных фрагментов.",
    "  help",
    "  exit",
  ].join("\n");
}
