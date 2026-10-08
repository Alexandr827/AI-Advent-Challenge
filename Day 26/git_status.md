# git_status

Найдено: 12

## Код
- scripts/mcp-agent-cycle.js:26 — "Вызови MCP-инструмент git_status сервера demo-mcp.",
- scripts/mcp-agent-cycle.js:29 — "Когда получишь результат, первой строкой ответа напиши дословно первую строку вывода git_status.",
- scripts/mcp-agent-cycle.js:59 — "Отвечай по-русски. Для вопросов о статусе репозитория вызывай только MCP-инструмент git_status и опирайся на его текст.",
- scripts/mcp-agent-cycle.js:74 — const call = completedCall(tools, "git_status");
- scripts/mcp-agent-cycle.js:89 — console.error("Агент не получил результат MCP git_status");
- scripts/mcp-agent-cycle.js:92 — console.error("Ответ агента не содержит текст результата git_status");
- src/mcp-client.js:94 — name: "git_status",
- src/mcp-client.js:101 — console.log("git_status:");
- src/mcp-pipeline.js:12 — "ask <agent> прогони git_status через mcp-tool search, summarize и save",
- src/mcp-server.js:131 — "git_status",
- test/mcp-pipeline.test.js:28 — const search = searchFeature("git_status", { root: repoRoot });
- test/mcp-pipeline.test.js:31 — assert.equal(data.feature, "git_status");

## README
> **Day 17:** на локальном MCP-сервере появился первый инструмент вокруг Git — `git_status`. Он регистрируется через `registerTool`, описывает входной параметр `repo` в `inputSchema` и возвращает вывод `git status --porcelain=v1 -b`. Локальный агент получает сервер `demo-mcp` (`tools: ["mcp"]`), вызывает инструмент из `…
> | Tool | Возможность | |---|---| | `add` | сложить два числа | | `echo` | вернуть строку | | `device_time` | дата, время и IANA-пояс машины, где запущен сервер | | `city_time` | время и пояс Москвы (`Europe/Moscow`, UTC+3) и Пекина (`Asia/Shanghai`, UTC+8) | | `git_status` | ветка и изменения локального репозитория (`…
