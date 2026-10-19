import asyncio
import contextvars
import json
import os
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from app import session


def _load_dotenv() -> None:
    path = Path(__file__).resolve().parents[1] / ".env"
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        if key and key not in os.environ:
            os.environ[key] = value.strip().strip('"').strip("'")


_load_dotenv()


class NeedsKey(Exception):
    def __init__(self, slot: str):
        super().__init__(slot)
        self.slot = slot


class Stopped(Exception):
    pass


_current_job: contextvars.ContextVar[int | None] = contextvars.ContextVar("spec_job", default=None)
_live_runs: dict[int, dict] = {}


@dataclass
class ToolCall:
    name: str
    arguments: dict
    call_id: str = ""


@dataclass
class LLMResult:
    text: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    model: str = ""
    slot: str = ""
    prompt_chars: int = 0
    tokens_in: int = 0
    tokens_out: int = 0


_handler = None
_client_factory = None
_TERMINAL_RUNS = {"FINISHED", "ERROR", "CANCELLED", "EXPIRED"}


def set_handler(handler) -> None:
    global _handler
    _handler = handler


def set_http_client_factory(factory) -> None:
    global _client_factory
    _client_factory = factory


def bind_job(job_id: int):
    return _current_job.set(job_id)


def unbind_job(token) -> None:
    _current_job.reset(token)


def _job_id() -> int | None:
    return _current_job.get()


def _raise_if_stopped() -> None:
    job_id = _job_id()
    if job_id is not None and session.job_is_cancelled(job_id):
        raise Stopped()


def configured(slot: str) -> bool:
    if _handler is not None:
        return True
    return bool(_api_key(slot))


def _api_key(slot: str) -> str:
    if slot == "cheap":
        return os.environ.get("LLM_CHEAP_API_KEY", "").strip()
    return os.environ.get("LLM_STRONG_API_KEY", "").strip()


def _base_url(slot: str) -> str:
    if slot == "cheap":
        return os.environ.get("LLM_CHEAP_BASE_URL", "https://api.cursor.com/v1").rstrip("/")
    return os.environ.get("LLM_STRONG_BASE_URL", "https://api.cursor.com/v1").rstrip("/")


def _model(slot: str) -> str:
    if slot == "cheap":
        return os.environ.get("LLM_CHEAP_MODEL", "composer-2.5")
    return os.environ.get("LLM_STRONG_MODEL", "grok-4.7")


def _prompt_chars(messages: list[dict], tools: list[dict] | None) -> int:
    raw = json.dumps({"messages": messages, "tools": tools or []}, ensure_ascii=False)
    return len(raw)


def _is_cursor(slot: str) -> bool:
    return "api.cursor.com" in _base_url(slot)


def _messages_to_prompt(messages: list[dict], tools: list[dict] | None) -> str:
    lines = [
        "Ответь только на этот запрос. Не пользуйся встроенными инструментами, не меняй файлы и не ищи в сети."
    ]
    if tools:
        lines.append(
            'Верни один JSON-объект и ничего больше: '
            '{"tool_calls": [{"name": "имя", "arguments": {}}]} '
            'или {"text": "сообщение"}, если инструмент не нужен.'
        )
        lines.append("Инструменты:")
        lines.append(json.dumps(tools, ensure_ascii=False))
    else:
        lines.append("Верни только тот JSON, которого просит переписка, без markdown.")
    lines.append("Переписка:")
    for message in messages:
        lines.append(f"{message.get('role', 'user')}: {message.get('content') or ''}")
    return "\n".join(lines)


