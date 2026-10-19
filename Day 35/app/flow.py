from app import session

STAGES = ("brief", "plan", "approved", "draft", "validated", "done")

ALLOWED = {
    "brief": {"plan", "approved"},
    "plan": {"plan", "approved"},
    "approved": {"approved", "draft"},
    "draft": {"draft", "validated"},
    "validated": {"draft", "done"},
    "done": set(),
}

DRAFT_BLOCKED = "Сначала утвердите каркас."
DONE_BLOCKED = "Сначала нужна проверка черновика."


class IllegalTransition(Exception):
    def __init__(self, current: str, target: str):
        self.current = current
        self.target = target
        super().__init__(f"{current} -> {target}")


def stage_of(session_id: str) -> str:
    record = session.get_session(session_id)
    stage = (record or {}).get("stage") or "brief"
    if stage not in STAGES:
        return "brief"
    return stage


def can(current: str, target: str) -> bool:
    return target in ALLOWED.get(current, set())


def transition(session_id: str, target: str) -> str:
    current = stage_of(session_id)
    if not can(current, target):
        raise IllegalTransition(current, target)
    if current != target:
        session.set_stage(session_id, target)
    return target


def validation_problems(session_id: str) -> list[str]:
    titles = []
    for item in session.latest_section_notes(session_id):
        section = item["section"]
        blocks = section.get("blocks") or []
        questions = any(isinstance(block, dict) and block.get("kind") == "question" for block in blocks)
        marks = item.get("marks") or []
        if questions or marks:
            titles.append(section.get("title") or section.get("id") or "раздел")
    return titles
