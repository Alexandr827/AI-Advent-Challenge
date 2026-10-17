# Day 33 — Ассистент поддержки пользователей

Python-проект **user-assistant**: агент первой линии поддержки, который объединяет CRM-контекст, RAG по FAQ и генерацию ответа через Cursor SDK.

## Возможности

- **RAG по FAQ** — поиск релевантного ответа в `faq.json` (TF-IDF + cosine similarity, scikit-learn).
- **Контекст CRM** — данные тикета и пользователя из `crm_data.json` (в демо вызываются напрямую; отдельно есть MCP-сервер `mcp_crm_server.py` с инструментами `get_ticket_info` / `get_user_info`).
- **Ответ ассистента** — `support_agent.py` собирает промпт и вызывает `cursor_sdk.Agent.prompt`.

## Быстрый старт

```bash
cd "Day 33"
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# задайте CURSOR_API_KEY в .env
python support_agent.py
```

Демо-запрос в `__main__`: тикет `T-1042`, вопрос про авторизацию.

## MCP CRM (опционально)

```bash
python mcp_crm_server.py
```

## Секреты

Файл `.env` в репозиторий не попадает. Используйте `.env.example`.
