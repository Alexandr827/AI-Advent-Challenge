import asyncio
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

import httpx

os.environ["DATA_DIR"] = tempfile.mkdtemp()
os.environ["JOBS_INLINE"] = "1"
os.environ["LLM_STRONG_API_KEY"] = ""
os.environ["LLM_CHEAP_API_KEY"] = ""

from fastapi.testclient import TestClient

from app.db import data_dir, reset_connection
from app.llm import LLMResult, ToolCall, archive_session, chat, set_handler, set_http_client_factory
from app import agent, generate, memory, retrieve, session as sessions, tools

reset_connection()

from app.main import app  # noqa: E402


class ServiceTest(unittest.TestCase):
    def setUp(self):
        set_handler(None)
        self.client = TestClient(app)

    def tearDown(self):
        set_handler(None)
        set_http_client_factory(None)
        os.environ["LLM_STRONG_API_KEY"] = ""
        os.environ["LLM_CHEAP_API_KEY"] = ""

    def _profile(self, name="Автор"):
        response = self.client.post("/api/profiles", json={"name": name, "writing_note": "коротко"})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_cursor_gateway_reuses_agent_and_reads_sse(self):
        calls = []
        reply = json.dumps(
            {
                "tool_calls": [
                    {
                        "name": "finish_turn",
                        "arguments": {"action": "ask", "message": "уточните фичу"},
                    }
                ]
            }
        )

        def handler(request: httpx.Request) -> httpx.Response:
            path = request.url.path
            calls.append((request.method, path))
            if path == "/v1/agents" and request.method == "POST":
                body = json.loads(request.content.decode())
                self.assertEqual(body["model"]["id"], "grok-4.7")
                self.assertEqual(body["mode"], "agent")
                self.assertNotIn("repos", body)
                self.assertIn("finish_turn", body["prompt"]["text"])
                return httpx.Response(
                    201,
                    json={"agent": {"id": "bc-1"}, "run": {"id": "run-1", "status": "RUNNING"}},
                )
            if path == "/v1/agents/bc-1/runs" and request.method == "POST":
                body = json.loads(request.content.decode())
                self.assertEqual(body["mode"], "agent")
                return httpx.Response(200, json={"run": {"id": "run-2", "status": "CREATING"}})
            if path.endswith("/stream"):
                payload = json.dumps({"status": "FINISHED", "text": reply, "runId": "run"})
                raw = f"event: result\ndata: {payload}\n\n".encode()
                return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=raw)
            if path == "/v1/agents/bc-1/archive":
                return httpx.Response(200, json={})
            return httpx.Response(404, json={"path": path, "method": request.method})

        def factory():
            return httpx.AsyncClient(transport=httpx.MockTransport(handler))

        set_http_client_factory(factory)
        os.environ["LLM_STRONG_API_KEY"] = "test-key"
        os.environ["LLM_STRONG_BASE_URL"] = "https://api.cursor.com/v1"
        os.environ["LLM_STRONG_MODEL"] = "grok-4.7"
        profile = self._profile("Шлюз")
        record = sessions.create_session(profile["id"], "Показать список контактов")
        kwargs = {
            "tools": [{"name": "finish_turn", "parameters": {"type": "object"}}],
            "session_id": record["id"],
        }
        result = asyncio.run(
            chat("strong", [{"role": "user", "content": "Показать список контактов"}], **kwargs)
        )
        self.assertEqual(result.model, "grok-4.7")
        self.assertEqual(result.tool_calls[0].name, "finish_turn")
        self.assertEqual(result.tool_calls[0].arguments["message"], "уточните фичу")
        again = asyncio.run(chat("strong", [{"role": "user", "content": "ещё раз"}], **kwargs))
        self.assertEqual(again.tool_calls[0].arguments["message"], "уточните фичу")
        self.assertIn(("POST", "/v1/agents/bc-1/runs"), calls)
        self.assertEqual(sum(1 for method, path in calls if method == "POST" and path == "/v1/agents"), 1)
        self.assertNotIn(("POST", "/v1/agents/bc-1/archive"), calls)
        asyncio.run(archive_session(record["id"]))
        self.assertIn(("POST", "/v1/agents/bc-1/archive"), calls)
        self.assertIsNone(sessions.cursor_agent_id(record["id"], "strong"))

    def test_profile_requires_name(self):
        response = self.client.post("/api/profiles", json={"name": "  "})
        self.assertEqual(response.status_code, 400)

    def test_needs_key_keeps_feature(self):
        profile = self._profile()
        response = self.client.post(
            "/api/sessions",
            json={"profile_id": profile["id"], "feature": "Показать список пользователей из телефонной книги", "project": "Книга"},
        )
        self.assertEqual(response.status_code, 200, response.text)
        view = response.json()
        self.assertEqual(view["job"]["status"], "needs_key")
        self.assertEqual(view["session"]["phase"], "needs_key")
        self.assertTrue(any(item["kind"] == "agent_message" for item in view["snapshots"]))

    def test_short_request_replaces_skeleton_without_confirmation(self):
        async def handler(slot, messages, tools):
            return LLMResult(
                text="",
                tool_calls=[
                    ToolCall("finish_turn", {"action": "ask", "message": "Каркас уже короткий.", "reason": "ок"}, "1")
                ],
                model="fake-strong",
                slot=slot,
            )

        set_handler(handler)
        profile = self._profile()
        response = self.client.post(
            "/api/sessions",
            json={"profile_id": profile["id"], "feature": "Хочу короткое ТЗ на 1 страницу: кнопка экспорта"},
        )
        view = response.json()
        self.assertEqual(view["skeleton"]["id"], "short")
        self.assertEqual(len(view["skeleton"]["sections"]), 3)
        saved = self.client.get("/api/profiles").json()["profiles"]
        profile_after = next(item for item in saved if item["id"] == profile["id"])
        self.assertEqual(profile_after["skeleton"]["id"], "short")

    def test_agent_proposes_skeleton_and_accept_saves_profile(self):
        calls = {"n": 0}

        async def handler(slot, messages, tools):
            self.assertEqual(slot, "cheap")
            calls["n"] += 1
            if tools and calls["n"] == 1:
                return LLMResult(
                    text="",
                    tool_calls=[ToolCall("suggest_skeleton", {"feature_description": "список контактов"}, "1")],
                    model="fake-strong",
                    slot=slot,
                )
            if tools:
                return LLMResult(
                    text="",
                    tool_calls=[
                        ToolCall(
                            "finish_turn",
                            {
                                "action": "propose_skeleton",
                                "skeleton_id": "standard",
                                "message": "Для этой фичи лучше подойдёт полный каркас, потому что нужны критерии приёмки.",
                                "reason": "Фича локальная, вопросы не задаю",
                            },
                            "2",
                        )
                    ],
                    model="fake-strong",
                    slot=slot,
                )
            raise AssertionError("draft was not requested")

        set_handler(handler)
        profile = self._profile("С каркасом")
        created = self.client.post(
            "/api/sessions",
            json={"profile_id": profile["id"], "feature": "Показать список пользователей из телефонной книги"},
        )
        view = created.json()
        self.assertIsNotNone(view["proposal"])
        self.assertIn("лучше подойдёт", view["proposal"]["message"])
        self.assertEqual(view["proposal"]["skeleton"]["id"], "standard")
        accepted = self.client.post(f"/api/sessions/{view['session']['id']}/skeleton", json={"action": "accept"})
        self.assertEqual(accepted.status_code, 200, accepted.text)
        saved = self.client.get("/api/profiles").json()["profiles"]
        match = next(item for item in saved if item["id"] == profile["id"])
        self.assertEqual(match["skeleton"]["id"], "standard")
        self.assertGreaterEqual(accepted.json()["job"]["prompt_chars"], 1)

    def test_second_skeleton_requires_author_choice(self):
        profile = self._profile("Два файла")
        created = self.client.post(
            "/api/sessions",
            json={"profile_id": profile["id"], "feature": "Экспорт контактов"},
        )
        session_id = created.json()["session"]["id"]
        first = self.client.post(
            f"/api/sessions/{session_id}/files",
            data={"purpose": "skeleton"},
            files={"file": ("one.md", b"# Cel\n\ntext\n# Obyom\n\nmore\n", "text/markdown")},
        )
        self.assertEqual(first.status_code, 200, first.text)
        second = self.client.post(
            f"/api/sessions/{session_id}/files",
            data={"purpose": "skeleton"},
            files={"file": ("two.md", b"# Drugoy\n\ntext\n", "text/markdown")},
        )
        self.assertEqual(second.status_code, 200, second.text)
        choice = second.json()["choice"]
        self.assertEqual(len(choice["options"]), 2)
        self.assertIsNone(second.json()["skeleton"])
        chosen = self.client.post(
            f"/api/sessions/{session_id}/skeleton-choice",
            json={"which": "2"},
        )
        self.assertEqual(chosen.status_code, 200, chosen.text)
        self.assertEqual(chosen.json()["skeleton"]["title"], "two.md")
        self.assertIsNone(chosen.json()["choice"])

    def test_foreign_file_and_audio_transcript(self):
        profile = self._profile("Файлы")
        created = self.client.post(
            "/api/sessions",
            json={"profile_id": profile["id"], "feature": "Импорт книги"},
        )
        session_id = created.json()["session"]["id"]
        uploaded = self.client.post(
            f"/api/sessions/{session_id}/files",
            data={"purpose": "audio"},
            files={"file": ("call.mp3", b"not-audio", "audio/mpeg")},
        )
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        file_id = uploaded.json()["files"][0]["id"]
        result = tools.extract_from_pdf(session_id, file_id)
        self.assertTrue(result["needs_transcript"])
        self.assertIn("error", tools.extract_from_pdf(session_id, "missing"))

    def test_rag_search_prefers_heading(self):
        retrieve.add_spec("# Ограничения\n\nНе делаем рассылку\n# Архитектура\n\nСервис и база\n", session_id=None)
        found = retrieve.search("ограничения", limit=2)
        self.assertTrue(found)
        self.assertEqual(found[0]["heading"], "Ограничения")

    def test_grounding_turns_unsupported_statement_into_question(self):
        document = {
            "sections": [
                {
                    "id": "goal",
                    "title": "Цель",
                    "blocks": [
                        {"kind": "statement", "text": "Интеграция с банком уже есть", "sources": []},
                        {
                            "kind": "statement",
                            "text": "Показать список",
                            "sources": [{"type": "answer", "id": "known"}],
                        },
                    ],
                }
            ]
        }
        self.assertEqual(generate.validate_document(document), [])
        repaired, marks = generate.repair_grounding(document, {"known"})
        kinds = [block["kind"] for block in repaired["sections"][0]["blocks"]]
        self.assertEqual(kinds, ["question", "statement"])
        self.assertEqual(len(marks), 1)

    def test_answers_land_in_the_named_section(self):
        profile = self._profile("Ответы")
        created = self.client.post(
            "/api/sessions",
            json={"profile_id": profile["id"], "feature": "Ставка НДС"},
        )
        session_id = created.json()["session"]["id"]
        sessions.add_snapshot(
            session_id,
            sessions.new_turn(),
            "skeleton_current",
            {"skeleton": {"id": "file", "title": "Каркас", "sections": [{"id": "s2", "title": "Техническое задание"}]}},
        )
        sessions.set_stage(session_id, "draft")
        sessions.add_snapshot(
            session_id,
            sessions.new_turn(),
            "section_version",
            {
                "section": {
                    "id": "s2",
                    "title": "Техническое задание",
                    "blocks": [
                        {"kind": "question", "text": "Кто заказчик?"},
                        {"kind": "question", "text": "Какие системы затрагиваются?"},
                    ],
                },
                "marks": [],
            },
        )
        sessions.add_snapshot(
            session_id,
            sessions.new_turn(),
            "author_message",
            {"text": "Кто заказчик? Бухгалтерия\nКакие системы затрагиваются? Сервис учёта баллов", "section_id": "s2"},
        )
        usage = {"prompt_chars": 0, "tokens_in": 0, "tokens_out": 0, "model": "", "slot": "cheap"}
        phase = asyncio.run(
            agent.apply_finish(
                session_id,
                {"action": "rebuild_section", "section_id": "s2", "message": "обновить"},
                sessions.new_turn(),
                usage,
            )
        )
        self.assertEqual(phase, "paused")
        view = self.client.get(f"/api/sessions/{session_id}").json()
        section = next(item for item in view["sections"] if item["id"] == "s2")
        self.assertEqual(section["title"], "Техническое задание")
        self.assertEqual(
            [block["text"] for block in section["blocks"]],
            ["Кто заказчик? Бухгалтерия", "Какие системы затрагиваются? Сервис учёта баллов"],
        )
        note = next(item["payload"]["text"] for item in view["snapshots"] if item["payload"].get("action") == "rebuild_section")
        self.assertIn("Техническое задание", note)

    def test_draft_rebuilds_one_section_and_diff(self):
        async def handler(slot, messages, tools):
            blob = "\n".join(message["content"] for message in messages)
            if tools:
                self.assertEqual(slot, "cheap")
            else:
                self.assertEqual(slot, "strong")
            if tools:
                if "слишком общий" in blob:
                    return LLMResult(
                        text="",
                        tool_calls=[
                            ToolCall(
                                "finish_turn",
                                {
                                    "action": "rebuild_section",
                                    "section_id": "goal",
                                    "message": "Сделать цель конкретнее",
                                },
                                "3",
                            )
                        ],
                        model="fake-strong",
                        slot=slot,
                    )
                if "Собери черновик" in blob:
                    return LLMResult(
                        text="",
                        tool_calls=[
                            ToolCall(
                                "finish_turn",
                                {
                                    "action": "generate_draft",
                                    "message": "Черновик готов",
                                    "reason": "Фича простая, вопросы пропускаю",
                                },
                                "2",
                            )
                        ],
                        model="fake-strong",
                        slot=slot,
                    )
                return LLMResult(
                    text="",
                    tool_calls=[ToolCall("finish_turn", {"action": "ask", "message": "Жду каркас или команду."}, "1")],
                    model="fake-strong",
                    slot=slot,
                )
            if "Пересобери только один раздел" in blob:
                return LLMResult(
                    text=json.dumps(
                        {
                            "section": {
                                "id": "goal",
                                "title": "Цель",
                                "blocks": [{"kind": "question", "text": "Конкретная цель: локальный список контактов"}],
                            }
                        }
                    ),
                    model="fake-strong",
                    slot=slot,
                )
            return LLMResult(
                text=json.dumps(
                    {
                        "sections": [
                            {
                                "id": section_id,
                                "title": title,
                                "blocks": [{"kind": "question", "text": f"Что именно входит в «{title}»?"}],
                            }
                            for section_id, title in (
                                ("goal", "Цель"),
                                ("scope", "Что делаем"),
                                ("acceptance", "Критерии приёмки"),
                            )
                        ]
                    }
                ),
                model="fake-strong",
                slot=slot,
            )

        set_handler(handler)
        profile = self._profile("Черновик")
        created = self.client.post(
            "/api/sessions",
            json={"profile_id": profile["id"], "feature": "Показать список пользователей из телефонной книги"},
        )
        session_id = created.json()["session"]["id"]
        accepted = self.client.post(
            f"/api/sessions/{session_id}/skeleton",
            json={
                "action": "edit",
                "skeleton": {
                    "id": "manual",
                    "title": "Ручной",
                    "sections": [
                        {"id": "goal", "title": "Цель"},
                        {"id": "scope", "title": "Что делаем"},
                        {"id": "acceptance", "title": "Критерии приёмки"},
                    ],
                },
            },
        )
        self.assertEqual(accepted.status_code, 200, accepted.text)
        message = self.client.post(
            f"/api/sessions/{session_id}/messages",
            json={"text": "Собери черновик по локальному списку контактов"},
        )
        self.assertEqual(message.status_code, 200, message.text)
        view = message.json()
        self.assertEqual(view["session"]["stage"], "draft", view)
        self.assertEqual(view["session"]["phase"], "paused", view)
        self.assertEqual(len(view["sections"]), 3)
        self.assertTrue(
            any(
                item["payload"].get("text") == "Фича простая, вопросы пропускаю"
                for item in view["snapshots"]
                if item["kind"] == "decision"
            )
        )
        remarked = self.client.post(
            f"/api/sessions/{session_id}/messages",
            json={"text": "Раздел Цель слишком общий", "section_id": "goal"},
        )
        self.assertEqual(remarked.status_code, 200, remarked.text)
        sections = {item["id"]: item for item in remarked.json()["sections"]}
        self.assertIn("локальный список", sections["goal"]["blocks"][0]["text"])
        self.assertEqual(sections["scope"]["blocks"][0]["text"], "Что именно входит в «Что делаем»?")
        diff = self.client.get(f"/api/sessions/{session_id}/diff")
        self.assertEqual(diff.status_code, 200, diff.text)
        goal_diff = next(item for item in diff.json()["sections"] if item["id"] == "goal")
        self.assertFalse(goal_diff["unchanged"])
        scope_diff = next(item for item in diff.json()["sections"] if item["id"] == "scope")
        self.assertTrue(scope_diff["unchanged"])
        done = self.client.post(f"/api/sessions/{session_id}/done")
        self.assertEqual(done.status_code, 400, done.text)
        self.assertIn("проверка", done.json()["detail"].lower())
        markdown = self.client.get(f"/api/sessions/{session_id}/markdown")
        self.assertIn("локальный список", markdown.text)
        self.assertIn("## Что делаем", markdown.text)

    def test_cancel_restores_previous_turn(self):
        profile = self._profile("Отмена")
        created = self.client.post(
            "/api/sessions",
            json={"profile_id": profile["id"], "feature": "Синхронизация"},
        )
        session_id = created.json()["session"]["id"]
        self.assertTrue(any(item["kind"] == "agent_message" for item in created.json()["snapshots"]))
        cancelled = self.client.post(f"/api/sessions/{session_id}/cancel")
        self.assertEqual(cancelled.status_code, 200, cancelled.text)
        kinds = [item["kind"] for item in cancelled.json()["snapshots"]]
        self.assertNotIn("agent_message", kinds)
        self.assertIn("feature", kinds)

    def test_project_context_and_truncated_digest(self):
        profile = self._profile("Репозиторий")
        created = self.client.post(
            "/api/sessions",
            json={"profile_id": profile["id"], "feature": "Чтение репозитория"},
        )
        session_id = created.json()["session"]["id"]
        empty = tools.get_project_context(session_id)
        self.assertFalse(empty["connected"])
        repo = Path(tempfile.mkdtemp())
        (repo / "README.md").write_text("Сервис спецификаций", encoding="utf-8")
        (repo / "notes.txt").write_text("заметка", encoding="utf-8")
        connected = self.client.post(f"/api/sessions/{session_id}/repo", json={"path": str(repo)})
        self.assertEqual(connected.status_code, 200, connected.text)
        context = tools.get_project_context(session_id)
        self.assertTrue(context["connected"])
        self.assertIn("README.md", context["files"])
        self.assertIn("Сервис спецификаций", context["readme"])
        missing = self.client.post(f"/api/sessions/{session_id}/repo", json={"path": str(repo / "nope")})
        self.assertEqual(missing.status_code, 400)
        tools.suggest_skeleton(session_id, "фича")
        record = tools.short_skeleton()
        from app import session as sessions

        sessions.add_snapshot(session_id, sessions.new_turn(), "skeleton_current", {"skeleton": record})
        digest = asyncio.run(tools.compress_requirements(session_id))
        self.assertTrue(digest["truncated"])
        self.assertIn("Обрезка", digest["note"])

    def test_example_is_searchable_and_doc_without_converter(self):
        profile = self._profile("Пример")
        created = self.client.post(
            "/api/sessions",
            json={"profile_id": profile["id"], "feature": "Печать"},
        )
        session_id = created.json()["session"]["id"]
        uploaded = self.client.post(
            f"/api/sessions/{session_id}/files",
            data={"purpose": "example"},
            files={"file": ("good.md", "# Архитектура\n\nОтдельный сервис\n".encode(), "text/markdown")},
        )
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        found = retrieve.search("архитектура", limit=1)
        self.assertEqual(found[0]["heading"], "Архитектура")
        doc = self.client.post(
            f"/api/sessions/{session_id}/files",
            data={"purpose": "skeleton"},
            files={"file": ("old.doc", b"binary", "application/msword")},
        )
        if shutil.which("soffice") or shutil.which("libreoffice"):
            self.assertIn(doc.status_code, (200, 400))
        else:
            self.assertEqual(doc.status_code, 400, doc.text)
            self.assertIn("docx", doc.json()["detail"].lower())

    def test_confluence_doc_export_is_read_without_converter(self):
        page = "<html><body><h1>Каркас</h1><h2>Цель</h2><p>Показать ставку</p></body></html>".encode()
        raw = b"MIME-Version: 1.0\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n" + page
        profile = self._profile("Экспорт")
        created = self.client.post(
            "/api/sessions",
            json={"profile_id": profile["id"], "feature": "Ставка"},
        )
        session_id = created.json()["session"]["id"]
        uploaded = self.client.post(
            f"/api/sessions/{session_id}/files",
            data={"purpose": "skeleton"},
            files={"file": ("frame.doc", raw, "application/msword")},
        )
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        self.assertTrue(uploaded.json()["files"][0]["extracted"])
        self.assertIn("Цель", uploaded.json()["files"][0]["headings"])

    def test_draft_without_skeleton_proposes_uploaded_file(self):
        profile = self._profile("Файл")
        created = self.client.post(
            "/api/sessions",
            json={"profile_id": profile["id"], "feature": "Ставка"},
        )
        session_id = created.json()["session"]["id"]
        stored = sessions.add_file(session_id, "skeleton", "каркас.doc", "/tmp/каркас.doc")
        sessions.store_extraction(stored["id"], "# Цель\n\nПоказать ставку", ["Цель", "Решение"])
        usage = {"prompt_chars": 0, "tokens_in": 0, "tokens_out": 0, "model": "", "slot": "cheap"}
        phase = asyncio.run(
            agent.apply_finish(
                session_id,
                {"action": "generate_draft", "message": "Собираю черновик"},
                sessions.new_turn(),
                usage,
            )
        )
        self.assertEqual(phase, "paused")
        view = self.client.get(f"/api/sessions/{session_id}")
        self.assertEqual(view.status_code, 200, view.text)
        proposal = view.json()["proposal"]
        self.assertEqual([item["title"] for item in proposal["skeleton"]["sections"]], ["Цель", "Решение"])


    def test_failed_run_is_replaced_with_a_new_agent(self):
        state = {"n": 0}
        calls = []

        def handler(request: httpx.Request) -> httpx.Response:
            path = request.url.path
            calls.append((request.method, path))
            if path == "/v1/agents" and request.method == "POST":
                state["n"] += 1
                agent_id = f"bc-{state['n']}"
                return httpx.Response(
                    201,
                    json={"agent": {"id": agent_id}, "run": {"id": f"run-{state['n']}", "status": "RUNNING"}},
                )
            if path.endswith("/stream"):
                status = "ERROR" if "/bc-1/" in path else "FINISHED"
                payload = json.dumps({"status": status, "text": json.dumps({"text": "ок"})})
                raw = f"event: result\ndata: {payload}\n\n".encode()
                return httpx.Response(200, content=raw)
            if path.endswith("/archive"):
                return httpx.Response(200, json={})
            return httpx.Response(404, json={"path": path})

        set_http_client_factory(lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)))
        os.environ["LLM_STRONG_API_KEY"] = "test-key"
        os.environ["LLM_STRONG_BASE_URL"] = "https://api.cursor.com/v1"
        profile = self._profile("Сбой")
        record = sessions.create_session(profile["id"], "Список")
        with self.assertRaises(RuntimeError):
            asyncio.run(chat("strong", [{"role": "user", "content": "первый"}], session_id=record["id"]))
        self.assertIsNone(sessions.cursor_agent_id(record["id"], "strong"))
        result = asyncio.run(chat("strong", [{"role": "user", "content": "второй"}], session_id=record["id"]))
        self.assertEqual(result.text, "ок")
        self.assertEqual(state["n"], 2)
        self.assertNotIn(("POST", "/v1/agents/bc-1/runs"), calls)

    def test_requirements_are_extracted_on_upload(self):
        profile = self._profile("Требования")
        created = self.client.post(
            "/api/sessions",
            json={"profile_id": profile["id"], "feature": "Импорт требований"},
        )
        session_id = created.json()["session"]["id"]
        uploaded = self.client.post(
            f"/api/sessions/{session_id}/files",
            data={"purpose": "requirements"},
            files={"file": ("req.md", "# Цель\n\nПоказать контакты\n".encode(), "text/markdown")},
        )
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        self.assertTrue(uploaded.json()["files"][0]["extracted"])

    def test_long_requirements_are_compressed_before_draft(self):
        seen = []

        async def handler(slot, messages, tools):
            blob = "\n".join(message["content"] for message in messages)
            seen.append((slot, "Сожми требования" in blob))
            if "Сожми требования" in blob:
                return LLMResult(
                    text=json.dumps({"sections": [{"id": "goal", "title": "Цель", "text": "кратко"}]}),
                    model="cheap-model",
                    slot=slot,
                )
            return LLMResult(
                text=json.dumps(
                    {
                        "sections": [
                            {
                                "id": "goal",
                                "title": "Цель",
                                "blocks": [{"kind": "question", "text": "Что показать?"}],
                            }
                        ]
                    }
                ),
                model="strong-model",
                slot=slot,
            )

        profile = self._profile("Длинное")
        created = self.client.post(
            "/api/sessions",
            json={"profile_id": profile["id"], "feature": "Длинные требования"},
        )
        session_id = created.json()["session"]["id"]
        set_handler(handler)
        stored = sessions.add_file(session_id, "requirements", "req.md", "/tmp/req.md")
        sessions.store_extraction(stored["id"], "нужно показать контакты\n" * 400, ["Цель"])
        sessions.add_snapshot(
            session_id,
            sessions.new_turn(),
            "skeleton_current",
            {"skeleton": tools.short_skeleton()},
        )
        sessions.set_stage(session_id, "approved")
        usage = {"prompt_chars": 0, "tokens_in": 0, "tokens_out": 0, "model": "", "slot": "cheap"}
        phase = asyncio.run(
            agent.apply_finish(
                session_id,
                {"action": "generate_draft", "message": "Черновик готов", "reason": "текст длинный"},
                sessions.new_turn(),
                usage,
            )
        )
        self.assertEqual(phase, "paused")
        self.assertEqual(sessions.get_session(session_id)["stage"], "draft")
        self.assertEqual(seen, [("cheap", True), ("strong", False)])
        self.assertIsNotNone(sessions.current_digest(session_id))


    def test_stop_drops_the_running_turn(self):
        async def handler(slot, messages, tools):
            from app.db import connection

            with connection() as conn:
                row = conn.execute(
                    "SELECT session_id FROM jobs WHERE status = 'pending' ORDER BY id DESC LIMIT 1"
                ).fetchone()
            sessions.request_stop(row["session_id"])
            return LLMResult(
                text="",
                tool_calls=[ToolCall("finish_turn", {"action": "ask", "message": "это не должно остаться"}, "1")],
                model="fake",
                slot=slot,
            )

        set_handler(handler)
        profile = self._profile("Стоп")
        created = self.client.post(
            "/api/sessions",
            json={"profile_id": profile["id"], "feature": "Остановить думание"},
        )
        self.assertEqual(created.status_code, 200, created.text)
        view = created.json()
        self.assertEqual(view["job"]["status"], "cancelled")
        self.assertNotEqual(view["session"]["phase"], "running")
        texts = [item["payload"].get("text") for item in view["snapshots"] if item["kind"] == "agent_message"]
        self.assertIn("Остановил ход. Можно продолжить.", texts)
        self.assertNotIn("это не должно остаться", texts)

    def test_stop_endpoint_cancels_pending_job(self):
        profile = self._profile("Ждёт")
        created = self.client.post(
            "/api/sessions",
            json={"profile_id": profile["id"], "feature": "Пауза"},
        )
        session_id = created.json()["session"]["id"]
        job = sessions.create_job(session_id)
        stopped = self.client.post(f"/api/sessions/{session_id}/stop")
        self.assertEqual(stopped.status_code, 200, stopped.text)
        self.assertEqual(stopped.json()["job"]["status"], "cancelled")
        asyncio.run(agent.run_job(job["id"]))
        view = self.client.get(f"/api/sessions/{session_id}").json()
        self.assertEqual(view["job"]["status"], "cancelled")
        self.assertNotEqual(view["session"]["phase"], "running")
        self.assertTrue(
            any(item["payload"].get("action") == "stopped" for item in view["snapshots"] if item["kind"] == "agent_message")
        )
        again = self.client.post(f"/api/sessions/{session_id}/stop")
        self.assertEqual(again.status_code, 200, again.text)
        stopped_notes = [
            item for item in again.json()["snapshots"] if item["payload"].get("action") == "stopped"
        ]
        self.assertEqual(len(stopped_notes), 1)


    def test_clear_session_keeps_profile_and_saved_example(self):
        profile = self._profile("Меню")
        created = self.client.post(
            "/api/sessions",
            json={"profile_id": profile["id"], "feature": "Стираемое ТЗ", "project": "Черновик"},
        )
        session_id = created.json()["session"]["id"]
        uploaded = self.client.post(
            f"/api/sessions/{session_id}/files",
            data={"purpose": "example"},
            files={"file": ("keep.md", "# Архив\n\nСохранённый пример\n".encode(), "text/markdown")},
        )
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        self.assertEqual(retrieve.search("архив", limit=1)[0]["heading"], "Архив")
        job = sessions.create_job(session_id)
        folder = data_dir() / "files" / session_id
        self.assertTrue(folder.is_dir())
        removed = self.client.delete(f"/api/sessions/{session_id}")
        self.assertEqual(removed.status_code, 200, removed.text)
        self.assertEqual(removed.json()["profile_id"], profile["id"])
        self.assertEqual(self.client.get(f"/api/sessions/{session_id}").status_code, 404)
        saved = self.client.get("/api/profiles").json()["profiles"]
        match = next(item for item in saved if item["id"] == profile["id"])
        self.assertEqual(match["writing_note"], "коротко")
        self.assertEqual(retrieve.search("архив", limit=1)[0]["heading"], "Архив")
        self.assertFalse(folder.exists())
        asyncio.run(agent.run_job(job["id"]))
        self.assertIsNone(sessions.get_session(session_id))
        self.assertEqual(sessions.list_snapshots(session_id), [])
        self.assertEqual(memory.list_dialog(session_id), [])
        self.assertEqual(memory.working_items(session_id), {})
        self.assertTrue(any(item["kind"] == "note" for item in memory.profile_items(profile["id"])))


    def test_dialog_survives_and_stops_at_the_tail(self):
        os.environ["CONTEXT_TAIL"] = "8"
        profile = self._profile("Память")
        created = self.client.post(
            "/api/sessions",
            json={"profile_id": profile["id"], "feature": "Память диалога"},
        )
        session_id = created.json()["session"]["id"]
        for index in range(1, 17):
            memory.remember_dialog(session_id, "user" if index % 2 else "assistant", f"старт-{index:02d}")
        sessions.add_snapshot(
            session_id,
            sessions.new_turn(),
            "author_message",
            {"text": "только диалог"},
        )
        sessions.add_snapshot(
            session_id,
            sessions.new_turn(),
            "decision",
            {"text": "берём короткий каркас"},
        )

        async def handler(slot, messages, tools):
            blob = "\n".join(message["content"] for message in messages)
            self.assertIn("Сожми ранний диалог", blob)
            return LLMResult(
                text=json.dumps({"summary": "сжатый ранний диалог"}),
                model="cheap",
                slot=slot,
            )

        set_handler(handler)
        asyncio.run(memory.refresh_summary(session_id))
        from app.agent import build_messages

        blob = "\n".join(message["content"] for message in build_messages(session_id))
        self.assertIn("сжатый ранний диалог", blob)
        self.assertIn("старт-16", blob)
        self.assertNotIn("старт-01", blob)
        self.assertIn("только диалог", blob)
        kinds = [item["kind"] for item in memory.profile_items(profile["id"])]
        self.assertIn("decision", kinds)
        self.assertNotIn("только диалог", " ".join(item["content"] for item in memory.profile_items(profile["id"]) if item["kind"] != "decision"))
        again = memory.list_dialog(session_id)
        self.assertTrue(any(item["text"] == "старт-16" for item in again))

    def test_turn_counts_stage_history_and_reply_tokens(self):
        async def handler(slot, messages, tools):
            return LLMResult(
                text="",
                tool_calls=[ToolCall("finish_turn", {"action": "ask", "message": "уточните объём"}, "1")],
                model="fake",
                slot=slot,
            )

        set_handler(handler)
        profile = self._profile("Токены")
        created = self.client.post(
            "/api/sessions",
            json={"profile_id": profile["id"], "feature": "Счёт токенов"},
        )
        view = created.json()
        self.assertGreater(view["usage"]["stage"], 0)
        self.assertGreater(view["usage"]["reply"], 0)
        self.assertGreater(view["usage"]["history"], 0)
        self.assertEqual(view["job"]["tokens_in"], view["usage"]["stage"])
        self.assertEqual(view["job"]["tokens_out"], view["usage"]["reply"])
        self.assertEqual(view["job"]["history_tokens"], view["usage"]["history"])

    def test_draft_before_approved_plan_stays_put(self):
        async def handler(slot, messages, tools):
            blob = "\n".join(message["content"] for message in messages)
            if "Собери черновик" in blob:
                return LLMResult(
                    text="",
                    tool_calls=[
                        ToolCall(
                            "finish_turn",
                            {"action": "generate_draft", "message": "Черновик", "reason": "пора"},
                            "2",
                        )
                    ],
                    model="fake",
                    slot=slot,
                )
            return LLMResult(
                text="",
                tool_calls=[
                    ToolCall(
                        "finish_turn",
                        {
                            "action": "propose_skeleton",
                            "skeleton_id": "standard",
                            "message": "для этой фичи лучше подойдёт полный каркас",
                        },
                        "1",
                    )
                ],
                model="fake",
                slot=slot,
            )

        set_handler(handler)
        profile = self._profile("Этапы")
        created = self.client.post(
            "/api/sessions",
            json={"profile_id": profile["id"], "feature": "Список контактов"},
        )
        view = created.json()
        session_id = view["session"]["id"]
        self.assertEqual(view["session"]["stage"], "plan")
        self.assertIsNotNone(view["proposal"])
        paused = self.client.post(
            f"/api/sessions/{session_id}/stop",
        )
        self.assertEqual(paused.status_code, 200, paused.text)
        self.assertEqual(paused.json()["session"]["stage"], "plan")
        continued = self.client.post(
            f"/api/sessions/{session_id}/messages",
            json={"text": "Собери черновик"},
        )
        self.assertEqual(continued.status_code, 200, continued.text)
        body = continued.json()
        self.assertEqual(body["session"]["stage"], "plan")
        self.assertEqual(body["sections"], [])
        self.assertTrue(
            any(item["payload"].get("text") == "Сначала утвердите каркас." for item in body["snapshots"])
        )
        early = self.client.post(f"/api/sessions/{session_id}/done")
        self.assertEqual(early.status_code, 400, early.text)

    def test_done_waits_for_validation(self):
        profile = self._profile("Проверка")
        created = self.client.post(
            "/api/sessions",
            json={"profile_id": profile["id"], "feature": "Печать"},
        )
        session_id = created.json()["session"]["id"]
        sessions.set_stage(session_id, "draft")
        sessions.add_snapshot(
            session_id,
            sessions.new_turn(),
            "section_version",
            {
                "section": {
                    "id": "goal",
                    "title": "Цель",
                    "blocks": [{"kind": "question", "text": "Зачем печать?"}],
                },
                "marks": [],
            },
        )
        blocked = self.client.post(f"/api/sessions/{session_id}/validate")
        self.assertEqual(blocked.status_code, 200, blocked.text)
        self.assertEqual(blocked.json()["session"]["stage"], "draft")
        self.assertTrue(any("Цель" in (item["payload"].get("text") or "") for item in blocked.json()["snapshots"]))
        refused = self.client.post(f"/api/sessions/{session_id}/done")
        self.assertEqual(refused.status_code, 400, refused.text)
        sessions.add_snapshot(
            session_id,
            sessions.new_turn(),
            "section_version",
            {
                "section": {
                    "id": "goal",
                    "title": "Цель",
                    "blocks": [
                        {
                            "kind": "statement",
                            "text": "Печатать локальный список",
                            "sources": [{"type": "answer", "id": "known"}],
                        }
                    ],
                },
                "marks": [],
            },
        )
        checked = self.client.post(f"/api/sessions/{session_id}/validate")
        self.assertEqual(checked.status_code, 200, checked.text)
        self.assertEqual(checked.json()["session"]["stage"], "validated")
        done = self.client.post(f"/api/sessions/{session_id}/done")
        self.assertEqual(done.status_code, 200, done.text)
        self.assertEqual(done.json()["session"]["stage"], "done")


if __name__ == "__main__":
    unittest.main()
