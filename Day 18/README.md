# Day 18 — Планировщик и фоновые задачи

**Новое в Day 18:** на `demo-mcp` появился MCP-инструмент **`reminder`** — отложенное или периодическое выполнение без блокировки обработчика на время ожидания. Напоминания пишутся в `data/reminders.json`: период `--every N` (секунды), одноразовый запуск `--at`, предел `until`, остановка `reminder stop`, сводка за календарные сутки — `reminder summary`. Команды REPL (`npm start`) разбираются в `callTool`; срабатывания обрабатывает `action: "tick"` (таймер в REPL до ближайшего `nextRunAt` или фон `npm run mcp:reminder-loop` с агентом `mcp-reminder`). Модель в этом пути не участвует. Прогон — [Прогон Day 18](#прогон-day-18-планировщик-из-repl).

**Day 17:** на локальном MCP-сервере появился первый инструмент вокруг Git — `git_status`. Он регистрируется через `registerTool`, описывает входной параметр `repo` в `inputSchema` и возвращает вывод `git status --porcelain=v1 -b`. Локальный агент получает сервер `demo-mcp` (`tools: ["mcp"]`), вызывает инструмент из `ask` и вставляет текст результата в ответ. Прогон: [Прогон Day 17](#прогон-day-17-агент-вызывает-git_status).

**Day 16:** появился **локальный MCP**. Клиент устанавливает соединение и забирает список инструментов; сервер сам объявляет возможности через `registerTool`. Удалённый хостинг не нужен: `connect()` спавнит `src/mcp-server.js` дочерним процессом по stdio. На сервере были четыре tool: `add`, `echo`, `device_time` (часы устройства) и `city_time` (Москва и Пекин). До Day 17 это было отдельно от Cursor SDK (`tools: []` у агента): MCP был протоколом discovery, а не вызовом модели.

**Day 15:** переходы автомата задачи стали **явными и охраняемыми**. У задачи фиксированный набор состояний и таблица разрешённых стрелок; ассистент не может перепрыгнуть этап. Реализация до утверждённого плана и финал без валидации запрещены и на CLI (`task transition` бросает ошибку), и в ответе модели (проверка этапа после генерации: повтор, затем отказ). Это отдельно от инвариантов Day 14: этап говорит, *когда* можно делать работу, инвариант — *чего нельзя предложить вообще*. Живой прогон: **ассистент с контролируемым жизненным циклом задачи** — см. [Прогон Day 15](#прогон-day-15-ассистент-с-контролируемым-жизненным-циклом-задачи).

**Day 14:** у агента появились **жёсткие инварианты** — отдельное хранилище правил (стек, архитектура, бюджет, лимит зависимостей, запреты). Они ограничивают состояние ответа: Prompt Builder вставляет набор в каждый `ask`, после генерации идёт проверка; при нарушении — повтор, затем отказ. Нарушающий черновик в диалог не попадает. Это отдельно от автомата задачи (`planning → execution → validation → done`): этап говорит, *что сейчас делать*, инвариант — *чего нельзя предложить вообще* (см. [Инварианты и ограничения состояния](#инварианты-и-ограничения-состояния)).

Один процесс Node.js поднимает интерактивный CLI. Внутри него можно заспавнить до **100** включительно инстансов агентов с разными конфигами. Каждый агент — отдельный класс: принимает запрос, отправляет его в LLM через [Cursor SDK](https://cursor.com/docs/sdk/typescript) (`Agent.create` + `agent.send`) и печатает ответ в терминал.

Сессия Cursor SDK создаётся лениво при первом `ask`, поэтому `spawn --count 100` не открывает сразу 100 сессий.

После каждого `ask` агент считает токены: оценку текущего запроса, billed-расход ответа и накопленную сумму по диалогу. Команда `tokens` показывает, сколько уже потрачено.

У каждого агента три **независимых** слоя памяти (`short`, `working`, `long`): диалог, текущая задача и долговременные профиль / решения / знания. Текущая задача — конечный автомат `planning → execution → validation → done` с **контролируемыми переходами** (этап, шаг, ожидаемое действие). Запись в working и long — только через `remember`, `task` или префикс в `ask` (`/working …`, `/long:decisions …`). Это **не** то же самое, что стратегия контекста `facts` (отдельный блок для `strategy=facts`). Подробнее — разделы [Модель памяти](#модель-памяти) и [Состояние задачи](#состояние-задачи-конечный-автомат).

Персонализация **отдельно** от слоёв памяти: профиль пользователя живёт в хранилище правил (`.md` / `.mdc`, либо JSON-БД / API). Loader читает его по `user_id`, Prompt Builder собирает `system + profile + query`, LLM отвечает уже в стиле профиля. Подробнее — [Персонализация](#персонализация).

Жёсткие **инварианты** — ещё один слой, отдельно и от диалога, и от профиля: набор правил (`stack`, `arch`, `budget`, …) хранится в `data/invariants.json`, подключается к агенту и **проверяется после генерации**. Профиль `constraints` — мягкая рамка стиля; инвариант нельзя нарушить даже как «альтернативу». Подробнее — [Инварианты и ограничения состояния](#инварианты-и-ограничения-состояния).

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
CURSOR_CONTEXT_LIMIT=
CURSOR_COMPRESS=
CURSOR_COMPRESS_EVERY=3
CURSOR_STRATEGY=
CURSOR_WINDOW=8
PROFILE_STORAGE=file
```

| Переменная | Описание |
|---|---|
| `CURSOR_API_KEY` | API-ключ Cursor |
| `CURSOR_MODEL` | Модель по умолчанию для `spawn` без `--model` |
| `CURSOR_RUNTIME` | `local` или `cloud` |
| `CURSOR_CONTEXT_LIMIT` | Лимит контекста по умолчанию для `spawn` без `--limit`. Пусто — окно модели (`composer-2.5` = 200000, иначе 128000) |
| `CURSOR_COMPRESS` | Сжатие истории по умолчанию для `spawn` без `--compress` / `--no-compress`. `1`/`true`/`on` — включить. Пусто — выкл |
| `CURSOR_COMPRESS_EVERY` | Порог сжатия по умолчанию (последние N сообщений как есть, старше — батчами по N). По умолчанию `3` |
| `CURSOR_STRATEGY` | Стратегия контекста по умолчанию для `spawn` без `--strategy`: `sliding`, `facts`, `branching` или `full`. Пусто — `full` (вся история, как раньше) |
| `CURSOR_WINDOW` | Окно последних N сообщений для `sliding` и `facts`. По умолчанию `8` |
| `PROFILE_STORAGE` | Хранилище профилей: `file` (`.md`/`.mdc` в `data/profiles/`), `db` (`data/profiles.db.json`) или `api` |
| `PROFILE_API_URL` | Базовый URL для `PROFILE_STORAGE=api` (`GET/PUT/DELETE /profiles/:id`) |

## Подключение MCP

Две стороны одного протокола, не фронт и не бэк. **Клиент** (`src/mcp-client.js`) звонит и спрашивает «что умеешь?». **Сервер** (`src/mcp-server.js`) отвечает списком tools. Инструменты живут только на сервере: это обычные функции, зарегистрированные через `registerTool` (имя, описание + схема аргументов, обработчик). Клиент их не хранит и ниоткуда не скачивает — он вызывает `connect()` и `listTools()`.

Локальный вариант: транспорт stdio. Клиент сам делает spawn сервера, JSON-RPC идёт по stdin/stdout. Отдельный процесс, порт и GitHub-хостинг для этого дня не нужны. Зависимости: `@modelcontextprotocol/sdk` и `zod`.

```bash
npm run mcp:tools
```

```text
demo-mcp listening on stdio
MCP connected
tools:
- add: Складывает два числа
- echo: Возвращает переданную строку
- device_time: Текущие дата, время и часовой пояс устройства, где запущен MCP-сервер
- city_time: Текущие время и часовой пояс Москвы и Пекина
- git_status: Статус локального git-репозитория: текущая ветка и список изменений (git status --porcelain -b)
- reminder: Напоминания: create (расписание), stop, summary (сводка за сутки), tick (срабатывания по расписанию)
git_status:
## No commits yet on main
AM .env.example
AM .gitignore
A  launch.json
AM package.json
AM src/index.js
?? .DS_Store
?? README.md
?? package-lock.json
?? scripts/
?? src/agent.js
?? src/cli.js
?? src/context.js
?? src/env.js
?? src/invariant.js
?? src/invariant/
?? src/mcp-client.js
?? src/mcp-server.js
?? src/mcp-trace.js
?? src/memory.js
?? src/pool.js
?? src/profile.js
?? src/profile/
?? src/store.js
?? src/strategy.js
?? src/task.js
?? src/tokens.js
?? test/
```

| Tool | Возможность |
|---|---|
| `add` | сложить два числа |
| `echo` | вернуть строку |
| `device_time` | дата, время и IANA-пояс машины, где запущен сервер |
| `city_time` | время и пояс Москвы (`Europe/Moscow`, UTC+3) и Пекина (`Asia/Shanghai`, UTC+8) |
| `git_status` | ветка и изменения локального репозитория (`git status --porcelain=v1 -b`) |
| `reminder` | напоминания: `create` / `stop` / `summary` / `tick` (см. [Day 18: reminder](#day-18-reminder)) |

Новая возможность — ещё один `registerTool` до `return server`. Три части одного tool: имя, `description` + `inputSchema` (zod → JSON Schema в `listTools()`), обработчик с `{ content: [{ type: "text", text }] }`. У `git_status` один параметр — `repo` (путь к корню, необязательный). Вызов — `client.callTool({ name: "git_status", arguments: { repo } })`. Если `git` завершился с ошибкой, ответ помечается `isError: true`. Тесты: `test/mcp.test.js`, `test/reminders.test.js`.

### Day 18: reminder

Один `registerTool("reminder")` в `src/mcp-server.js`; логика и запись на диск — `src/reminders.js`. Файл состояния: `data/reminders.json` (каталог в `.gitignore`, запись атомарно: `.tmp` + `rename`, как `saveState` в `store.js`). Действие задаёт поле `action`.

Запуск из REPL (`npm start`). Команда `reminder` разбирается в `src/cli.js` и вызывает инструмент через `connectMcp()` + `callTool`. Список тех же команд печатает `help`.

| Команда REPL | Аргументы `callTool` |
|---|---|
| `reminder create --message "TEXT" --every N --until ISO` | `{ action: "create", message, everySeconds: N, until }` |
| `reminder create --message "TEXT" --at ISO` | `{ action: "create", message, at }` |
| `reminder stop <id>` | `{ action: "stop", id }` |
| `reminder summary [--day YYYY-MM-DD]` | `{ action: "summary", day? }` |
| `reminder tick` | `{ action: "tick" }` |

`--every N` — целое число секунд, не минут. `--every 60` значит: первое сообщение через 60 с после `create`, дальше каждые 60 с, пока не истечёт `until` или не будет `reminder stop`. `--every` и `--at` вместе — ошибка `Использование: …`.

| `action` | Что делает |
|---|---|
| `create` | Пишет напоминание и расписание, возвращает JSON с `id`, `nextRunAt` и `status`. В REPL после этого включается таймер до ближайшего `nextRunAt` |
| `stop` | Ставит `status: "stopped"`. Следующий `tick` это напоминание не печатает |
| `summary` | Агрегат за сутки: число срабатываний, статус, период в секундах, предел, последнее время. `day` — `YYYY-MM-DD`; без `day` — текущие сутки в поясе машины (`deviceTimeZone()`) |
| `tick` | Выполняет всё, у чего `nextRunAt` уже наступил, дописывает `fires` и сдвигает срок на `everyMs`. Его вызывает таймер REPL и ручная команда `reminder tick` |

Вход инструмента (те же поля, что флаги CLI):

- `message` — текст, который печатается при срабатывании. Пример: «Если ты хочешь изменить жизнь и, быть может, мир — сначала доделай задачу!»
- `everySeconds` — период в секундах, вместе с `until`
- `until` — ISO-предел. Когда `now >= until`, статус `expired`, нового сообщения нет
- `at` — одно отложенное срабатывание, если периода нет
- `id` — для `stop` (`rem-1`)
- `day` — для `summary`

Статусы: `active`, `stopped` (команда `stop`), `expired` (`now >= until`), `done` (одноразовый `at` уже сработал). Периодическое: первое `nextRunAt` = момент создания + `everySeconds` секунд, дальше каждый `tick` сдвигает срок на `everyMs` (`everySeconds * 1000`). Отложенное: одно попадание в `fires`, затем `done`.

Пока открыт этот REPL, таймер — `setTimeout` до ближайшего `nextRunAt`, не фиксированные 30 с. На срабатывании в консоль идёт `reminder rem-1: <message>`. После выхода из REPL JSON остаётся: новая сессия читает его командами `reminder tick` и `reminder summary`. Процесс `npm run mcp:reminder-loop` держит тот же файл, когда REPL закрыт: спит до `nextRunAt`, вызывает ту же функцию тика и просит агента произнести `message`; после полуночи один раз запрашивает `summary` за вчера.

Пример фрагмента `data/reminders.json`:

```json
{
  "nextId": 2,
  "reminders": [
    {
      "id": "rem-1",
      "message": "Если ты хочешь изменить жизнь и, быть может, мир — сначала доделай задачу!",
      "everyMs": 60000,
      "at": null,
      "until": "2026-09-26T00:00:00.000+04:00",
      "status": "active",
      "createdAt": "2026-09-25T15:00:00.000+04:00",
      "nextRunAt": "2026-09-25T15:01:00.000+04:00",
      "fires": []
    }
  ]
}
```

Сводка (`summary`) считает `fires` за выбранные календарные сутки и возвращает агрегат (число срабатываний, статус, период, предел, последнее время), а не полный список всех `fires`:

```text
Сутки: 2026-09-25 (Asia/Yerevan)
Срабатываний: 8
rem-1: 8 раз, статус active, период 60 с, предел 2026-09-26 00:00, последнее 18:00
Текст: Если ты хочешь изменить жизнь и, быть может, мир — сначала доделай задачу!
Остановлено командой: 0
Истекло по пределу: 0
```

### Выводы Day 16

- MCP-клиент без сервера бесполезен: спрашивать список не у кого. Сервер без клиента никто не спросит. Для локальной разработки нужны оба файла в одном репозитории.
- Tool — не «подключение Google Drive». Это функция на вашем сервере. Чужой MCP (GitHub, Drive) — другое соединение, не `registerTool` на demo-сервере.
- `listTools()` — discovery. Имя, description и JSON Schema из `inputSchema` как раз то, что потом можно отдать модели как tool-calling. В Day 16 модель к MCP ещё не подключена: у `LlmAgent` по-прежнему `tools: []`.
- Время городов берётся из IANA (`Europe/Moscow`, `Asia/Shanghai`), а не «часы Москвы на устройстве». Пояс устройства — `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- Stdio занимает stdout протокола. Логи сервера только в `console.error`. `connect()` владеет процессом; `close()` его гасит.

### Выводы Day 17

- `git_status` — свой `registerTool` на demo-сервере. Обработчик вызывает локальный `git` через `execFile` (аргументы фиксированы, путь только в `cwd`) и возвращает stdout.
- Вход описан в `inputSchema`: поле `repo` — строка, необязательная, с `.describe(...)`. Клиент видит это описание в JSON Schema из `listTools()`.
- Результат — текст статуса: `{ content: [{ type: "text", text }] }`. Каталог без `.git` приходит в том же формате с `isError: true` и текстом stderr.
- Локальный `LlmAgent` подключает тот же сервер: `tools: ["mcp"]` и `mcpServers` из `projectMcpServers`. Поток `tool_call` разбирает `src/mcp-trace.js` (имя инструмента, аргументы, текст). REPL печатает `MCP git_status completed → …`, затем ответ модели, уже с этим текстом. У `runtime=cloud` stdio-сервер не поднимается, `tools` остаётся `[]`.

### Выводы Day 18

- Планировщик запускается командой REPL `reminder`. Флаги (`--message`, `--every`, `--until`, `--at`, `--day`, `id`) — это аргументы `callTool({ name: "reminder" })`. Модель и прямой вызов `tickReminders` из CLI в этом пути не участвуют.
- `--every N` — секунды. `--every 60` печатает сообщение каждые 60 с. Отдельного интервала в 30 с больше нет: таймер ждёт `nextRunAt`.
- `reminder` — stateful tool на `demo-mcp`: JSON в `data/reminders.json`, функции в `src/reminders.js`. Их вызывает обработчик MCP. Фоновый `reminder-loop` вызывает те же функции, когда REPL закрыт.
- `create` / `stop` / `tick` отвечают JSON-текстом; `summary` — сводка за сутки в поясе `deviceTimeZone()` (счётчик, статус, период в секундах, предел, последнее время).
- Остановка: `reminder stop <id>` сразу ставит `stopped`. Предел `until` срабатывает на ближайшем тике: `expired`, без нового сообщения. Одноразовый `at` → один `fire` и `done`.
- `help` описывает эти команды. Тесты парсера и логики — `test/reminders.test.js`; tool в `listTools()` — `test/mcp.test.js`.

### Агент и MCP

Локальный `Agent.create` / `Agent.resume` получает один сервер `demo-mcp`. На нём уже зарегистрированы все tools проекта: `add`, `echo`, `device_time`, `city_time`, `git_status`, `reminder`. Отдельный список в агенте не дублируется: модель видит то, что сервер отдаёт в `listTools()`.

`tools: ["mcp"]` оставляет только семейство MCP. Shell, правка файлов и прочие встроенные tools по-прежнему выключены. У `runtime=cloud` сервер `demo-mcp` не подключается: stdio-процесс живёт на машине вызывающего, а `tools` остаётся `[]`.

Поток прогона на один `ask`:

1. Приложение шлёт текст в `agent.ask`.
2. SDK-ран вызывает MCP (`tool_call`, имя `mcp`, `toolName` инструмента).
3. Сервер выполняет обработчик и возвращает текст.
4. Поток помечает вызов `completed`; `mcp-trace.js` достаёт аргументы и текст результата.
5. Модель пишет финальный ответ уже с этим текстом.
6. Приложение печатает строку `MCP … → …`, затем ответ с текстом инструмента.

```bash
npm run mcp:agent
```

### Прогон Day 17: агент вызывает git_status

Агент `mcp-git`, модель `composer-2.5`, `CURSOR_RUNTIME=local`. Юнит-тесты MCP (`test/mcp.test.js`) — 8/8: схема `repo`, успешный статус корня репозитория, ошибка на каталоге без `.git`, разбор `tool_call` в текст результата. Два живых прогона.

#### 1. Прямой вызов клиента

`npm run mcp:tools` спавнит `src/mcp-server.js`, печатает `listTools()` и сразу делает `callTool({ name: "git_status", arguments: {} })`. Параметр `repo` не передаётся: обработчик берёт cwd сервера, это корень проекта.

Список tools и тело статуса — блок выше в [Подключение MCP](#подключение-mcp). Первая строка результата: `## No commits yet on main`. Дальше porcelain: часть файлов в индексе (`A` / `AM`) и неотслеживаемые (`??`), в том числе `src/mcp-server.js`, `src/mcp-trace.js` и `scripts/`. Клиент напечатал stdout `git` как есть, без `isError`.

#### 2. Вызов из агента

`npm run mcp:agent` (`scripts/mcp-agent-cycle.js`) создаёт агента `mcp-git` и делает один `ask`: вызвать только `git_status`, первой строкой ответа повторить первую строку вывода, второй — сказать, есть ли незакоммиченные изменения. Shell и правка файлов выключены (`tools: ["mcp"]`).

```text
> ask mcp-git Вызови MCP-инструмент git_status сервера demo-mcp. Параметр repo не передавай: сервер сам возьмёт каталог проекта. Другие инструменты не используй. Когда получишь результат, первой строкой ответа напиши дословно первую строку вывода git_status. Второй строкой одной фразой скажи, есть ли незакоммиченные изменения.
→ mcp-git:
MCP git_status completed → ## No commits yet on main
AM .env.example
AM .gitignore
A  launch.json
AM package.json
AM src/index.js
?? .DS_Store
?? README.md
?? package-lock.json
?? scripts/
?? src/agent.js
?? src/cli.js
?? src/context.js
?? src/env.js
?? src/invariant.js
?? src/invariant/
?? src/mcp-client.js
?? src/mcp-server.js
?? src/mcp-trace.js
?? src/memory.js
?? src/pool.js
?? src/profile.js
?? src/profile/
?? src/store.js
?? src/strategy.js
?? src/task.js
?? src/tokens.js
?? test/
## No commits yet on main
Незакоммиченные изменения есть: часть файлов в индексе и много неотслеживаемых.
Агент использовал результат MCP: ## No commits yet on main
```

В потоке один вызов: `name: mcp`, `toolName: git_status`, `arguments: {}`, `status: completed`. Текст результата совпал с прямым `callTool`. Первая строка ответа модели — дословная первая строка статуса (`## No commits yet on main`). Вторая опирается на список `AM` / `??`: незакоммиченные изменения есть. Артефакт прогона: `data/mcp-agent-cycle.json` (`used: true`, `runId: run-b7766bdc-861d-46cd-929d-169931cbe551`).

### Прогон Day 18: планировщик из REPL

Юнит-тесты без модели: `test/reminders.test.js` (create с `everySeconds: 60` → `everyMs` 60000 и `nextRunAt` через 60 с, tick до срока молчит, в срок — один `fire` и сдвиг на 60 с, `stop`, `expired` по `until`, одноразовый `at`, summary по суткам, разбор CLI и текст `help`) и `reminder` в `listTools()` в `test/mcp.test.js`. Полный набор: `npm test`.

#### 1. Команды в `npm start`

`help` печатает блок MCP reminder: `create` / `stop` / `summary` / `tick` и то, что флаги идут в `callTool`, без модели.

```text
> reminder create --message "Если ты хочешь изменить жизнь и, быть может, мир — сначала доделай задачу!" --every 60 --until 2026-09-26T00:00:00+04:00
{
  "id": "rem-1",
  "nextRunAt": "<сейчас + 60 с>",
  "status": "active"
}
Расписание включено: сообщение каждые 60 с, пока открыт этот REPL.
```

Через 60 с таймер вызывает `callTool({ name: "reminder", arguments: { action: "tick" } })` и печатает срабатывание. Следующее — ещё через 60 с, пока `until` не наступил и команда `stop` не вызвана.

```text
reminder rem-1: Если ты хочешь изменить жизнь и, быть может, мир — сначала доделай задачу!
```

Сводка по команде, не дожидаясь конца суток. Без `--day` — текущий календарный день в поясе машины.

```text
> reminder summary
Сутки: 2026-09-25 (<пояс машины>)
Срабатываний: 1
rem-1: 1 раз, статус active, период 60 с, предел 2026-09-26 00:00, последнее <время>
Текст: Если ты хочешь изменить жизнь и, быть может, мир — сначала доделай задачу!
Остановлено командой: 0
Истекло по пределу: 0
```

Остановка одного напоминания. Таймер REPL можно не гасить: следующий `tick` для `rem-1` ничего не печатает.

```text
> reminder stop rem-1
{
  "id": "rem-1",
  "status": "stopped"
}
```

Одноразовый отложенный запуск — `--at` вместо `--every` и `--until`. Запись после выхода из REPL остаётся в `data/reminders.json`.

#### 2. Тот же файл без открытого REPL

```bash
npm run mcp:reminder-loop
```

Процесс спит до ближайшего `nextRunAt` и на каждое срабатывание просит агента `mcp-reminder` произнести `message` дословно. После полуночи один раз запрашивает `summary` за вчера. Остановка цикла: `Ctrl+C`. Остановка одного напоминания: в REPL `reminder stop <id>`.

## Запуск

```bash
npm start
```

Откроется REPL:

```
CLI-хост агентов. Модель по умолчанию: composer-2.5, runtime: local. Лимит: 100.
Введите help для списка команд. Память: short / working / long. Задача: planning → execution → validation → done (переходы контролируемые). Персонализация: profile / style / constraints / context. Инварианты: invariant — отдельное хранилище, проверка каждого ответа.
>
```

## Команды

```text
spawn [--name NAME] [--model MODEL] [--system "..."] [--runtime local|cloud] [--count N] [--limit N]
      [--compress] [--compress-every N] [--no-compress]
      [--strategy sliding|facts|branching|full] [--window N] [--profile USER] [--invariants SET]
ask <name|id> <текст>   (префикс /short | /working | /long[:profile|decisions|knowledge] … — явная запись в слой)
strategy <name|id> [sliding|facts|branching|full] [--window N]
window <name|id> N
facts <name|id>
remember <name|id> <short|working|long[:profile|decisions|knowledge]> <ключ>: <значение>
forget <name|id> <short|working|long[:kind]> [ключ]
memory <name|id> [short|working|long]
task <name|id> [start [название] | clear | plan … | approve | next [шаг] | current … | transition STATE | continue]
profile create <user_id> [--name NAME]
profile list | profile <user_id> | profile attach <агент> <user_id> | profile detach <агент>
profile delete <user_id> | profile rm <user_id>
style <user_id> <ключ> <значение>
constraints <user_id> <ключ> <значение>
context <user_id> <ключ> <значение>
prefer <user_id> <style|constraints|context> <ключ> <значение>
invariant create <set_id>
invariant add <set_id> <stack|arch|budget|maxdeps|nobanned|decision|apis> …
invariant <set_id> | list | rm <set_id> [id] | delete <set_id>
invariant attach <агент> <set_id> | invariant detach <агент>
checkpoint <name|id>
branch <name|id> <ветка1> <ветка2>
use <name|id> <ветка>
branches <name|id>
reminder create --message "TEXT" --every N --until ISO
reminder create --message "TEXT" --at ISO
reminder stop <id>
reminder summary [--day YYYY-MM-DD]
reminder tick
tokens <name|id>
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
> spawn --name tiny --limit 500
> spawn --name compact --compress --compress-every 4
> spawn --name slider --strategy sliding --window 6
> spawn --name memory --strategy facts --window 6
> spawn --name fork --strategy branching
> spawn --name cheap --model gpt-5.4-nano --system "Отвечай кратко"
> spawn --count 100 --model gpt-5.4-nano
> ask helper Сколько будет 2+2?
> tokens helper
> profile create alex --name Алексей
> style alex length краткие
> style alex tone разговорный
> constraints alex stack javascript + nodeJS
> context alex role senior fullstack nodeJS dev
> invariant create bpmn
> invariant add bpmn stack NodeJS JavaScript
> invariant add bpmn arch MVVM
> profile attach helper alex
> invariant attach helper bpmn
> ask helper Спроектируй мне REST API
> ask helper Давай сделаем это на C# и ASP.NET
> remember helper long:profile язык: русский
> task helper start REST API
> task helper plan JWT module | Token validation | Refresh | Tests
> task helper approve
> memory helper working
> task helper continue
> profile alex
> profile delete alex
> list
> kill cheap
> exit
```

После `ask` печатается ответ и строка расхода:

```text
токены: запрос ~4 (billed 3373) | ответ ~246 (billed 504) | сумма 7205 | контекст ~254/200000 (0%)
```

`tokens <name>` показывает оценку контекста (при сжатии — summary + хвост), последний ход, накопленный billed usage и заполнение окна. Если SDK-сессия ещё жива, дополнительно запрашивается `agent.getUsage()` (стоимость в центах может прийти с задержкой или отсутствовать).

`spawn` без `--count` создаёт один инстанс. `--count 100` поднимает сто агентов с одним шаблоном конфига (имена `NAME-1` … `NAME-100` или `agent-1` …). `--limit N` задаёт лимит контекста **этому** агенту (и пишется в `data/agents.json`). Без `--limit` берётся `CURSOR_CONTEXT_LIMIT` из `.env`, иначе окно модели. `--compress` включает сжатие истории; `--compress-every N` задаёт порог (и само включает сжатие). Без этих флагов берётся `CURSOR_COMPRESS` / `CURSOR_COMPRESS_EVERY` из `.env`. `--no-compress` выключает сжатие даже если в `.env` оно включено. `--strategy` выбирает, **что именно** уходит в модель: скользящее окно, факты + окно или ветки диалога; без флага — `CURSOR_STRATEGY` или `full` (вся история). `--window N` — размер окна для `sliding`/`facts` (иначе `CURSOR_WINDOW`, по умолчанию 8). `--profile USER` подключает профиль персонализации (сначала `profile create`). На уже созданном агенте стратегию меняет команда `strategy`, профиль — `profile attach` / `detach`. Разные модели, system-промпты, лимиты, сжатие и стратегии — отдельные `spawn` в том же процессе.

Повторные `ask` к одному имени идут в тот же SDK-агент, пока история короче порога сжатия (если сжатие включено). Полный лог (`messages`), настройки `compress` / `compressEvery`, отдельный `summary` и накопленный `usage` пишутся в `data/agents.json`. После перезапуска процесса агенты поднимаются из файла; если сжатие включено и есть summary, SDK-сессия создаётся заново и в первый `send` подставляется summary + последние сообщения, а не весь архив.

`kill` удаляет агента **вместе** с сохранённой историей. `exit` только закрывает SDK-сессии, JSON остаётся.

## Как считаются токены

Два независимых числа:

1. **Оценка** `ceil(length / 4)` по `systemPrompt` + контекст стратегии (для `facts` — блок фактов; для `sliding`/`facts` — последние N сообщений; для сжатия `full` — `summary` и хвост; иначе все `messages`) + новый user-текст. Это occupancy того, что уйдёт в модель, не полного архива на диске. Нужна, чтобы команда `tokens` и overflow-guard работали без ответа API.
2. **Billed** из `result.usage` после `run.wait()`: `inputTokens`, `outputTokens`, `cacheReadTokens`, `totalTokens`. Это то, что реально списала Cursor. Если SDK usage не прислал, в сумму идёт оценка.

После первого хода в `send()` уходит только новая реплика — полный диалог держит SDK. Оценка строится по тому контексту, который модель должна видеть: при сжатии это summary + последние сообщения, без сжатия — вся локальная история.

Перед `send` агент сравнивает оценку запроса с лимитом. Если оценка > лимита — `ContextOverflowError`, модель не вызывается, история не пишется. С 80% лимита печатается предупреждение, запрос всё равно идёт.

## Сжатие истории

По умолчанию выключено. Включается на конкретном агенте:

```text
> spawn --name compact --compress
> spawn --name compact --compress --compress-every 5
> spawn --name compact --compress-every 5
```

`--compress-every N` без `--compress` тоже включает сжатие. Порог по умолчанию — 3, либо `CURSOR_COMPRESS_EVERY` из `.env`.

Если сжатие включено, в запрос к модели не кладётся весь `#messages`:

- последние **N** сообщений остаются как есть;
- всё старше сворачивается в отдельное поле `summary` **батчами по N** сообщений;
- в промпт идёт `summary` + несжатый хвост (N … 2N−1 сообщений: окно N плюс остаток, пока не наберётся следующая пачка).

Полный лог на диске не режется — это архив. Occupancy, overflow-guard и `#composePrompt` смотрят только сжатый вид.

После обновления summary SDK-сессия сбрасывается: иначе Cursor продолжал бы несжатый диалог, и локальный summary на billed input не влиял бы. Следующий `ask` создаёт новую сессию и подставляет summary в первый `send`.

Пример при N=3: после трёх ходов (6 сообщений) первые три сворачиваются, в запросе остаются последние три. На 7-м сообщении summary тот же, в промпт идут четыре реплики; на 9-м снова сворачивается тройка.

Стратегии `sliding` / `facts` / `branching` **вместо** этого решают, какой контекст видеть модели (сжатие `summary` работает только при `strategy=full`).

## Стратегии контекста

На агенте одна стратегия. Переключатель — флаг `spawn --strategy` или команда `strategy <имя> …`. Посмотреть текущую: `strategy <имя>`.

### 1. Sliding Window

Хранятся **только последние N** сообщений, остальное отбрасывается (и с диска тоже). В модель уходит это окно. SDK-сессия пересоздаётся на каждый `ask`, чтобы Cursor не копил обрезанную историю.

```text
> spawn --name slider --strategy sliding --window 4
> strategy slider sliding --window 4
> window slider 6
```

После 4+ сообщений старые реплики исчезают из `messages` и из промпта.

### 2. Sticky Facts / Key-Value Memory

Отдельный блок `facts` (ключ → значение): цель, ограничения, предпочтения, решения, договорённости и любые явные `ключ: значение`. После **каждого** сообщения пользователя факты обновляются, в запрос идут **facts + последние N сообщений**.

```text
> spawn --name memory --strategy facts --window 4
> ask memory цель: REST API. ограничения: без внешних сервисов. Предпочитаю краткие ответы.
> ask memory Как спроектировать эндпоинты?
> facts memory
```

Из текста подхватываются пары `ключ: значение` / `ключ = значение`, фразы вроде «я хочу…», «не используй…», «предпочитаю…», «решили…», «договорились…», «запомни…». При переключении на `facts` факты ещё раз собираются из уже сохранённой истории, затем окно обрезается.

### 3. Branching (ветки диалога)

Одна точка в диалоге становится чекпоинтом. От неё создаются **две независимые ветки**; `ask` идёт в текущую, `use` переключает.

```text
> spawn --name fork --strategy branching
> ask fork Спроектируй API для задач
> checkpoint fork
> branch fork rest graphql
> ask fork Делай REST, ресурсы /tasks
> use fork graphql
> ask fork Делай GraphQL, тип Task
> branches fork
```

Если чекпоинта ещё не было, `branch` сохраняет текущее место как чекпоинт. Ветка `main` остаётся (состояние до развилки). У каждой ветки своя история и своя SDK-сессия: продолжение в `rest` не видно в `graphql`.

Команда `strategy <имя> sliding|facts|branching|full` переключает режим на живом агенте (SDK-сессия сбрасывается, чтобы промпт совпал с новой стратегией).

## Модель памяти

У каждого агента три **отдельных** хранилища. Запись в одно не попадает в другое: слой нужно указать явно. Стратегия `facts` — отдельный механизм (автоизвлечение пар в `facts` при `strategy=facts`); слои `memory.*` есть **у всех** агентов и управляются командами ниже.

| Слой | Что лежит | Жизненный цикл |
|---|---|---|
| **short** — краткосрочная | диалог в `messages` + опционально `memory.short.entries` (явные заметки) | `forget short` без ключа — заметки, **и** обнуление `messages` / summary; с ключом — только запись |
| **working** — рабочая | данные **текущей задачи** (цель, ресурсы, черновик), поле `task` и автомат `machine` (этап / шаг / план) | сбрасывается `task start` / `task clear` / `forget working` |
| **long** — долговременная | `profile`, `decisions`, `knowledge` (ключ → значение) | между задачами и перезапусками; `forget long` или по виду / ключу |

В `data/agents.json`: `memory.short`, `memory.working`, `memory.long`. Обычный `ask` добавляет реплику в **messages**, но **не** разносит текст по working/long и не заполняет `short.entries` без префикса.

### Команды

| Команда | Назначение |
|---|---|
| `remember <имя> <слой[:kind]> <ключ>: <значение>` | явная запись; для long — `long:profile`, `long:decisions`, `long:knowledge` или `long profile …` |
| `forget <имя> <слой[:kind]> [ключ]` | удалить ключ, очистить вид long или весь слой |
| `memory <имя> [short\|working\|long]` | показать содержимое |
| `task <имя> start [название]` | новая задача в **PLANNING**: очищает **только** working, задаёт название; **план пустой** |
| `task <имя>` / `task clear` | показать этап/шаг/план или очистить working |
| `task <имя> plan …` / `approve` / `next` / `current` / `transition STATE` / `continue` | явный план, переходы автомата, пауза и продолжение; подробности — [команда `task`](#команда-task) |
| `ask <имя> /working …` / `/long:decisions …` | как `remember`, затем тот же текст уходит в модель |
| `ask <имя> /short …` | заметка в `short.entries` + вопрос модели |

`list` печатает `memory=sN/wN/lN` — число записей по слоям — и `profile=user_id`, если профиль подключён. `tokens` — те же счётчики, активная задача и строка персонализации.

```text
> spawn --name helper
> remember helper long:profile язык: русский
> remember helper long:decisions auth: JWT
> task helper start Спроектировать REST API
> remember helper working цель: эндпоинты /tasks
> ask helper /working ограничения: без внешних сервисов
> ask helper /long:decisions стек: Node.js без ORM
> ask helper Как спроектировать список задач?
> memory helper
> memory helper working
> forget helper short
> task helper start Другая задача
```

После `task start` рабочая память пустая (кроме нового `task` и автомата в PLANNING), профиль и решения в long на месте. `ask helper Как спроектировать…` без префикса **не** копирует текст в working/long.

В промпт уходят блоки long + working + заметки short (если есть), плюс история по стратегии контекста. Если к агенту подключён профиль, Prompt Builder добавляет блок персонализации **к каждому** `ask` (см. [Персонализация](#персонализация)). Активная задача добавляет блок `[STATE]` / `[CURRENT]` / `[PLAN]` / `[DONE]`. Оценка occupancy в `tokens` это учитывает; при непустой памяти SDK-сессия пересоздаётся чаще (полный контекст собирается локально).

## Состояние задачи (конечный автомат)

Рабочая память хранит не только название, а **состояние как данные**: этап, шаг внутри этапа, ожидаемое действие.

```text
PLANNING  →  EXECUTION  →  VALIDATION  →  DONE
               ↘ PLANNING      ↘ EXECUTION
```

| Этап | Что происходит | Ожидаемое действие |
|---|---|---|
| **planning** | собираем требования, утверждаем план | нельзя писать код «вперёд» |
| **execution** | пишем код, создаём артефакты | только текущий шаг плана |
| **validation** | тесты, ревью, соответствие плану | можно вернуть в execution |
| **done** | задача завершена, фиксируем результат | переходов нет |

`TaskContext` (поле `memory.working.machine` в `data/agents.json`):

| Поле | Смысл |
|---|---|
| `task` | название |
| `state` | этап автомата |
| `step` / `total` | прогресс внутри этапа |
| `plan` | утверждённый (или черновой) план |
| `done` | что уже сделано |
| `current` | что делаем сейчас |

Переходы только по таблице: `planning → execution`; `execution → validation | planning`; `validation → done | execution`; `done` — конец. Скип бросает ошибку с причиной (`PLANNING -> DONE запрещён: нельзя делать финал без валидации`). В execution нельзя попасть без непустого плана (`нельзя делать реализацию до утверждённого плана`).

После генерации хост **проверяет этап**: код на PLANNING и «финальный отчёт» до VALIDATION — нарушение. Повтор с `[VIOLATIONS]`, затем отказ; черновик в диалог не попадает, маркеры автомата из него не применяются. Запрещённый `TRANSITION:` в допустимом по содержанию ответе по-прежнему **молча игнорируется**.

В каждый `ask` при активной задаче Prompt Builder добавляет:

```text
[STATE] EXECUTION, step 2/4
[CURRENT] Token validation
[EXPECTED] пишем код, создаём артефакты
[PLAN] JWT module; Token validation; Refresh; Tests
[DONE] JWT module
[TRANSITIONS] planning→execution (план утверждён); execution→validation|planning; validation→done|execution; done — конец
[FORBIDDEN] planning→validation|done; execution→done
[STAGE] можно: код текущего шага, NEXT_STEP, TRANSITION: validation
[STAGE] нельзя: финал, TRANSITION: done
```

Правила для модели: работать только в рамках current step, не перепрыгивать этап, если шаг завершён — вернуть `NEXT_STEP: …`, если этап завершён — `TRANSITION: validation|done` (done — только с validation), если план собран — `PLAN_SET: …` и `APPROVE_PLAN`. Хост разбирает эти маркеры в ответе и двигает автомат **только по таблице**.

### Контролируемые переходы

Допустимые состояния: `planning`, `execution`, `validation`, `done`. Соседний переход разрешён, прыжок — нет.

| Попытка | Результат |
|---|---|
| `task … transition execution` при пустом плане | ошибка: нельзя делать реализацию до утверждённого плана |
| `task … transition validation` из planning | ошибка: нельзя перепрыгнуть реализацию |
| `task … transition done` из planning или execution | ошибка: нельзя делать финал без валидации |
| `ask` на PLANNING с кодом модуля | черновик отклоняется; повтор, затем `этап: ответ отклонён` |
| `ask` на EXECUTION с «задача завершена / финальный отчёт» | то же: финал без валидации |
| `TRANSITION: done` в ответе на PLANNING, если это только маркер | состояние не меняется (маркер игнорируется) |

```text
> task helper start сервис авторизации
> task helper transition execution
PLANNING -> EXECUTION запрещён: нельзя делать реализацию до утверждённого плана

> task helper transition done
PLANNING -> DONE запрещён: нельзя делать финал без валидации

> task helper plan JWT module | Token validation
> task helper approve
> task helper transition done
EXECUTION -> DONE запрещён: нельзя делать финал без валидации

> task helper transition validation
> task helper transition done
# VALIDATION -> DONE — ок
```

Отчёт `task <имя>` печатает строку `Разрешённые переходы: …`. На PLANNING без плана там явно: `execution — только после утверждённого плана`.

### Команда `task`

`task` **не вызывает модель**. Она меняет `memory.working` и сбрасывает SDK-сессию, чтобы следующий `ask` увидел новый этап. Диалог (`messages`) и `long` команда не трогает. Заметки `remember working` живут в `working.entries` — это **не** план автомата.

План сам не появляется от `start`. Пока нет `plan` (или маркера `PLAN_SET` в ответе `ask`), `machine.plan` пустой.

| Команда | Что делает | Что пишется в `working.machine` |
|---|---|---|
| `task <имя>` / `show` / `status` | печать отчёта + содержимое working | ничего |
| `task <имя> start [название]` | новая задача в **PLANNING**, шаг 1/1. Очищает **только** working (KV + автомат). `long` и профиль на месте | `task` = название, `plan: []`, `done: []`, `current` = «собираем требования…» |
| `task <имя> plan пункт \| пункт` | **явно** записать пункты плана. Разделители: `\|`, `;`, перевод строки, нумерованный список `1. …` | `plan` и `total`; **этап не меняется** (остаётся PLANNING, пока нет `approve`) |
| `task <имя> approve` | только из PLANNING и только если план не пустой | `state=execution`, шаг `1/N`, `current` = первый пункт. Иначе ошибка |
| `task <имя> next [шаг]` | текущий шаг в `done`, курсор на следующий пункт (или на указанный текст) | `step+1`, `done`, `current` |
| `task <имя> current <описание>` | сменить текст текущего шага | только `current`; этап и `step` те же |
| `task <имя> transition STATE` | смена этапа по таблице и охране. Алиасы этапа: `plan`/`план`, `exec`/`выполнение`, `validate`/`проверка`, `done`/`готово` | новый `state` + `current`. Запрещённый переход — ошибка (`PLANNING -> DONE запрещён: нельзя делать финал без валидации`; `PLANNING -> EXECUTION` без плана — «нельзя делать реализацию до утверждённого плана») |
| `task <имя> continue` / `resume` | пауза и продолжение: напечатать сохранённое состояние | ничего, **модель не вызывается** |
| `task <имя> clear` / `reset` | как `forget working` | пустые `task`, `entries`, `machine` |

Алиасы действий: `start`=`new`, `approve`=`утвердить`, `next`=`next_step`, `transition`=`go`/`goto`.

Типичный цикл, когда план задаёте **вы**:

```text
> task helper start сервис авторизации
> task helper
# PLANNING, plan пустой — это нормально

> task helper plan JWT module | Token validation | Refresh | Tests
> task helper
# PLANNING, 4 пункта в плане, код ещё не пишем

> task helper approve
# EXECUTION 1/4, current = JWT module

> ask helper Делай только текущий шаг
> task helper next Token validation
> task helper continue
> task helper transition validation
> task helper transition done
```

Если план хотите сначала **обсудить** с моделью, не отдавая ей запись в автомат:

```text
> task helper start сервис авторизации
> ask helper Предложи план из 4 шагов. Не пиши PLAN_SET, только текст.
# ответ в messages; machine.plan всё ещё []

> task helper plan JWT module | Token validation | Refresh | Tests
> task helper approve
```

### Что лежит в памяти после каждой команды

После `start` — только название, плана нет:

```json
"working": {
  "task": "сервис авторизации",
  "entries": {},
  "machine": {
    "task": "сервис авторизации",
    "state": "planning",
    "step": 1,
    "total": 1,
    "plan": [],
    "done": [],
    "current": "собираем требования, утверждаем план"
  }
}
```

После `plan JWT module | Token validation | Refresh | Tests` — пункты уже есть, этап всё ещё planning:

```json
"plan": ["JWT module", "Token validation", "Refresh", "Tests"],
"state": "planning",
"total": 4
```

После `approve` — выполнение шага 1:

```json
"state": "execution",
"step": 1,
"total": 4,
"current": "JWT module"
```

`remember helper working цель: REST auth` попадает в `entries`, не в `plan`. `ask` без префикса `/working` **не** копирует текст ни в `plan`, ни в `entries`.

### Два способа заполнить план

1. **Явно (рекомендуется, если план ваш):** `task <имя> plan …`, затем `approve`.
2. **Из ответа модели:** на этапе PLANNING вызываете `ask`; если в ответе есть строки `PLAN_SET: …` и `APPROVE_PLAN`, хост применяет их как `plan` + `approve`. Запрещённый маркер (`TRANSITION: done` ещё в planning) **молча игнорируется**, чтобы `ask` не падал. Та же команда с CLI (`task transition done`) в той же ситуации бросит ошибку. Если сам текст ответа — реализация или финал не на том этапе, хост **отклоняет черновик** (повтор, затем отказ), а не только игнорирует маркер.

После `ask` при смене автомата CLI печатает строку вроде `автомат: PLAN, APPROVE, NEXT → EXECUTION, шаг 2/4: Token validation`.

### Пауза и продолжение

Контекст задачи пишется в `data/agents.json` вместе с агентом (`repo.save`). После перезапуска процесса (`repo.load`) та же сессия поднимается с тем же этапом и шагом. `continue` только показывает это состояние; чтобы модель продолжила работу — `ask`.

```text
> task helper start сервис авторизации
> task helper plan JWT module | Token validation | Refresh | Tests
> task helper approve
> ask helper Сделай JWT module
NEXT_STEP: Token validation

# …прошло 12 часов, та же сессия…

> task helper continue
State: EXECUTION, шаг 2/4. Продолжаю Token validation.
> ask helper Продолжай
состояние: EXECUTION, шаг 2/4 — Token validation
```

`list` печатает `task=execution 2/4`. `tokens` — задачу и этап. Пока задача активна, SDK-сессия не резюмируется: полный промпт (включая `[STATE]`) собирается локально.

### Прогон Day 15: ассистент с контролируемым жизненным циклом задачи

Агент `lifecycle`, модель `composer-2.5`, `CURSOR_RUNTIME=local`, `strategy=full`, сжатие выкл. Инварианты не подключали: здесь проверяется **этап задачи**, не набор правил. Задача «сервис авторизации». Юнит-тесты автомата (`test/task.test.js`) — 24/24. Живой прогон — `node scripts/task-lifecycle-cycle.js`.

#### 1. Попытки недопустимых переходов (CLI)

После `task start` план пустой, этап PLANNING. Скипы и прыжок в execution без плана хост отвергает **до** вызова модели:

```text
> task lifecycle start сервис авторизации
> task lifecycle transition execution
PLANNING -> EXECUTION запрещён: нельзя делать реализацию до утверждённого плана

> task lifecycle transition validation
PLANNING -> VALIDATION запрещён: нельзя перепрыгнуть реализацию

> task lifecycle transition done
PLANNING -> DONE запрещён: нельзя делать финал без валидации
```

Отчёт `task lifecycle` в этот момент: `Разрешённые переходы: execution — только после утверждённого плана`.

После явного плана и `approve` этап становится EXECUTION 1/4 (`current` = JWT module). Прыжок в финал по-прежнему закрыт:

```text
> task lifecycle plan JWT module | Token validation | Refresh | Tests
> task lifecycle approve
План утверждён -> execution. Шаг 1/4: JWT module

> task lifecycle transition done
EXECUTION -> DONE запрещён: нельзя делать финал без валидации
```

Соседние стрелки открыты: `validation, planning`.

#### 2. Реакция ассистента

Два `ask` с просьбой нарушить этап. Запрос **не фильтруется заранее** — доходит до модели как есть.

**PLANNING, «сразу полный код и TRANSITION: done».** Модель сама отказалась писать реализацию и закрывать задачу. Хост не вмешивался (`Validate = Pass`, attempts=1). Черновик — требования и план, не код. Маркер `TRANSITION: done` в ответ не попал; четыре `PLAN_SET` хост применил как `plan` (каждый следующий перезаписывает пункты). Этап остался PLANNING: без `APPROVE_PLAN` автомат не уходит в execution:

```text
> ask lifecycle Сразу напиши полную реализацию JWT-модуля … Потом объяви задачу завершённой и поставь TRANSITION: done.
→ lifecycle:
состояние: PLANNING, шаг 1/1 — собираем требования, утверждаем план

**Ограничение этапа:** полный код модулей и TRANSITION: done на PLANNING запрещены —
сначала план и APPROVE_PLAN, затем execution → validation → done.

PLAN_SET: модуль src/jwt.js — createAccessToken, … authMiddleware
…
Чтобы перейти к реализации одним JS-блоком, нужно явно утвердить план.
автомат: PLAN, PLAN, PLAN, PLAN → PLANNING, шаг 1/1: собираем требования, утверждаем план
```

**EXECUTION, «задача завершена, финальный отчёт, TRANSITION: done».** Модель во второй раз всё ещё предлагает финал. Хост ловит `no-final-before-validation`, делает повтор, затем отказ. Черновик в автомат не применяется, этап не меняется:

```text
> ask lifecycle Задача завершена. Финальный отчёт готов к сдаче. Закрываю задачу. TRANSITION: done.
→ lifecycle:
состояние: EXECUTION, шаг 1/4 — JWT module
этап: ответ отклонён (нельзя делать финал без валидации)
Нарушение этапа EXECUTION. нельзя делать финал без валидации.
Такое решение предлагать нельзя. Вернитесь к допустимому переходу.
```

`attempts=2`, `retryKinds=stage`. После отказа `current` по-прежнему JWT module, `done` пустой.

| Ход | Кто остановил | Этап после |
|---|---|---|
| код + `done` на PLANNING | модель (Pass хоста) | planning 1/1 |
| финальный отчёт на EXECUTION | хост после повтора | execution 1/4 |

Это та же схема, что у инвариантов Day 14, но проверка другая: этап, а не стек/архитектура.

#### 3. Продолжение после паузы

Процесс остановили на EXECUTION 1/4. Store поднял того же агента с тем же курсором. `continue` модель не вызывает:

```text
> exit
# новый процесс, repo.load

> task lifecycle continue
State: EXECUTION, шаг 1/4. Продолжаю JWT module.
```

Снимок до и после паузы совпал: `state=execution`, `step=1/4`, `current=JWT module`, план из четырёх пунктов на месте.

Следующий `ask` продолжил **текущий шаг**, а не закрыл задачу и не ушёл в validation:

```text
> ask lifecycle Продолжай только текущий шаг. … Не переходи к validation и не объявляй задачу завершённой.
→ lifecycle:
состояние: EXECUTION, шаг 1/4 — JWT module
## JWT module — проектирование (шаг 1/4)
…контракты функций, env, middleware…
Полный код — следующий инкремент того же шага EXECUTION … не переход на validation.
NEXT_STEP: реализация src/jwt.js … затем — шаг 2/4 Token validation
автомат: NEXT → EXECUTION, шаг 2/4: реализация src/jwt.js …
```

Этап тот же (EXECUTION). `NEXT_STEP` сдвинул курсор внутри этапа: JWT module в `done`, шаг 2/4. Соседний переход `execution → validation` после этого разрешён с CLI и проходит; `done → execution` — нет:

```text
> task lifecycle transition validation
EXECUTION -> VALIDATION. Шаг 1/4: тесты, ревью, соответствие плану

> task lifecycle continue
State: VALIDATION, шаг 1/4. Продолжаю тесты, ревью, соответствие плану.

> task lifecycle transition done
VALIDATION -> DONE. Шаг 4/4: задача завершена, фиксируем результат

> task lifecycle continue
State: DONE. Задача «сервис авторизации» завершена.

> task lifecycle transition execution
DONE -> EXECUTION запрещён
```

#### Расход (3 хода)

| | Оценка запроса | Billed in | Billed out | Сумма billed | Контекст |
|---|---|---|---|---|---|
| PLANNING, отказ писать код | ~330 | 13 207 | 1 533 | 20 244 | 909 / 200000 (0%) |
| EXECUTION, отказ хоста (2 попытки) | ~978 | 16 128 | 1 578 | 72 830 | 952 / 200000 (0%) |
| после паузы, текущий шаг | ~989 | 15 328 | 1 762 | 91 168 | 1864 / 200000 (1%) |

Отказ на ходе 2 дороже: повтор генерации плюс шаблон «Нарушение этапа…». Occupancy после отказа почти не вырос (952 vs 909): в `messages` попал короткий отказ, не финальный отчёт. После паузы billed in снова полный (local runtime + `[STATE]` + история); модель продолжила JWT module, а не «сдачу».

**Итог:** ассистент работает с контролируемым жизненным циклом задачи. Недопустимый переход с CLI — ошибка с причиной. Просьба перепрыгнуть этап доходит до модели, но либо она сама остаётся на текущем шаге (план вместо кода), либо хост отклоняет черновик (финал без валидации). После паузы курсор тот же; `ask` продолжает текущий шаг, финал доступен только с VALIDATION.

## Персонализация

Отдельное хранилище, не слой `memory.long.profile`. Профиль принадлежит **пользователю** (`user_id`), агент только подключает его (`--profile` или `profile attach`).

```text
Profile storage (.md / DB / API)
        │  load(user_id)
        ▼
Profile Loader
        │  profile
        ▼
Prompt Builder  →  system + profile + query
        │
        ▼
LLM generate()  →  персонализированный ответ
```

| Backend | `PROFILE_STORAGE` | Где лежит |
|---|---|---|
| правила `.md` / `.mdc` | `file` (по умолчанию) | `data/profiles/<user_id>/profile.md`, `style.mdc`, `constraints.mdc`, `context.mdc` |
| JSON-БД | `db` | `data/profiles.db.json` |
| HTTP API | `api` | `PROFILE_API_URL` — `GET/PUT/DELETE /profiles/:id` |

`.mdc` — те же always-apply rules, что Cursor: YAML-frontmatter (`kind`, `user`, `alwaysApply: true`) и список `- ключ: значение`.

### Секции

**style** — как отвечать:

| ключ | пример |
|---|---|
| `length` | краткие / подробные ответы (`brief` / `detailed`) |
| `tone` | формальный / разговорный (`formal` / `casual`) |
| `examples` | с / без примеров кода (`code` / `none`) |
| `language` | язык ответа (`ru` / `en`) |

**constraints** — жёсткие рамки:

| ключ | пример |
|---|---|
| `stack` | javascript + nodeJS |
| `architecture` | MVVM |
| `dependencies` | минимум зависимостей |
| `apis` | только бесплатные api |

**context** — рамка задачи и роли:

| ключ | пример |
|---|---|
| `role` | senior fullstack nodeJS dev |
| `project` | сервис для запуска исполняемых bpmn-процессов |
| `team` | 3 человека |
| `deadline` | 3 недели |

Свободные ключи в любой секции тоже сохраняются.

```text
> profile create alex --name Алексей
> style alex length краткие
> style alex tone разговорный
> style alex examples code
> style alex language ru
> constraints alex stack javascript + nodeJS
> constraints alex architecture MVVM
> constraints alex dependencies минимум зависимостей
> constraints alex apis только бесплатные api
> context alex role senior fullstack nodeJS dev
> context alex project сервис для запуска исполняемых bpmn-процессов
> context alex team 3 человека
> context alex deadline 3 недели
> spawn --name helper --profile alex
> ask helper Как спроектировать API?
> profile alex
```

`prefer alex style length brief` — алиас. `profile attach helper alex` / `detach` меняет связь на живом агенте. `profile delete alex` (или `profile rm alex`) удаляет профиль из хранилища и отключает его у агентов. `task start` и `forget short` профиль не трогают.

В каждый `ask` Prompt Builder кладёт блок:

```text
Персонализация (alex / Алексей) — соблюдай в этом ответе; не противоречь без новой явной записи.
[стиль]
- объём ответа: краткие ответы
- тон: разговорный
- примеры кода: с примерами кода
- язык ответа: русский
[ограничения]
- стек: javascript + nodeJS
- архитектура: MVVM
- зависимости: минимум зависимостей
- api: только бесплатные api
[контекст]
- роль: senior fullstack nodeJS dev
- проект: сервис для запуска исполняемых bpmn-процессов
- команда: 3 человека
- дедлайн: 3 недели
```

На первом ходе сессии блок идёт вместе с system, памятью и историей; на последующих — снова префиксирует запрос. Occupancy в `tokens` его считает.

### Что ассистент учитывает автоматически

На каждый `ask` Prompt Builder склеивает блоки в таком порядке: **system → инварианты → профиль → состояние задачи → память → факты стратегии → summary → история → (violations) → вопрос**.

| Источник | Когда попадает в промпт |
|---|---|
| **Инварианты** | Каждый `ask`, пока агент с `--invariants` или `invariant attach`. Перед отправкой набор перечитывается с диска; после ответа — Validate |
| **Профиль** `style` / `constraints` / `context` | Каждый `ask`, пока агент с `--profile` или `profile attach`. Перед отправкой профиль перечитывается с диска |
| **System** (`spawn --system "…"`) | Первый ход сессии при `strategy=full`; дальше SDK помнит сессию |
| **Память** `short` / `working` / `long` | То же, что system; заполняется только `remember` / `task` / префиксами `/working` в `ask`. Это **не** персонализация: `memory.long.profile` — отдельный KV агента |
| **Задача** `working.machine` | Каждый `ask` при активной задаче: `[STATE]`, шаг, план, сделанное. Этап не перепрыгивается |
| **История диалога** | По `--strategy`: `full` — вся, `sliding`/`facts` — окно, плюс summary при compress |
| **Факты** | Только `strategy=facts` |
| **Репозиторий** (`CURSOR_RUNTIME=local`) | Вне билдера: SDK поднимает агента с `cwd` проекта. Оценка запроса у `a-none` была ~20 токенов, billed input — ~14 823: модель видит файлы репо, даже если профиль и system пустые |

Имя в профиле — заголовок блока («Персонализация (alex / Алексей)»), не правило стиля. Диалог сам профиль не обновляет: только `style` / `constraints` / `context` / `prefer`.

### Прогон: none / a-alex / a-marie

Три агента, модель `composer-2.5`, `CURSOR_RUNTIME=local`, `strategy=full`, сжатие выкл. **System-промпт пустой** — в ответ идёт профиль (если подключён) плюс контекст репозитория.

| Агент | Профиль | Occupancy до первого `ask` |
|---|---|---|
| `a-none` | нет | 0 / 200000 |
| `a-alex` | `alex` — senior Node, BPMN, кратко, код, ru | 121 / 200000 |
| `a-marie` | `marie` — staff Python, ML gateway, подробно, без кода, en | 124 / 200000 |

Одинаковые вопросы:

1. Как спроектировать API для этого проекта? С чего начать и что важно не забыть?
2. Какой стек и зависимости взять? Нужен ли пример кода? (только `a-alex` и `a-marie`)

#### Команды настройки

```text
> profile create alex --name Алексей
> style alex length краткие
> style alex tone разговорный
> style alex examples с примерами кода
> style alex language ru
> constraints alex stack javascript + nodeJS
> constraints alex architecture MVVM
> constraints alex dependencies минимум зависимостей
> constraints alex apis только бесплатные api
> context alex role senior fullstack nodeJS dev
> context alex project сервис для запуска исполняемых bpmn-процессов
> context alex team 3 человека
> context alex deadline 3 недели
> profile alex

> profile create marie --name Marie
> style marie length подробные
> style marie tone формальный
> style marie examples без примеров кода
> style marie language en
> constraints marie stack python + FastAPI
> constraints marie architecture microservices
> constraints marie dependencies можно зрелые библиотеки
> constraints marie apis допустимы платные облачные api
> context marie role staff backend engineer
> context marie project ML feature store and inference gateway
> context marie team 20 человек
> context marie deadline 6 месяцев
> profile marie

> spawn --name a-none --no-compress --strategy full
> spawn --name a-alex --profile alex --no-compress --strategy full
> spawn --name a-marie --profile marie --no-compress --strategy full

> ask a-none Как спроектировать API для этого проекта? С чего начать и что важно не забыть?
> ask a-alex Как спроектировать API для этого проекта? С чего начать и что важно не забыть?
> ask a-marie Как спроектировать API для этого проекта? С чего начать и что важно не забыть?
> ask a-alex Какой стек и зависимости взять? Нужен ли пример кода?
> ask a-marie Какой стек и зависимости взять? Нужен ли пример кода?
```

`profile list` после настройки: `alex` — style=4 constraints=4 context=4; `marie` — то же. Пустые профили `1` / `2` в этом прогоне не трогали.

#### Как разошлись ответы

| | `a-none` | `a-alex` | `a-marie` |
|---|---|---|---|
| Язык | русский | русский, обращение на «ты» | **английский**, обращение Marie |
| Предмет Q1 | API **этого** репо: `agent`, `pool`, `store`, `cli`, `memory` | **BPMN**: definitions, process-instances, tasks/complete | **ML feature store + inference gateway**, SLA по потребителям |
| Стек | HTTP-слой поверх текущего Node (Fastify/Hono «как в проекте») | Node, **MVVM** (View / ViewModel / Model), мало deps | **Python + FastAPI**, microservices, managed cloud |
| Примеры кода | да | **да** (роуты + VM) | **нет**; на Q2 явно: tutorial snippets не нужны, хватит ADR/OpenAPI |
| Команда / срок | нет | 3 человека, 3 недели, порядок работ на неделю 1 | ~20 engineers, six-month delivery |
| Ограничения API | нет | бесплатные движки (`bpmn-engine`, не Camunda Cloud) | платные/managed serving допустимы (Tecton, Bedrock, …) |

Второй `ask` профиль не сбросил: `a-alex` снова Node/MVVM/BPMN и JSON зависимостей; `a-marie` — FastAPI без fence’ов, отказ от примеров кода в ответе.

**Жёстко соблюдаются:** язык, `examples`, stack, architecture, project, частично deadline/team.

**Слабее:** `length=brief` — `a-alex` короче `a-marie`, но всё ещё развёрнутый ответ, не «телеграф». Тон (`casual` / `formal`) читается по обращению, не по длине.

#### Расход (ход 1 = вопрос про API)

| | Оценка запроса | Billed in | Billed out | Occupancy после ответа |
|---|---|---|---|---|
| `a-none` | ~20 | 14 823 | 2 392 | ~1271 / 200000 (1%) |
| `a-alex` | ~141 | 11 473 | 1 646 | ~1098 / 200000 (1%) |
| `a-marie` (ход 2, стек) | ~2539 | 6 325 | 2 576 | ~5135 / 200000 (3%) |

Оценка билдера считает только собранный текст (поэтому у `a-none` ~20). Billed input на порядки больше — local runtime подмешивает репозиторий. Блок профиля увеличивает оценку (~0 → ~121–124 ещё до `ask`) и меняет **предмет** ответа: без профиля модель проектирует API хоста, с профилем — BPMN-сервис или ML-шлюз.

**Итог:** персонализация — не «модель сама запомнила пользователя», а явный блок правил на каждый `ask` плюс workspace при `runtime=local`. Чтобы ответы расходились, достаточно разных `style` + `constraints` + `context`; флаг «кратко» сам по себе объём почти не режет.

## Инварианты и ограничения состояния

Отдельное хранилище, не диалог и не профиль. Набор принадлежит **проекту** (`set_id`), агент только подключает его (`--invariants` или `invariant attach`). После генерации ответ **проверяется программно**; нарушающий черновик пользователю не показывают.

```text
Invariant storage (JSON)
        │  load(set_id)
        ▼
Invariant Loader
        │  invariants
        ▼
Prompt Builder  →  [INVARIANTS] + state + query
        │
        ▼
LLM generate()  →  черновик ответа
        │
        ▼
Validate        →  Pass / Fail
        │
        ├─ Pass → ответ пользователю
        └─ Fail → retry с [VIOLATIONS]; если снова Fail — отказ
```

Файл: `data/invariants.json`. Диалог (`messages` в `data/agents.json`) инварианты не хранит — только `invariantSetId` у агента.

Профиль `constraints` — мягкая рамка. Инвариант нельзя нарушить даже как «альтернативу».

### Типы

| тип | пример | что запрещает |
|---|---|---|
| `stack` / `StackOnly` | NodeJS, JavaScript | предлагать другой стек (C#, ASP.NET, Python, …) |
| `arch` | MVVM | предлагать другую архитектуру (MVC, MVP, …) |
| `budget` | 100000 | оценку дороже потолка |
| `maxdeps` | 5 | больше N библиотек |
| `nobanned` | RxJava | рекомендовать запрещённое |
| `decision` | REST без GraphQL | ломать принятое решение |
| `apis` | free | платные API (Stripe, OpenAI, AWS, …) |

Если ответ не про технологии (например «2+2»), проверка стека/архитектуры его не валит. Если запрет называют, чтобы **отказать** («C# не входит, предлагаю NodeJS») — это Pass.

### Прогон Day 14: helper, «Спроектируй мне REST API»

Агент `helper`, модель `composer-2.5`, `CURSOR_RUNTIME=local`, `strategy=full`, сжатие выкл, набор `bpmn` (7 правил). Задача не стартовала (`working.machine` пустой): ограничение состояния здесь — **инварианты**, не этап автомата. Повторный запрос на C# рамку не снимает.

Эквивалент записи `StackOnly("NodeJS", "JavaScript")`: `invariant add bpmn StackOnly NodeJS JavaScript`. На живом агенте тот же набор: `invariant attach helper bpmn`.

#### Команды CLI

```text
npm start
> invariant create bpmn
> invariant add bpmn stack NodeJS JavaScript
> invariant add bpmn arch MVVM
> invariant add bpmn budget 100000
> invariant add bpmn maxdeps 5
> invariant add bpmn nobanned RxJava
> invariant add bpmn decision REST без GraphQL
> invariant add bpmn apis free
> invariant bpmn
> spawn --name helper --invariants bpmn --no-compress --strategy full --system "Отвечай по-русски, кратко, на уровне проектирования. Не пиши полные реализации."
> ask helper Спроектируй мне REST API
> ask helper Давай сделаем это на C# и ASP.NET
> ask helper Давай сделаем это на C# и ASP.NET
> tokens helper
```

#### Промпт первого `ask`

Prompt Builder склеивает system + `[INVARIANTS]` + вопрос (история на первом ходе пустая):

```text
Отвечай по-русски, кратко, на уровне проектирования. Не пиши полные реализации.

[INVARIANTS] (bpmn)
Жёсткие инварианты. Нарушение любого — ЗАПРЕЩЕНО.
В рассуждениях явно сверяй каждое предложение с этим списком.
Если запрос требует нарушения — откажись и предложи совместимое решение. Не предлагай запрещённое даже как альтернативу.
- Stack: NodeJS, JavaScript
- Architecture: MVVM
- Budget: 100000$
- MaxDeps <= 5
- NoBanned: RxJava
- Decision: REST без GraphQL
- APIs: только бесплатные API

Спроектируй мне REST API
```

#### Результат

| Ход | Запрос | Validate | Что ушло пользователю |
|---|---|---|---|
| 1 | Спроектируй мне REST API | Pass | REST `/api/v1` на **Node.js + JavaScript**, слои **MVVM**, **≤5** зависимостей, без GraphQL и платных API |
| 2 | Давай сделаем это на C# и ASP.NET | Pass (отказ модели) | C# / ASP.NET **запрещён**; тот же контракт остаётся на Node.js |
| 3 | Давай сделаем это на C# и ASP.NET | Pass (отказ модели) | Повтор не снимает инвариант: снова отказ, без ASP.NET |

Ход 1 — совместимый запрос, агент сразу работает внутри рамки:

```text
> ask helper Спроектируй мне REST API
→ helper:
## REST API (уровень проектирования)

**Контекст:** Node.js, MVVM — HTTP-слой = **View/API**, контроллеры тонкие, бизнес-логика в **ViewModel**
(`agent`, `task`, `profile`, `store`, `memory`, `pool`, `strategy`). Зависимости: в пределах **≤5** …
Стиль | REST, JSON, `/api/v1/...`
Внешние API | Только бесплатные
…

### Слои MVVM
HTTP → Route → ApiController → *ViewModel → store/memory/pool/agent
- View: Express/Fastify routes
- ViewModel: taskVM / agentVM / jobVM
- Model: существующие модули без HTTP

### Что сознательно не делаем
- GraphQL, Electron, платные API как обязательная часть контракта.
```

Ходы 2–3 — конфликт стека. Запрос **не фильтруется заранее**, доходит до модели как есть. Модель называет инвариант, отказывает и предлагает совместимое. Черновик с ASP.NET пользователю не показывают (Validate = Pass, потому что отказ рядом с C#):

```text
> ask helper Давай сделаем это на C# и ASP.NET
→ helper:
## Отказ

**Инвариант:** `Stack: NodeJS, JavaScript` — жёсткий.
Реализация REST на **C# / ASP.NET** этому противоречит, поэтому так делать **нельзя**,
в том числе как «основной + Node рядом», если цель — заменить стек.

## Совместимое решение (тот же REST, тот же контракт)
Оставляем **Node.js + JavaScript**, **REST**, **MVVM**:
- HTTP | Fastify или node:http
- View | маршруты, middleware, DTO
- ViewModel | обёртки над agent, task, profile, store, memory, pool
- Model | существующие модули в src/

Контракт `/api/v1/...` — тот же; меняется только runtime, не API.
**Итог:** C#/ASP.NET — только после снятия инварианта Stack.
```

Третий `ask` с тем же текстом снова отказ: «Инвариант `Stack: NodeJS, JavaScript` обязателен». Состояние ограничения не сбрасывается диалогом.

Если бы модель дважды предложила C# без отказа, хост подставил бы шаблон `инварианты: ответ отклонён (…)` и не записал бы черновик в `messages`. В этом прогоне хост не вмешивался: все три ответа — Pass модели.

#### Расход (3 хода)

| | `helper` |
|---|---|
| **inputTokens** | 23 054 |
| **outputTokens** | 2 461 |
| **totalTokens** | 30 539 |
| Последний ход | запрос ~1345 (billed 6245) \| ответ ~200 (billed 332) |

`list` печатает `invariants=bpmn`. Occupancy в `tokens` считает блок `[INVARIANTS]`. `invariant detach helper` / `invariant delete bpmn` снимают набор.

**Итог:** ассистент работает в рамках заданных инвариантов. Совместимый запрос («Спроектируй мне REST API») проектируется на Node / MVVM / REST. Конфликтный («сделай на C#») доходит до модели, но ответ — отказ + совместимый вариант; повтор не ломает рамку. Этап задачи при этом может быть пустым: инварианты ограничивают предложение независимо от автомата `planning → execution → validation → done`.

## Агент с явной моделью памяти (memory layers)

Два агента, модель `composer-2.5`, `CURSOR_RUNTIME=local`, `strategy=full`, сжатие выкл. Одинаковый system-промпт: опираться только на факты из контекста и блоков памяти; нет факта — «нет в контексте».

| Агент | Память |
|---|---|
| `mem-off` | только диалог (`messages`); `remember` не вызывали |
| `mem-on` | те же `ask` + явная запись в слои |

Тексты `ask` **без** префиксов `/working` и `/long`: иначе `parseMemoryDirective` записал бы слой и у «пустого» агента. Заполнение слоёв — только у `mem-on`, командами `remember` / `task start`.

### Вопросы (одинаковые `ask`)

1. Меня зовут Алексей. Отвечай кратко, по-русски, без воды.
2. Задача: спроектировать REST API списка задач. Ограничение: без внешних сервисов и без ORM.
3. Решили: аутентификация только JWT, ресурс задач — /tasks.
4. Статусы задачи: todo, doing, done. Зафиксируй это как договорённость.
5. Набросай эндпоинты списка задач, опираясь на то, что уже сказано.
6. **Зонд A.** Как меня зовут и в каком стиле отвечать? Какой auth и путь ресурса? Цель задачи и ограничения? Какие статусы? Нет в контексте — так и скажи.
7. **Зонд B.** Тот же текст, что зонд A (после `forget short` у обоих).
8. **Зонд C.** Напомни цель текущей задачи и ограничение про ORM. Напомни auth и как меня зовут. Нет в контексте — так и скажи.

### Шаги сверх `ask`

Между ходами 4 и 5 **только `mem-on`:**

```text
remember mem-on long:profile имя: Алексей
remember mem-on long:profile стиль: кратко, по-русски, без воды
remember mem-on long:decisions auth: JWT
remember mem-on long:decisions ресурс: /tasks
remember mem-on long:knowledge статусы: todo | doing | done
task mem-on start Спроектировать REST API
remember mem-on working цель: REST API списка задач
remember mem-on working ограничения: без внешних сервисов и без ORM
```

После зонда A — **оба:** `forget short` (обнуляет `messages` и `memory.short.entries`).

После зонда B — **только `mem-on`:** `task start Другая задача` (чистит working, long не трогает).

### Какие данные в каком слое

После `remember` (перед ходом 5), снимок `mem-on`:

| Слой | Содержимое |
|---|---|
| **short** | диалог в `messages` (8 сообщ. после хода 4); `short.entries` пусты — `remember short` не было |
| **working** | `task`: Спроектировать REST API; `цель`: REST API списка задач; `ограничения`: без внешних сервисов и без ORM |
| **long.profile** | `имя`: Алексей; `стиль`: кратко, по-русски, без воды |
| **long.decisions** | `auth`: JWT; `ресурс`: /tasks |
| **long.knowledge** | `статусы`: todo \| doing \| done |

У `mem-off` все три `memory.*` пустые на всём прогоне: факты жили только в `messages`, пока не сделали `forget short`.

После `forget short`: у обоих `messages = 0`; у `mem-on` working+long без изменений. После `task start Другая задача`: `working.entries` пустые, `task` = «Другая задача», long (5 записей) на месте.

### Как это влияет на ответы

| Ход | mem-off | mem-on |
|---|---|---|
| 5. эндпоинты | `/tasks`, JWT, статусы `todo/doing/done` — из диалога | то же + короче (стиль из profile); occupancy 1280 vs 1529 |
| Зонд A (диалог цел) | все факты: Алексей, JWT, `/tasks`, цель, ORM, статусы | все те же факты, ответ короче (316 vs 654 символа) |
| Зонд B (`forget short`) | **имя / auth / `/tasks` / статусы — «нет в контексте»** | **все факты на месте** из слоёв (имя, стиль, JWT, `/tasks`, цель, ORM, статусы) |
| Зонд C (working сброшена) | цель, ORM, auth, имя — «нет в контексте» | имя и JWT из **long**; цель/ORM модель всё ещё назвала — они уже прозвучали в ответе зонда B и лежат в **short** (`messages`), хотя `working.entries` пустые |

Контрольный ход — **зонд B**: без слоёв агент теряет рамку вместе с диалогом; со слоями отвечает из working+long, хотя `messages` пусты (occupancy ~272 vs ~439 у mem-off, который раздул «нет в контексте»).

Зонд C показывает разделение хранилищ (`working` очищен, `long` жив), но не «чистый» эффект working: предыдущий ответ зонда B остаётся краткосрочной репликой и может пересказать цель/ORM. Чтобы цель исчезла из ответа, нужен ещё `forget short` после смены задачи.

### Расход (сумма за 8 ходов)

| | mem-off | mem-on |
|---|---|---|
| **inputTokens** | 54 534 | 43 093 (−21%) |
| **outputTokens** | 4 978 | 3 171 (−36%) |
| **totalTokens** | 79 736 | 58 680 (−26%) |

`mem-on` после записи в память короче по output (стиль из profile) и дешевле по input на зондах B–C: в промпт идут компактные KV, а не попытка восстановить рамку из пустого диалога.

**Итог:** слои хранятся отдельно и заполняются только явной записью. Обычный `ask` не раскладывает текст по working/long. После сброса диалога отвечает тот агент, у которого факты лежат в слоях — это и есть явная модель памяти.

## Сравнение диалогов

Три агента, модель `composer-2.5`, `CURSOR_RUNTIME=local`. Одинаковые вопросы:

1. «что такое рнк»
2. «подробнее раскрой про типы рнк»
3. «для чего существует рнк»

| Агент | Лимит | Вопросы |
|---|---|---|
| Короткий | окно модели 200000 | только 1 |
| Длинный | окно модели 200000 | 1 → 2 → 3 в одной истории |
| Overflow | `--limit 200` | те же 1 → 2 → 3, пока не упрётся |

| Сценарий | Ход | Оценка запроса | Billed in | Billed out | Сумма billed | Контекст / лимит | Статус агента |
|---|---|---|---|---|---|---|---|
| Короткий | 1. что такое рнк | 4 | 3373 | 504 | 7205 | 254 / 200000 (0%) | ready, ответ ~984 символа |
| Длинный | 1. что такое рнк | 4 | 3373 | 631 | 4420 | 233 / 200000 (0%) | ready, ответ ~899 символов |
| Длинный | 2. типы рнк | 241 | 4053 | 2293 | 11182 | 1563 / 200000 (1%) | ready, ответ ~5267 символов |
| Длинный | 3. для чего рнк | 1569 | 6393 | 1311 | 22982 | 2321 / 200000 (1%) | ready, ответ ~2988 символов |
| Overflow | 1. что такое рнк | 4 | 3373 | 725 | 4514 | **365 / 200 (100%)** | ready: ответ записан, окно уже переполнено |
| Overflow | 2. типы рнк | 373 | не вызывался | — | 4514 | 365 / 200 | **ошибка**, messages не выросли |
| Overflow | 3. для чего рнк | — | — | — | 4514 | 365 / 200 | не дошли: диалог встал на ходе 2 |

Overflow на ходе 2:

```text
Переполнение контекста: запрос ~373 токенов > лимит 200 (лимит агента)
```

Агент остался `ready`, в истории только пара сообщений хода 1, billed не изменился. `send` для «типы рнк» не вызывался.

## Выводы

**Как растут токены и стоимость.** Каждый `ask` заново читает контекст плюс служебный overhead SDK (~3373 input даже на фразу «что такое рнк»). Дальше billed in растёт вместе с историей: 3373 → 4053 → 6393. Сумма за три хода длинного диалога — **22982** против **7205** за один короткий вопрос: втрое дороже, хотя окно модели заполнено всего на **1%** (2321 / 200000). Output зависит от объёма ответа, не от длины истории: короткое определение ~500–700 billed out, разбор типов — 2293. Третий вопрос короче второго, но **input** всё равно больше, потому что в контекст уже лежит длинный ответ про типы.

**Лимит модели и лимит агента — разные вещи.** Окно `composer-2.5` — 200000. Три вопроса про РНК его почти не трогают: агент остаётся `ready`, ответы приходят, история копится. `--limit 200` на `spawn` — это guard по оценке `len/4` диалога, не billed и не реальное окно модели. Поэтому ход 1 при лимите 200 **проходит** (оценка запроса 4 < 200), хотя billed in уже 3373 — модели этого хватает, агентский лимит смотрит только на текст истории.

**Что ломается при переполнении**

- Guard смотрит **следующий запрос**, а не ответ. Ход 1 влез, ответ модели раздул occupancy до 365 / 200 (100%). Агент при этом живой (`ready`), `tokens` показывает последнюю успешную пару. Диалог уже нельзя продолжить: любой follow-up упрётся в лимит.
- Ход 2 не доходит до модели: `ContextOverflowError`, `send` нет, «типы рнк» в `messages` не пишется, usage остаётся как после хода 1. Вопрос 3 даже не запускается.
- Ломается не процесс и не пул — ломается **продолжение диалога**. Короткий агент с окном 200k на том же вопросе отвечает дальше; overflow-агент застревает после первого ответа и дальше бесполезен, пока его не убить или не создать заново с большим `--limit`.
- Без `--limit` то же случится на реальном окне модели (~200k): SDK вернёт ошибку контекста, ответа не будет, этот ход не сохранится. Если у агента включено сжатие, после рестарта в первый `send` идёт уже сжатый контекст (summary + хвост), а не весь архив — если оценка после сжатия влезает в лимит, диалог можно продолжить.
- Предупреждение 80% на ходе 1 не сработало (запрос был ~4 токена). Переполнение «задним числом» ответом модели guard не откатывает.

Воспроизведение overflow на тех же вопросах:

```text
> spawn --name rna --limit 200
> ask rna что такое рнк
> ask rna подробнее раскрой про типы рнк
```

## Сжатие vs без сжатия: диалог про требования к ПО

Два агента, модель `composer-2.5`, `CURSOR_RUNTIME=local`, одинаковая цепочка из 9 вопросов по инженерии требований:

```text
> spawn --name noCompress --no-compress
> spawn --name Compress --compress-every 4
```

| # | Вопрос |
|---|---|
| 1 | что такое требования к разработке по |
| 2 | типы требований |
| 3 | для чего нужны требования |
| 4 | виды требований |
| 5 | подходы к разработке требований (виггерс, уидриг) |
| 6 | критерии качественных требований |
| 7 | форматы записи требований |
| 8 | подходы к систематизации требований |
| 9 | классификация нефункциональных требований |


### Расход токенов (billed, сумма за 9 ходов)

| Метрика | `noCompress` (без сжатия) | `Compress` (`compress-every 4`) | Δ |
|---|---|---|---|
| **inputTokens** | 82915 | 69659 | **−15,98%** |
| **outputTokens** | 11 796 | 14295 | +21,18% |
| **totalTokens** | 152 695 | 106 642 | **−30,1%** |
| Оценка контекста после хода 9 | ~7 908 | ~5 543 | **−30%** occupancy |

На ходах 4, 6 и 8 у `Compress` срабатывает свёртка батчами по 4 сообщения и пересоздание SDK-сессии; billed **input** на ходе 5 скачет — в промпт уходит summary + хвост, плюс overhead новой сессии. К концу диалога input на ходе 9 у сжатого агента **ниже**, а оценка occupancy почти в 1,5 раза меньше при том же числе сообщений в архиве (18).

### Качество ответов

Оба агента трактуют обрезанную формулировку «…к разработке **по**» как **ПО** и дают структурированные ответы (таблицы, FR/NFR, уровни абстракции). На первых трёх ходах содержание сопоставимо: определение, типы по содержанию/уровню, цели требований.

| Аспект | Без сжатия | Со сжатием (`every 4`) |
|---|---|---|
| Ходы 1–3 | Чуть подробнее про контекст репозитория на ходе 1; стабильная терминология | Более сжатый тон с хода 1; те же оси классификации |
| Ходы 6–7 | Критерии (IEEE 29148, SMART), форматы SRS/user stories/use cases | Те же темы, сопоставимая полнота |
| Ходы 8–9 | Систематизация (дерево, матрицы, трассировка); NFR по ISO 25010 | **Длиннее** по символам: меньше «пересказа» всей истории в контексте, больше нового текста в ответе |
| Связность диалога | Повторы и отсылки к ранее сказанному естественны (полная история в SDK) | После свёртки ответы остаются по теме, но реже цитируют формулировки с ходов 1–4 дословно |

**Итог по качеству:** для учебного конспекта по требованиям оба прогона пригодны. Со сжатием экономится контекст и суммарный billed input, но на «редких» уточняющих темах в середине длинного диалога возможна **потеря имён/нюансов**, уже ушедших в summary; поздние ответы могут быть **объёмнее** (рост outputTokens), так что экономия по totalTokens умеренная, не по output.

Воспроизведение:

```text
> spawn --name noCompress --no-compress
> spawn --name Compress --compress-every 4
> ask noCompress что такое требования к разработке по
… (остальные вопросы по таблице для каждого агента)
> tokens noCompress
> tokens Compress
```

## Сравнение стратегий: сбор бизнес-требований

Четыре агента, модель `composer-2.5`, `CURSOR_RUNTIME=local`, сжатие выкл, одинаковый system-промпт («бизнес-аналитик, фиксируй договорённости, без выдуманных фактов»). Сценарий — **12 ходов** сбора BR к запуску продажи строительных инструментов на маркетплейсы. У `sliding` и `facts` окно **8** сообщений (4 последних пары). У `branching` после хода 6: `checkpoint` + ветки `ozon-first` / `multi-mp`, дальше 7–12 шли в `ozon-first`.

| # | Вопрос (суть) |
|---|---|
| 1 | Цель: запуск на маркетплейсы, рамка проекта |
| 2 | Ограничения: 8 недель, бюджет закупок 1.5 млн ₽, без своего склада — только фулфилмент. Предпочитаю таблицы |
| 3 | Площадки: Ozon и Wildberries. Запомни: Яндекс Маркет на этапе 1 не трогаем |
| 4 | Ассортимент: ручной / электро / расходники, 120 SKU, из них 40 электро |
| 5 | География: Москва и Казань, ЦФО и ПФО |
| 6 | Решили: бренд «Стальной Клин», средний+, гарантия 12 мес. через партнёра |
| 7 | Конкуренты: ВсеИнструменты.ру и нишевые кабинеты WB → требования к контенту |
| 8 | KPI Q1: GMV 4 млн, возвраты ≤ 8%, рейтинг ≥ 4.6 — только эти три цифры = успех |
| 9 | Сведи все требования в один документ, ничего не выдумывай |
| 10 | Напомни бюджет, срок и какие площадки отложили. Нет в контексте — так и скажи |
| 11 | Электро 40 → 25 SKU, всего по-прежнему 120. Что ещё не менялось? |
| 12 | Backlog спринта 1. Не предлагай Яндекс Маркет и свой склад |

Контроль стабильности: ход 9 (полная сводка), ход 10 (ранние цифры без подсказки), ходы 11–12 (обновление + backlog на всех договорённостях).

### Расход токенов (billed, сумма за 12 ходов)

| Метрика | `full` | `sliding` (окно 8) | `facts` (окно 8) | `branching` |
|---|---|---|---|---|
| **inputTokens** | 165 952 | 123 971 (**−25%**) | 117 283 (**−29%**) | 158 670 (−4%) |
| **outputTokens** | 22 294 | 23 102 | 23 262 | 22 913 |
| **cacheReadTokens** | 125 120 | 34 912 | 18 880 | 120 960 |
| **totalTokens** | 313 366 | 181 985 (**−42%**) | 159 425 (**−49%**) | 302 543 (−3%) |
| Оценка контекста после хода 12 | ~11 675 | ~4 803 (**−59%**) | ~4 889 (**−58%**) | ~12 683 |
| Сообщений в истории | 24 | 8 (хвост) | 8 + 13 фактов | 24 в `ozon-first` (у `multi-mp` 12) |

`full` и `branching` держат SDK-сессию: ~75% input — cache read. `sliding`/`facts` пересоздают сессию на каждый `ask`, cache почти не копится, зато **occupancy не растёт** после хода 4 (окно заполнилось). Output у всех сопоставим (~22–23k): стратегия режет вход, не длину ответа.

Billed input ≠ оценка `len/4`. На ходе 12 у `sliding` occupancy ~4803, а billed in **30 479** (скачок новой сессии). На ходе 11 у `facts` — 21 814 при occupancy ~3740. Guard смотрит оценку, счётчик денег — billed.

### Качество ответа

Все четыре с хода 1 отвечают как аналитик: таблицы, ID требований, явно помечают «не согласовано». Ход 9 — полноценный BRD (цель, ограничения, площадки, ассортимент, логистика, бренд, KPI). Ход 12 — backlog кабинетов Ozon/WB без Яндекс Маркета и без своего склада.

| Аспект | `full` | `sliding` | `facts` | `branching` |
|---|---|---|---|---|
| Ход 9, сводка | Все ключевые цифры; BR-ID | Все цифры; часть формулировок короче («инструмент» вместо «строительных инструментов») | Все цифры; цель/ограничения совпали с блоком фактов | Как `full`, чуть длиннее |
| Тон | Стабильные ID (BR-ASM, BR-MP) | Свои TR-10…TR-25; аббревиатуры «Я.Маркет», «8 нед.» | Таблицы, списки — предпочтение с хода 2 попало в facts | Как `full` |
| Выдумки сверх договорённостей | Помечает открытые пункты | То же | То же | То же |

Для этого сценария **качество текста сопоставимо**. Разница не в «красивости», а в том, из чего модель собирает сводку.

### Стабильность (не теряет ли детали)

Ход 10 — прямой запрос ранних фактов (бюджет, срок, отложенные площадки). **Все четыре** ответили: 1,5 млн ₽ на закупки, 8 недель, Ozon + WB в scope, Яндекс Маркет отложен. Никто не сказал «нет в контексте».

Почему `sliding` не «забыл» ход 2 после выпадения его из окна: в требованиях-диалоге модель **пересказывает рамку** в ответах 5–8, и эта пересказанная рамка ещё живёт в хвосте. Ход 9 дополнительно упаковывает всё в BRD, который остаётся в окне на 10–12.

Где потеря всё же видна:

- `sliding`: исходная формулировка «строительные инструменты» на сводке сгладилась до «инструмент». Уникальный факт, который ни разу не повторили бы позже, из окна ушёл бы безвозвратно (с диска тоже).
- `facts`: в KV попали цель, ограничения (срок + бюджет + фулфилмент), площадки, «Запомни: не трогаем Яндекс Маркет», география, бренд, KPI. **SKU 120 / 40** в факты с хода 4 не легли (extractor взял только первое предложение «ручной / электро / расходники»); на сводке они всё равно были — из хвоста окна и пересказа. После хода 11 появился отдельный ключ `ассортимент` (строчная) с «40 → 25, всего 120» рядом со старым `Ассортимент`. Ключи шумные: `Запомни`, `квартала`, `документ`.
- `full` / `branching`: исходные реплики на месте. На ходе 11–12 модель один раз написала бренд как «Стальной **K**лин» (латиница) — это шум генерации, не стратегии.

Ход 11 (замена 40→25 при 120): все четыре обновили ассортимент и перечислили, что не менялось (бюджет, площадки, география, KPI). `sliding` и `facts` писали «8 нед.» / «Я.Маркет», но смысл держали.

### Удобство для пользователя

| | Команды сверх `ask` | Что видит пользователь | Когда брать |
|---|---|---|---|
| **full** | нет | Вся переписка, ответы ссылаются на ранние формулировки | Линейный сбор требований, важны нюансы «как сказано» |
| **sliding** | нет (`window N`) | Старое просто исчезает, предупреждения нет | Короткий уточняющий диалог; экономия токенов, если рамка повторяется |
| **facts** | `facts <имя>` по желанию | Память можно открыть и проверить; `ask` как обычно | Сбор BR / ограничений / решений: дешевле `full`, устойчивее голого `sliding` |
| **branching** | `checkpoint`, `branch A B`, `use` | Две независимые истории; в этом прогоне `multi-mp` так и остался на чекпоинте (12 сообщ.) | Сравнение альтернатив (Ozon-first vs вторая площадка), не линейный опросник |

Для **линейного** сбора 10–15 сообщений ветки не дают выигрыша по качеству и почти не экономят токены (`branching` ≈ `full`). Выигрыш — возможность не смешать два плана в одной истории, если после хода 6 уйти в `multi-mp` и спросить другой scope.

### Итог

1. **Качество** на 12 ходах сборки BR — у всех рабочее; эталон по полноте формулировок — `full` / `branching`.
2. **Стабильность:** ход-проверка ранних цифр прошли все. `sliding` живёт за счёт пересказа в хвосте, не за счёт исходных реплик. `facts` страхует цель/ограничения/площадки отдельным блоком, но extractor неидеален (дубли ключей, SKU с хода 4).
3. **Токены:** `facts` −49% total к `full`, `sliding` −42%, occupancy у обоих ~в 2.4 раза ниже. `branching` в линейном режиме почти как `full`.
4. **Удобство:** для такого сценария лучший компромисс — **`facts` + окно 8**: дешевле, ключевые договорённости не выпадают вместе с окном, память можно посмотреть. `full` — если нельзя потерять дословность. `sliding` — если диалог короткий или вы сами повторяете рамку. `branching` — когда нужны развилки, не когда копите один BRD.

Воспроизведение:

```text
> spawn --name str-full --strategy full --no-compress --system "Ты бизнес-аналитик. Собираешь и уточняешь бизнес-требования к запуску продаж. Фиксируй договорённости явно. Отвечай по-русски, структурировано, без воды. Не выдумывай факты сверх того, что сказал пользователь."
> spawn --name str-sliding --strategy sliding --window 8 --no-compress --system "…"
> spawn --name str-facts --strategy facts --window 8 --no-compress --system "…"
> spawn --name str-branch --strategy branching --no-compress --system "…"
> ask str-full Цель: запуск продажи строительных инструментов на маркетплейсы. …
… (ходы 1–12 для каждого; у str-branch после хода 6: checkpoint + branch ozon-first multi-mp)
> tokens str-full
> facts str-facts
```

## Структура

```
src/
  index.js      # точка входа, REPL
  cli.js        # разбор команд (remember, memory, profile, invariant, …)
  pool.js       # пул инстансов (лимит 100)
  agent.js      # LlmAgent: ask, токены, стратегии, память, profile + invariant pipeline
  memory.js     # short / working / long — явная запись и блоки в промпте
  task.js       # конечный автомат: состояния, таблица переходов, охрана скипов, проверка этапа
  profile.js    # фасад персонализации: ProfileService, loader, builder
  profile/      # storage (.mdc/db/api), loader, prompt builder, model
  invariant.js  # фасад инвариантов: InvariantService, validate, retry
  invariant/    # типы (StackOnly, Arch, Budget, …), JSON-хранилище, pipeline
  strategy.js   # sliding / facts / branching
  context.js    # сжатие истории: флаг, порог N, summary
  tokens.js     # оценка, лимит окна, форматирование usage
  store.js      # JSON-хранилище истории, facts, веток, memory, задачи и usage
  env.js        # загрузка .env
  mcp-server.js # локальный MCP-сервер (add, echo, device_time, city_time, git_status, reminder)
  mcp-client.js # MCP-клиент и конфиг demo-mcp для SDK
  mcp-trace.js  # разбор tool_call: аргументы, текст результата, строка трассы
  reminders.js  # reminder: JSON, create/stop/tick/summary
data/
  agents.json, invariants.json, profiles/, reminders.json, reminder-loop.json, *-benchmark.json, task-lifecycle-cycle.json — примеры и артефакты прогонов
test/
  *.test.js — unit-тесты памяти, задач, инвариантов, переходов, MCP, reminders
scripts/
  *-benchmark.js, task-lifecycle-cycle.js, mcp-agent-cycle.js, reminder-loop.js — воспроизведение прогонов из README
results/
  артефакты отдельных режимов (direct, temperature, models, …)
.env.example
```

В репозитории **Day 18** папки `data/`, `test/`, `scripts/`, `results/` включены для воспроизведения прогонов (без API-ключей). В локальном `.gitignore` корня проекта эти каталоги по-прежнему исключены.

## Примечания

- Файл `.env` с ключом **не коммитится** — только `.env.example`.
- Локальный агент получает MCP-сервер проекта (`tools: ["mcp"]`, сервер `demo-mcp`). У cloud по-прежнему `tools: []`.
- При `exit` или закрытии терминала SDK-сессии dispose, история и usage на диске сохраняются.
