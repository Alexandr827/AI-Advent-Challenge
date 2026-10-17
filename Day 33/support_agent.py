import json
import os
import sys
from pathlib import Path

from sklearn.feature_extraction.text import TfidfVectorizer


def _load_dotenv() -> None:
    env_path = Path(__file__).resolve().parent / ".env"
    if not env_path.is_file():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_dotenv()
from sklearn.metrics.pairwise import cosine_similarity

with open("faq.json", "r", encoding="utf-8") as f:
    faq_data = json.load(f)

vectorizer = TfidfVectorizer()
faq_texts = [item["topic"] + " " + " ".join(item["keywords"]) for item in faq_data]
tfidf_matrix = vectorizer.fit_transform(faq_texts)


def search_rag(query: str) -> str:
    """Ищет наиболее релевантный ответ в FAQ."""
    query_vec = vectorizer.transform([query])
    similarities = cosine_similarity(query_vec, tfidf_matrix).flatten()
    best_match_idx = similarities.argmax()

    if similarities[best_match_idx] > 0.1:
        return faq_data[best_match_idx]["answer"]
    return "Информация в базе знаний не найдена."


with open("crm_data.json", "r", encoding="utf-8") as f:
    crm_data = json.load(f)


def call_mcp_get_ticket(ticket_id):
    return crm_data["tickets"].get(ticket_id, {})


def call_mcp_get_user(user_id):
    return crm_data["users"].get(user_id, {})


def _cursor_api_key() -> str | None:
    return os.getenv("CURSOR_API_KEY") or os.getenv("cursor_api_key")


def process_support_request(user_message: str, ticket_id: str | None = None):
    print(f"\n👤 Запрос пользователя: {user_message}")

    crm_context = "Нет данных тикета."
    if ticket_id:
        ticket = call_mcp_get_ticket(ticket_id)
        if ticket:
            user = call_mcp_get_user(ticket.get("user_id"))
            crm_context = (
                f"Данные тикета: {json.dumps(ticket, ensure_ascii=False)}\n"
                f"Данные пользователя: {json.dumps(user, ensure_ascii=False)}"
            )
        print(f"🔍 [MCP] Загружен контекст CRM для тикета {ticket_id}")

    rag_context = search_rag(user_message)
    print(f"📚 [RAG] Найден ответ в FAQ: {rag_context[:50]}...")

    system_prompt = """
    Ты — вежливый и профессиональный ассистент поддержки пользователей.
    Твоя задача — ответить на вопрос пользователя, ОБЯЗАТЕЛЬНО используя:
    1. Контекст тикета и данные пользователя (из CRM).
    2. Информацию из базы знаний (FAQ).

    Если в тикете указана специфическая проблема, адаптируй ответ из FAQ под неё.
    Обращайся к пользователю по имени, если оно известно.

    Верни только текст ответа пользователю. Не изменяй файлы в проекте и не вызывай инструменты.
    """

    final_prompt = f"""
    {system_prompt}

    КОНТЕКСТ CRM:
    {crm_context}

    БАЗА ЗНАНИЙ (FAQ):
    {rag_context}

    СООБЩЕНИЕ ПОЛЬЗОВАТЕЛЯ:
    {user_message}

    Сформируй грамотный ответ.
    """

    api_key = _cursor_api_key()
    if not api_key:
        print("\n⚠️ CURSOR_API_KEY (или cursor_api_key) не задан. Собранный контекст:\n")
        print(final_prompt)
        print("-" * 50)
        sys.exit(1)

    from cursor_sdk import Agent, AgentOptions, LocalAgentOptions

    result = Agent.prompt(
        final_prompt,
        AgentOptions(
            api_key=api_key,
            model=os.getenv("CURSOR_MODEL", "composer-2.5"),
            local=LocalAgentOptions(cwd=os.getcwd()),
        ),
    )

    answer = result.result or ""
    print(f"🤖 Ответ ассистента:\n{answer}\n" + "-" * 50)
    return answer


if __name__ == "__main__":
    process_support_request(
        user_message="Почему не работает авторизация? Я уже 5 раз вводил пароль!",
        ticket_id="T-1042",
    )
