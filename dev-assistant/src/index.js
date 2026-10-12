import readline from "node:readline";
import { helpText, parseCommand } from "./cli.js";
import {
  changeConnection,
  clearConnection,
  readConnection,
  requireConnection,
  saveConnection,
} from "./connection.js";
import { answerProjectHelp } from "./assistant.js";

let projectRoot = readConnection();

async function handle(cmd) {
  switch (cmd.type) {
    case "empty":
      return true;
    case "help":
      console.log(helpText());
      return true;
    case "exit":
      return false;
    case "connect": {
      projectRoot = saveConnection(cmd.path);
      console.log(`Подключено: ${projectRoot}`);
      return true;
    }
    case "disconnect": {
      const previous = clearConnection(cmd.path);
      projectRoot = null;
      console.log(`Отключено: ${previous}`);
      return true;
    }
    case "change-connect": {
      const changed = changeConnection(cmd.path);
      projectRoot = changed.path;
      console.log(
        changed.previous
          ? `Переключено: ${changed.previous} → ${changed.path}`
          : `Подключено: ${changed.path}`,
      );
      return true;
    }
    case "whereami": {
      const active = projectRoot ?? readConnection();
      console.log(active ? `Активный проект: ${active}` : "Проект не подключён.");
      return true;
    }
    case "project-help": {
      const root = projectRoot ?? requireConnection();
      const result = await answerProjectHelp(cmd.text, {
        root,
        allowModel: true,
      });
      console.log(result.reply);
      return true;
    }
    default:
      throw new Error("Неизвестная команда. Введите help.");
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "> ",
});

console.log("Ассистент разработчика.");
if (projectRoot) console.log(`Проект: ${projectRoot}`);
else console.log("Проект не подключён. Команда: connect <путь>");
console.log("Введите help для списка команд.");
rl.prompt();

let chain = Promise.resolve();
let shouldPrompt = true;

rl.on("line", (line) => {
  chain = chain.then(async () => {
    if (!shouldPrompt) return;
    try {
      const keepGoing = await handle(parseCommand(line));
      if (!keepGoing) {
        shouldPrompt = false;
        rl.close();
        return;
      }
    } catch (err) {
      console.error(err.message ?? err);
    }
    if (shouldPrompt) rl.prompt();
  }).catch((err) => {
    console.error(err.message ?? err);
    if (shouldPrompt) rl.prompt();
  });
});

rl.on("close", () => {
  process.exit(0);
});
