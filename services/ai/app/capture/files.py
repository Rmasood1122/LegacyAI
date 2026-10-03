"""Upload checks and safe text extraction (feature 25; docs/phase2/05 §2).

The declared type is not trusted: the first bytes are sniffed (puremagic + our own strict
rules) and must agree. PDFs are parsed in a separate child process with a wall-clock timeout
and a memory ceiling, so a decompression bomb or a parser loop kills the child, not the service.
Only text is extracted. A PDF that yields almost no text is refused as a likely scan.
"""

from __future__ import annotations

import io
import multiprocessing as mp
import sys
import unicodedata
from dataclasses import dataclass

import puremagic

ALLOWED = {"application/pdf", "text/plain", "text/markdown"}
PARSE_TIMEOUT_SECONDS = 20
MEMORY_LIMIT_BYTES = 512 * 1024 * 1024
MAX_CHARS = 400_000
MIN_CHARS_PER_PAGE = 20


class UploadRejected(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Extracted:
    text: str
    pages: list[tuple[int, str]]   # (page number from 1, text) ; one page for plain text
    page_count: int


def sniff(data: bytes, declared: str) -> str:
    if declared not in ALLOWED:
        raise UploadRejected("unsupported_type")
    if declared == "application/pdf":
        if not data.startswith(b"%PDF-"):
            raise UploadRejected("type_mismatch")
        try:
            kinds = {m.mime_type for m in puremagic.magic_string(data[:4096])}
        except puremagic.PureError as exc:
            raise UploadRejected("type_mismatch") from exc
        if "application/pdf" not in kinds:
            raise UploadRejected("type_mismatch")
        return declared
    # text: valid UTF-8, no NUL bytes, few control characters, and not secretly something else
    if b"\x00" in data:
        raise UploadRejected("type_mismatch")
    if data[:5] == b"%PDF-" or data[:2] == b"PK" or data[:4] == b"\x7fELF" or data[:2] == b"MZ":
        raise UploadRejected("type_mismatch")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise UploadRejected("not_utf8") from exc
    stripped = text.lstrip().lower()
    if stripped.startswith(("<!doctype html", "<html", "<script", "<?xml")):
        raise UploadRejected("type_mismatch")
    control = sum(1 for ch in text if unicodedata.category(ch) == "Cc" and ch not in "\n\r\t\f")
    if text and control / len(text) > 0.01:
        raise UploadRejected("type_mismatch")
    return declared


def _limit_memory() -> None:
    if sys.platform != "win32":
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_LIMIT_BYTES, MEMORY_LIMIT_BYTES))


def _parse_pdf_child(data: bytes, max_pages: int, conn: object) -> None:
    """Runs in the child process. Sends ('ok', pages) or ('error', code)."""
    try:
        _limit_memory()
        import pypdf
        from pypdf import PdfReader
        from pypdf.errors import PdfReadError

        pypdf.filters.ZLIB_MAX_OUTPUT_LENGTH = 20_000_000  # lower than the default
        reader = PdfReader(io.BytesIO(data), strict=False)
        if reader.is_encrypted:
            conn.send(("error", "encrypted_pdf"))  # type: ignore[attr-defined]
            return
        if len(reader.pages) > max_pages:
            conn.send(("error", "too_many_pages"))  # type: ignore[attr-defined]
            return
        pages: list[tuple[int, str]] = []
        total = 0
        for i, page in enumerate(reader.pages, start=1):
            text = page.extract_text() or ""
            total += len(text)
            if total > MAX_CHARS:
                conn.send(("error", "too_much_text"))  # type: ignore[attr-defined]
                return
            pages.append((i, text))
        conn.send(("ok", pages))  # type: ignore[attr-defined]
    except MemoryError:
        conn.send(("error", "too_complex"))  # type: ignore[attr-defined]
    except (PdfReadError, ValueError, KeyError, TypeError, RecursionError, OSError):
        conn.send(("error", "unreadable_pdf"))  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001 - any other parser failure is a refusal, never a crash
        conn.send(("error", "unreadable_pdf"))  # type: ignore[attr-defined]


def _normalise(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    # zero-width and other invisible characters used to hide or split words
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Cf")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return text


def extract(data: bytes, mime: str, max_pages: int) -> Extracted:
    if mime in ("text/plain", "text/markdown"):
        text = _normalise(data.decode("utf-8"))
        if len(text) > MAX_CHARS:
            raise UploadRejected("too_much_text")
        if not text.strip():
            raise UploadRejected("empty")
        return Extracted(text=text, pages=[(1, text)], page_count=1)

    ctx = mp.get_context("spawn")
    parent, child = ctx.Pipe(duplex=False)
    proc = ctx.Process(target=_parse_pdf_child, args=(data, max_pages, child), daemon=True)
    proc.start()
    child.close()
    try:
        if not parent.poll(PARSE_TIMEOUT_SECONDS):
            raise UploadRejected("too_complex")
        status, payload = parent.recv()
    except EOFError as exc:  # the child died (memory ceiling, crash)
        raise UploadRejected("too_complex") from exc
    finally:
        if proc.is_alive():
            proc.kill()
        proc.join(timeout=5)
        parent.close()
    if status != "ok":
        raise UploadRejected(str(payload))
    pages = [(n, _normalise(t)) for n, t in payload]
    text = "\n\n".join(t for _, t in pages)
    if len(text.strip()) < MIN_CHARS_PER_PAGE * max(1, len(pages)) / 2:
        raise UploadRejected("looks_like_scan")
    return Extracted(text=text, pages=pages, page_count=len(pages))
