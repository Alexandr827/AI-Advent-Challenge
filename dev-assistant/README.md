# Ассистент разработчика

Отдельный CLI. Он подключается к чужому репозиторию, индексирует его документацию и отвечает на `/help`, опираясь на этот индекс и на MCP-контекст проекта.

## Запуск

```bash
npm install
npm start
```

Нужен Node.js `>= 22.5` (`node:sqlite`). `git` должен быть в `PATH`. Новых возможностей сверх `@modelcontextprotocol/sdk`, `zod` и `unpdf` нет. LM Studio на `127.0.0.1:1234` необязательна: без неё ответ собирается из найденных фрагментов.

## Что умеет

- `connect <путь>` запоминает корень проекта в `data/connection.json` этого CLI.
- RAG читает корневой README, текстовые файлы в `docs/` (markdown, txt, pdf), схемы (`*.sql`, `*.prisma`, `*.graphql`, `*schema*.json`) и API-описания (`openapi*` / `swagger*` в json, yml, yaml). Индекс пишется в подключённый проект: `data/doc-index/project.sqlite`. Каталоги `node_modules`, `.git` и `data` пропускаются. Первый `/help` собирает индекс сам. Явная сборка: `npm run index -- /путь/к/проекту`.
- MCP-сервер `project-mcp` (`src/mcp-project.js`) запускается с `cwd` подключённого проекта. Инструменты: `git_branch`, `list_files`, `git_diff`. Путь вне корня они не принимают.

Роли файлов в индексе: `doc` — README и `docs/`, `schema` — схемы, `api` — OpenAPI/Swagger.

## Ручной прогон

Пример — каталог `Day 32` в [AI-Advent-Challenge](https://github.com/Alexandr827/AI-Advent-Challenge) (клон репозитория и путь к папке).

```text
npm start
connect /путь/к/AI-Advent-Challenge/Day 32
/help
/help какая сейчас ветка
/help перечисли файлы проекта
/help покажи git diff
/help как течёт команда и где функция parseCommand
```

1. **Подключение** — `connect` печатает путь. `/help` без вопроса перечисляет файлы RAG, сервер `project-mcp`, инструменты `git_branch`, `list_files`, `git_diff`, строку `Ветка:` и блок `Файлы:`.
2. **Текущая git-ветка** — `/help какая сейчас ветка`. Имя ветки в строке `Ветка:`. Слово «ветка» заодно вызывает `git_diff`, поэтому в том же ответе есть блок `Diff:`.
3. **Список файлов** — `/help перечисли файлы проекта`. Блок `Файлы:` без diff.
4. **Список diff** — `/help покажи git diff`. Блок `Diff:` с незакоммиченными изменениями или с текстом `Изменений нет.`
5. **Функция в проекте** — `/help как течёт команда и где функция parseCommand`. Ответ опирается на README подключённого проекта, секция «Как течёт команда»: `src/index.js` → `cli.parseCommand`. В источниках строка вида `README.md | Как течёт команда`.

Ответ на вопрос состоит из трёх блоков: «Ответ», «Источники» (`файл | секция`) и «Контекст MCP». Ветка и список файлов приходят с каждым вопросом. Diff добавляется, когда в вопросе есть изменения, diff или ветка. Вопрос о структуре всегда получает обзорный фрагмент README.

Команда `help` без слэша печатает список команд этого CLI и к проекту не обращается.

## AI-ревью Pull Request

Цепочка на GitHub: **PR created → diff (`pull_request.diff_url`) → RAG (документация) → LLM-ревью → комментарий в PR**.

Ревью разбирает **подключённый проект**, а не каталог dev-assistant. В ответе три раздела: потенциальные баги, архитектурные проблемы, рекомендации.

### Локально (до создания PR)

Вторую копию репозитория скачивать не нужно: в одном клоне уже есть база и текущие правки.

```bash
npm start
connect /путь/к/проекту
npm run review
# явный корень и диапазон (как будущий PR):
node scripts/ai-review.js --root /путь/к/проекту --base origin/main --head HEAD
# готовый patch-файл:
node scripts/ai-review.js --root /путь/к/проекту --diff ./change.patch
```

По умолчанию diff — `main...HEAD` (или `master` / `origin/main`, если локальной `main` нет). Если новых коммитов нет, берутся незакоммиченные изменения. Явный диапазон: `--base` / `--head` или `PR_BASE_SHA` / `PR_HEAD_SHA`.

LM Studio (`LMSTUDIO_BASE_URL`, `LMSTUDIO_MODEL`) необязательна: без модели ответ собирается из diff и найденных фрагментов.

### Пайплайн на Pull Request

Скрипт `scripts/ai-review.js` живёт в **dev-assistant**. В проекте (например [AI-Advent-Challenge](https://github.com/Alexandr827/AI-Advent-Challenge)) — workflow `.github/workflows/ai-review.yml`: checkout проекта и dev-assistant, затем `node scripts/ai-review.js --diff` с URL diff из события PR.

**Установка в подключённый проект:**

```bash
cd /путь/к/dev-assistant
connect /путь/к/AI-Advent-Challenge
npm run pr:pipeline -- install
```

```bash
cd /путь/к/AI-Advent-Challenge
git add .github/workflows/ai-review.yml
git commit -m "ci: AI-ревью PR"
git push
gh pr create ...
```

При `opened` / `synchronize` job качает diff по API GitHub, индексирует документацию проекта и публикует комментарий в PR.

Переменные установки: `DEV_ASSISTANT_GITHUB_REPO` (по умолчанию `Alexandr827/AI-Advent-Challenge` — dev-assistant в корне монорепо), `DEV_ASSISTANT_GITHUB_REF` (`main`). Секреты `LMSTUDIO_BASE_URL`, `LLM_SERVICE_TOKEN`, `LMSTUDIO_MODEL` в репозитории проекта опциональны.