def parse_model_reply(text: str) -> tuple[str, list[ToolCall]]:
    try:
        data = parse_json(text)
    except (ValueError, json.JSONDecodeError):
        return text.strip(), []
    raw_calls = data.get("tool_calls") if isinstance(data, dict) else None
    calls: list[ToolCall] = []
    if isinstance(raw_calls, list):
        for index, call in enumerate(raw_calls):
            if not isinstance(call, dict) or not call.get("name"):
                continue
            arguments = call.get("arguments") or {}
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments)
                except json.JSONDecodeError:
                    arguments = {}
            if not isinstance(arguments, dict):
                arguments = {}
            calls.append(ToolCall(name=str(call["name"]), arguments=arguments, call_id=f"call-{index}"))
    if calls:
        return "", calls
    if isinstance(data, dict) and isinstance(data.get("text"), str) and set(data) <= {"text", "tool_calls"}:
        return data["text"].strip(), []
    return text.strip(), []


def _timeout_seconds() -> float:
    return float(os.environ.get("LLM_TIMEOUT_SECONDS", "180"))


def _http_client() -> httpx.AsyncClient:
    if _client_factory is not None:
        return _client_factory()
    seconds = _timeout_seconds()
    return httpx.AsyncClient(timeout=httpx.Timeout(seconds, connect=30.0))


