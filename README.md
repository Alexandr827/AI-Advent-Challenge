# AI-Advent-Challenge

Репозиторий с проектами челленджа AI Advent.

## Day 32 — Автоматизация ревью кода

- **[dev-assistant](dev-assistant/)** — AI-ревью PR: `npm run review`, `scripts/ai-review.js` (diff → RAG по документации → LLM → отчёт), установка CI через `npm run pr:pipeline -- install`. Плюс ассистент Day 31: `connect`, `/help`, project MCP.
- **[Day 32](Day%2032/)** — снимок `nodeJsProject` (дни 14–31 + описание Day 32 в README).

В корне репозитория — [`.github/workflows/ai-review.yml`](.github/workflows/ai-review.yml): при `pull_request` (opened/synchronize) публикуется комментарий с ревью. Секреты `LMSTUDIO_*` / `LLM_SERVICE_TOKEN` опциональны; без них ответ собирается из diff и RAG.

Секреты в репозиторий не кладите: `.env`, `data/connection.json` — только локально. Шаблон переменных — `Day 32/.env.example`.

## Day 31 — Ассистент разработчика

- **[Day 31](Day%2031/)** — снимок до выноса AI-ревью; актуальный CLI — в `dev-assistant/`.

Предыдущие дни — каталоги `Day 1` … `Day 30`.
