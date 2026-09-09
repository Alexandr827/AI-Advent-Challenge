# CLI-хост с пулом ИИ-агентов

Один процесс Node.js поднимает интерактивный CLI. Внутри него можно заспавнить до **100** инстансов агента с разными конфигами. Каждый агент — отдельный класс: принимает запрос, отправляет его в LLM через [Cursor SDK](https://cursor.com/docs/sdk/typescript) (`Agent.create` + `agent.send`) и печатает ответ в терминал.

Сессия Cursor SDK создаётся лениво при первом `ask`, поэтому `spawn --count 100` не открывает сразу 100 сессий.

## Требования

- Node.js 18+
- API-ключ Cursor ([Dashboard → Integrations](https://cursor.com/dashboard/integrations))
- Установленный Cursor CLI (для `CURSOR_RUNTIME=local`)

## Развёртывание

```bash
npm install
cp .env.example .env
```

Открой `.env` и укажи ключ:

```env
CURSOR_API_KEY=cursor_your-key-here
CURSOR_MODEL=composer-2.5
CURSOR_RUNTIME=local
```

| Переменная | Описание |
|---|---|
| `CURSOR_API_KEY` | API-ключ Cursor |
| `CURSOR_MODEL` | Модель по умолчанию для `spawn` без `--model` |
| `CURSOR_RUNTIME` | `local` или `cloud` |

## Запуск

```bash
npm start
```

Откроется REPL:

```
CLI-хост агентов. Модель по умолчанию: composer-2.5, runtime: local. Лимит: 100.
Введите help для списка команд.
>
```

## Команды

```text
spawn [--name NAME] [--model MODEL] [--system "..."] [--runtime local|cloud] [--count N]
ask <name|id> <текст>
list
kill <name|id>
kill all
help
exit
```

### Примеры

```bash
npm start
> spawn --name helper --model composer-2.5
> spawn --name cheap --model gpt-5.4-nano --system "Отвечай кратко"
> spawn --count 100 --model gpt-5.4-nano
> ask helper Сколько будет 2+2?
> list
> kill cheap
> exit
```

`spawn` без `--count` создаёт один инстанс. `--count 100` поднимает сто агентов с одним шаблоном конфига (имена `NAME-1` … `NAME-100` или `agent-1` …). Разные модели и system-промпты — отдельные `spawn` в том же процессе.

Повторные `ask` к одному имени идут в тот же SDK-агент и сохраняют контекст диалога. История (`messages`) пишется в `data/agents.json`. После перезапуска процесса агенты поднимаются из файла, диалог продолжается с того же места.

`kill` удаляет агента **вместе** с сохранённой историей. `exit` только закрывает SDK-сессии, JSON остаётся.

## Структура

```
src/
  index.js   # точка входа, REPL
  cli.js     # разбор команд
  pool.js    # пул инстансов (лимит 100)
  agent.js   # класс LlmAgent
  store.js   # JSON-хранилище истории
  env.js     # загрузка .env
data/        # agents.json — агенты и messages (не коммитится)
.env.example
```

## Примечания

- Файл `.env` с ключом **не коммитится** — только `.env.example`.
- Инструменты агента отключены (`tools: []`).
- При `exit` или закрытии терминала SDK-сессии dispose, история на диске сохраняется.