def _headers(slot: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {_api_key(slot)}"}


async def _retire_agent(client: httpx.AsyncClient, slot: str, session_id: str | None, agent_id: str) -> None:
    if session_id:
        session.clear_cursor_agent(session_id, slot)
    try:
        await client.post(f"{_base_url(slot)}/agents/{agent_id}/archive", headers=_headers(slot))
    except httpx.HTTPError:
        pass


async def _begin_run(
    client: httpx.AsyncClient,
    slot: str,
    session_id: str | None,
    prompt: str,
) -> tuple[str, str]:
    base = _base_url(slot)
    headers = _headers(slot)
    agent_id = session.cursor_agent_id(session_id, slot) if session_id else None
    if agent_id:
        response = await client.post(
            f"{base}/agents/{agent_id}/runs",
            headers=headers,
            json={"prompt": {"text": prompt}, "mode": "agent"},
        )
        if response.status_code in {404, 410}:
            await _retire_agent(client, slot, session_id, agent_id)
            agent_id = None
        else:
            response.raise_for_status()
            return agent_id, response.json()["run"]["id"]
    created = await client.post(
        f"{base}/agents",
        headers=headers,
        json={
            "name": "spec-turn",
            "mode": "agent",
            "model": {"id": _model(slot)},
            "prompt": {"text": prompt},
        },
    )
    created.raise_for_status()
    payload = created.json()
    agent_id = payload["agent"]["id"]
    if session_id:
        session.set_cursor_agent(session_id, slot, agent_id)
    return agent_id, payload["run"]["id"]


def _consume_sse_event(name: str, data: str) -> str | None:
    if name == "result":
        payload = json.loads(data or "{}")
        status = str(payload.get("status") or "").upper()
        if status != "FINISHED":
            detail = payload.get("text") or status or "ошибка"
            raise RuntimeError(f"Модель остановилась: {detail}")
        return payload.get("text") or ""
    if name == "error":
        payload = json.loads(data or "{}")
        raise RuntimeError(payload.get("message") or "Поток модели оборвался")
    return None


async def _wait_stop(stop: asyncio.Event, timeout: float) -> bool:
    try:
        await asyncio.wait_for(stop.wait(), timeout)
    except TimeoutError:
        return False
    return True


async def _next_stream_line(iterator, stop: asyncio.Event):
    pending = asyncio.ensure_future(iterator.__anext__())
    try:
        while True:
            _raise_if_stopped()
            if stop.is_set():
                raise Stopped()
            done, _ = await asyncio.wait({pending}, timeout=0.4)
            if pending in done:
                return pending.result()
    finally:
        if not pending.done():
            pending.cancel()
            try:
                await pending
            except (asyncio.CancelledError, StopAsyncIteration, Exception):
                pass


async def _fetch_result(
    client: httpx.AsyncClient,
    slot: str,
    agent_id: str,
    run_id: str,
    stop: asyncio.Event,
) -> str:
    deadline = time.monotonic() + _timeout_seconds()
    base = _base_url(slot)
    headers = _headers(slot)
    while True:
        _raise_if_stopped()
        if stop.is_set():
            raise Stopped()
        run_response = await client.get(f"{base}/agents/{agent_id}/runs/{run_id}", headers=headers)
        run_response.raise_for_status()
        run = run_response.json()
        status = str(run.get("status") or "").upper()
        if status in _TERMINAL_RUNS:
            if status != "FINISHED":
                detail = run.get("result") or status
                raise RuntimeError(f"Модель остановилась: {detail}")
            return run.get("result") or ""
        if time.monotonic() > deadline:
            raise TimeoutError("Модель не ответила вовремя")
        if await _wait_stop(stop, 1.5):
            raise Stopped()


async def _stream_result(
    client: httpx.AsyncClient,
    slot: str,
    agent_id: str,
    run_id: str,
    stop: asyncio.Event,
) -> str:
    deadline = time.monotonic() + _timeout_seconds()
    url = f"{_base_url(slot)}/agents/{agent_id}/runs/{run_id}/stream"
    headers = {**_headers(slot), "Accept": "text/event-stream"}
    async with client.stream("GET", url, headers=headers) as response:
        if response.status_code == 410:
            return await _fetch_result(client, slot, agent_id, run_id, stop)
        response.raise_for_status()
        event_name = "message"
        data_lines: list[str] = []
        lines = response.aiter_lines()
        while True:
            if time.monotonic() > deadline:
                raise TimeoutError("Модель не ответила вовремя")
            try:
                line = await _next_stream_line(lines, stop)
            except StopAsyncIteration:
                break
            if line.startswith(":"):
                continue
            if line.startswith("event:"):
                event_name = line.split(":", 1)[1].strip() or "message"
                continue
            if line.startswith("data:"):
                data_lines.append(line.split(":", 1)[1].lstrip())
                continue
            if line.startswith("id:") or line.startswith("retry:"):
                continue
            if line != "":
                continue
            if not data_lines:
                event_name = "message"
                continue
            found = _consume_sse_event(event_name, "\n".join(data_lines))
            event_name = "message"
            data_lines = []
            if found is not None:
                return found
        if data_lines:
            found = _consume_sse_event(event_name, "\n".join(data_lines))
            if found is not None:
                return found
    return await _fetch_result(client, slot, agent_id, run_id, stop)


async def _cursor_chat(
    slot: str,
    messages: list[dict],
    tools: list[dict] | None,
    prompt_chars: int,
    session_id: str | None,
) -> LLMResult:
    prompt = _messages_to_prompt(messages, tools)
    stop = asyncio.Event()
    job_id = _job_id()
    async with _http_client() as client:
        agent_id, run_id = await _begin_run(client, slot, session_id, prompt)
        if job_id is not None:
            _live_runs[job_id] = {
                "slot": slot,
                "agent_id": agent_id,
                "run_id": run_id,
                "stop": stop,
            }
        try:
            _raise_if_stopped()
            text = await _stream_result(client, slot, agent_id, run_id, stop)
        except Stopped:
            raise
        except Exception:
            await _retire_agent(client, slot, session_id, agent_id)
            raise
        finally:
            if job_id is not None and _live_runs.get(job_id, {}).get("run_id") == run_id:
                _live_runs.pop(job_id, None)
        if session_id is None:
            await _retire_agent(client, slot, None, agent_id)
        reply, calls = parse_model_reply(text)
        return LLMResult(
            text=reply,
            tool_calls=calls,
            model=_model(slot),
            slot=slot,
            prompt_chars=prompt_chars,
            tokens_in=0,
            tokens_out=0,
        )


async def cancel_session(session_id: str) -> None:
    job = session.latest_job(session_id)
    if job is None:
        return
    live = _live_runs.get(job["id"])
    if live:
        live["stop"].set()
    if live is None or _handler is not None or not _api_key(live["slot"]):
        return
    try:
        async with _http_client() as client:
            await client.post(
                f"{_base_url(live['slot'])}/agents/{live['agent_id']}/runs/{live['run_id']}/cancel",
                headers=_headers(live["slot"]),
            )
    except httpx.HTTPError:
        pass


async def archive_session(session_id: str) -> None:
    mapping = session.cursor_agents(session_id)
    session.clear_cursor_agents(session_id)
    if _handler is not None or not mapping:
        return
    async with _http_client() as client:
        for slot, agent_id in mapping.items():
            if not agent_id or not _api_key(slot):
                continue
            await _retire_agent(client, slot, None, agent_id)


async def _openai_chat(slot: str, messages: list[dict], tools: list[dict] | None, prompt_chars: int) -> LLMResult:
    payload: dict = {
        "model": _model(slot),
        "messages": messages,
        "temperature": 0.2,
    }
    if tools:
        payload["tools"] = [{"type": "function", "function": tool} for tool in tools]
        payload["tool_choice"] = "auto"
    async with _http_client() as client:
        response = await client.post(
            f"{_base_url(slot)}/chat/completions",
            headers={"Authorization": f"Bearer {_api_key(slot)}"},
            json=payload,
        )
        response.raise_for_status()
        data = response.json()
    choice = data["choices"][0]["message"]
    usage = data.get("usage") or {}
    calls = []
    for call in choice.get("tool_calls") or []:
        function = call.get("function") or {}
        raw_args = function.get("arguments") or "{}"
        try:
            arguments = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
        except json.JSONDecodeError:
            arguments = {}
        calls.append(
            ToolCall(
                name=function.get("name") or "",
                arguments=arguments if isinstance(arguments, dict) else {},
                call_id=call.get("id") or "",
            )
        )
    return LLMResult(
        text=(choice.get("content") or "").strip(),
        tool_calls=calls,
        model=data.get("model") or _model(slot),
        slot=slot,
        prompt_chars=prompt_chars,
        tokens_in=int(usage.get("prompt_tokens") or 0),
        tokens_out=int(usage.get("completion_tokens") or 0),
    )


async def chat(
    slot: str,
    messages: list[dict],
    tools: list[dict] | None = None,
    session_id: str | None = None,
) -> LLMResult:
    prompt_chars = _prompt_chars(messages, tools)
    _raise_if_stopped()
    if _handler is not None:
        result = await _handler(slot=slot, messages=messages, tools=tools)
        result.prompt_chars = result.prompt_chars or prompt_chars
        result.slot = slot
    elif not configured(slot):
        raise NeedsKey(slot)
    elif _is_cursor(slot):
        result = await _cursor_chat(slot, messages, tools, prompt_chars, session_id)
    else:
        result = await _openai_chat(slot, messages, tools, prompt_chars)
    _fill_token_counts(result, messages, tools)
    _raise_if_stopped()
    return result


def _reply_body(result: LLMResult) -> str:
    if result.tool_calls:
        return json.dumps(
            [{"name": call.name, "arguments": call.arguments} for call in result.tool_calls],
            ensure_ascii=False,
        )
    return result.text or ""


def _fill_token_counts(result: LLMResult, messages: list[dict], tools: list[dict] | None) -> None:
    from app import memory

    if result.tokens_in <= 0:
        result.tokens_in = memory.estimate_tokens(
            json.dumps({"messages": messages, "tools": tools or []}, ensure_ascii=False)
        )
    if result.tokens_out <= 0:
        result.tokens_out = memory.estimate_tokens(_reply_body(result))


def parse_json(text: str) -> dict:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[-1]
        if cleaned.endswith("```"):
            cleaned = cleaned[: cleaned.rfind("```")]
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start >= 0 and end > start:
        cleaned = cleaned[start : end + 1]
    data = json.loads(cleaned)
    if not isinstance(data, dict):
        raise ValueError("Ответ модели не объект JSON")
    return data
