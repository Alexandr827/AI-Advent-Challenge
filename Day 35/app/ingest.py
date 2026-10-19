import html
import re
import shutil
import subprocess
import tempfile
from email import message_from_bytes
from pathlib import Path

AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a", ".ogg", ".webm", ".aac"}
TEXT_EXTENSIONS = {".txt", ".md", ".markdown"}


class IngestError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def extract_file(path: str) -> dict:
    source = Path(path)
    if not source.is_file():
        raise IngestError("Файл не найден")
    suffix = source.suffix.lower()
    if suffix in AUDIO_EXTENSIONS:
        return {
            "needs_transcript": True,
            "text": "",
            "headings": [],
            "message": "Ключа распознавания речи нет. Вставьте транскрипт текстом на этом шаге.",
        }
    if suffix in TEXT_EXTENSIONS:
        text = source.read_text(encoding="utf-8", errors="replace")
        return {"needs_transcript": False, "text": text, "headings": headings_from_markdown(text)}
    if suffix == ".pdf":
        text = _pdf_text(source)
        return {"needs_transcript": False, "text": text, "headings": headings_from_plain(text)}
    if suffix == ".docx":
        text, headings = _docx_text(source)
        return {"needs_transcript": False, "text": text, "headings": headings}
    if suffix == ".doc":
        exported = _html_export_text(source)
        if exported is not None:
            text, headings = exported
            if not text:
                raise IngestError("Из doc не удалось извлечь текст")
            return {"needs_transcript": False, "text": text, "headings": headings}
        converted = _doc_to_docx(source)
        text, headings = _docx_text(converted)
        return {"needs_transcript": False, "text": text, "headings": headings}
    raise IngestError("Поддерживаются pdf, docx, doc, txt и md. Для записи звонка вставьте транскрипт.")


def headings_from_markdown(text: str) -> list[str]:
    headings = []
    for line in text.splitlines():
        match = re.match(r"^#{1,3}\s+(.+?)\s*$", line)
        if match:
            headings.append(match.group(1).strip())
    return headings


def headings_from_plain(text: str) -> list[str]:
    headings = headings_from_markdown(text)
    if headings:
        return headings
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or len(stripped) > 80 or stripped.endswith((".", ";", ",")):
            continue
        if stripped.isupper() or re.match(r"^\d+[\.\)]\s+\S+", stripped):
            headings.append(stripped)
    return headings[:12]


def chunk_by_headings(text: str) -> list[dict]:
    chunks: list[dict] = []
    heading = None
    lines: list[str] = []

    def flush() -> None:
        nonlocal heading, lines
        if heading is None:
            return
        chunks.append({"heading": heading, "body": "\n".join(lines).strip()})
        lines = []

    for line in text.splitlines():
        match = re.match(r"^#{1,3}\s+(.+?)\s*$", line.strip())
        if match:
            flush()
            heading = match.group(1).strip()
            continue
        if heading is None:
            continue
        lines.append(line)
    flush()
    if chunks:
        return chunks
    body = text.strip()
    if not body:
        return []
    return [{"heading": body.splitlines()[0][:80], "body": body}]


def _pdf_text(path: Path) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise IngestError("Чтение pdf недоступно") from exc
    reader = PdfReader(str(path))
    parts = []
    for page in reader.pages:
        parts.append(page.extract_text() or "")
    text = "\n".join(parts).strip()
    if not text:
        raise IngestError("Из pdf не удалось извлечь текст")
    return text


def _docx_text(path: Path) -> tuple[str, list[str]]:
    try:
        import docx
    except ImportError as exc:
        raise IngestError("Чтение docx недоступно") from exc
    document = docx.Document(str(path))
    lines = []
    headings = []
    for paragraph in document.paragraphs:
        style = paragraph.style.name if paragraph.style is not None else ""
        text = paragraph.text.strip()
        if not text:
            lines.append("")
            continue
        if style.startswith("Heading"):
            headings.append(text)
            level = 1
            suffix = style.replace("Heading", "").strip()
            if suffix.isdigit():
                level = min(int(suffix), 3)
            lines.append(f"{'#' * level} {text}")
        else:
            lines.append(text)
    return "\n".join(lines).strip(), headings


def _html_export_text(path: Path) -> tuple[str, list[str]] | None:
    raw = path.read_bytes()
    sample = raw.lstrip()[:800].lower()
    if sample.startswith(b"\xd0\xcf\x11\xe0"):
        return None
    if not (
        sample.startswith((b"date:", b"mime-version:", b"content-type:", b"<html", b"<!doctype html"))
        or b"<html" in sample
    ):
        return None
    if sample.startswith((b"<html", b"<!doctype html")):
        page = raw.decode("utf-8", "replace")
    else:
        message = message_from_bytes(raw)
        page = _html_part(message)
        if page is None:
            return None
    return _html_to_text(page)


def _html_part(message) -> str | None:
    parts = message.walk() if message.is_multipart() else [message]
    for part in parts:
        if part.get_content_type() != "text/html":
            continue
        payload = part.get_payload(decode=True)
        if not payload:
            continue
        charset = part.get_content_charset() or "utf-8"
        return payload.decode(charset, "replace")
    return None


def _html_to_text(page: str) -> tuple[str, list[str]]:
    headings: list[str] = []

    def heading(match: re.Match) -> str:
        level = min(int(match.group(1)), 3)
        inner = _plain_fragment(match.group(2))
        if not inner:
            return "\n"
        headings.append(inner)
        return f"\n{'#' * level} {inner}\n"

    text = re.sub(r"<h([1-6])[^>]*>(.*?)</h\1>", heading, page, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", text, flags=re.IGNORECASE | re.DOTALL)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</(p|div|tr|li|h[1-6])>", "\n", text, flags=re.IGNORECASE)
    text = _plain_fragment(text)
    lines = [line.strip() for line in text.splitlines()]
    return "\n".join(line for line in lines if line), headings


def _plain_fragment(value: str) -> str:
    text = re.sub(r"<[^>]+>", " ", value)
    text = html.unescape(text).replace("\xa0", " ")
    return re.sub(r"[ \t]+", " ", text).strip()


def _doc_to_docx(path: Path) -> Path:
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        raise IngestError("Конвертер doc не установлен. Сохраните файл как docx.")
    with tempfile.TemporaryDirectory() as tmp:
        result = subprocess.run(
            [soffice, "--headless", "--convert-to", "docx", "--outdir", tmp, str(path)],
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
        produced = Path(tmp) / f"{path.stem}.docx"
        if result.returncode != 0 or not produced.is_file():
            raise IngestError("Не удалось конвертировать doc. Сохраните файл как docx.")
        target = path.with_suffix(".converted.docx")
        target.write_bytes(produced.read_bytes())
        return target
