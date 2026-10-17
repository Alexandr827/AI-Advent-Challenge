from mcp.server.fastmcp import FastMCP
import json

mcp = FastMCP("SupportCRM")

with open("crm_data.json", "r", encoding="utf-8") as f:
    crm_data = json.load(f)


@mcp.tool()
def get_ticket_info(ticket_id: str) -> str:
    """Получить информацию о тикете поддержки по его ID."""
    ticket = crm_data["tickets"].get(ticket_id)
    if not ticket:
        return f"Тикет {ticket_id} не найден."
    return json.dumps(ticket, ensure_ascii=False)


@mcp.tool()
def get_user_info(user_id: str) -> str:
    """Получить информацию о пользователе по его ID."""
    user = crm_data["users"].get(user_id)
    if not user:
        return f"Пользователь {user_id} не найден."
    return json.dumps(user, ensure_ascii=False)


if __name__ == "__main__":
    mcp.run()
