"""Scanned PDFs (feature 25; docs/phase4/09-batch-c-prepared.md, section 7 and 25).

A PDF whose pages carry (almost) no text is most likely pictures of pages. Without a reader of pictures it is refused
as before (looks_like_scan). With one (the MediaReader of media.py), each page without text is drawn as a grey picture
and read like a photo of a page; pages that do have text keep it, and every page keeps its own number.

Drawing a page means running a PDF renderer (PDFium, through pypdfium2) on a file someone uploaded. As for reading the
text (files.py), it runs in a separate child process with a time limit and a memory ceiling, so a malicious file kills
the child, not the service. The pictures are encoded as PNG here, with zlib: no image library (pillow) touches them.
"""

from __future__ import annotations

import multiprocessing as mp
import struct
import zlib

from app.capture.files import (
    MAX_CHARS,
    MIN_CHARS_PER_PAGE,
    PARSE_TIMEOUT_SECONDS,
    Extracted,
    UploadRejected,
    _limit_memory,
    _normalise,
    as_extracted,
    looks_like_scan,
    parse_pdf,
)
from app.capture.media import MediaReader

DPI = 150                      # enough for text recognition; a page of A4 is 1240 x 1754 pixels
MAX_SIDE_PIXELS = 2600         # a page drawn larger than this is scaled down (a poster-sized page stays affordable)
MAX_PICTURE_BYTES = 40_000_000  # all pages together; more is refused as too_complex
RENDER_TIMEOUT_SECONDS = PARSE_TIMEOUT_SECONDS * 3


def png_gray(width: int, height: int, stride: int, pixels: bytes) -> bytes:
    """An 8-bit grey PNG of the given rows (each row `stride` bytes, of which the first `width` are pixels)."""
    def chunk(kind: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)
    rows = b"".join(b"\x00" + pixels[y * stride:y * stride + width] for y in range(height))
    header = struct.pack(">IIBBBBB", width, height, 8, 0, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows, 6)) + chunk(b"IEND", b"")


def _render_child(data: bytes, page_numbers: list[int], conn: object) -> None:
    """Runs in the child process. Sends ('ok', [(page, png)]) or ('error', code)."""
    try:
        _limit_memory()
        import pypdfium2

        doc = pypdfium2.PdfDocument(data)
        out: list[tuple[int, bytes]] = []
        total = 0
        for number in page_numbers:
            page = doc[number - 1]
            width, height = page.get_size()
            scale = min(DPI / 72, MAX_SIDE_PIXELS / max(width, height, 1))
            bitmap = page.render(scale=scale, grayscale=True)
            if bitmap.n_channels != 1:   # a grey bitmap is one byte per pixel; anything else is not what was asked for
                conn.send(("error", "unreadable_pdf"))  # type: ignore[attr-defined]
                return
            picture = png_gray(bitmap.width, bitmap.height, bitmap.stride, bytes(bitmap.buffer))
            total += len(picture)
            if total > MAX_PICTURE_BYTES:
                conn.send(("error", "too_complex"))  # type: ignore[attr-defined]
                return
            out.append((number, picture))
        conn.send(("ok", out))  # type: ignore[attr-defined]
    except MemoryError:
        conn.send(("error", "too_complex"))  # type: ignore[attr-defined]
    except Exception:
        conn.send(("error", "unreadable_pdf"))  # type: ignore[attr-defined]


def render_pages(data: bytes, page_numbers: list[int]) -> list[tuple[int, bytes]]:
    """The given pages (numbered from 1) drawn as grey PNG pictures, in a child process."""
    if not page_numbers:
        return []
    ctx = mp.get_context("spawn")
    parent, child = ctx.Pipe(duplex=False)
    proc = ctx.Process(target=_render_child, args=(data, page_numbers, child), daemon=True)
    proc.start()
    child.close()
    try:
        if not parent.poll(RENDER_TIMEOUT_SECONDS):
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
    return list(payload)


def extract_pdf(reader: MediaReader, data: bytes, max_pages: int) -> Extracted:
    """A PDF's text; for a scan, what the reader reads on the pictures of its pages without text."""
    pages = parse_pdf(data, max_pages)
    if not looks_like_scan(pages):
        return as_extracted(pages)
    if reader.name == "none":
        raise UploadRejected("looks_like_scan")
    without_text = [n for n, t in pages if len(t.strip()) < MIN_CHARS_PER_PAGE]
    read = {n: _normalise(reader.read_image(picture, "image/png")) for n, picture in render_pages(data, without_text)}
    combined = [(n, read.get(n) or t) for n, t in pages]
    doc = as_extracted(combined)
    if len(doc.text) > MAX_CHARS:
        raise UploadRejected("too_much_text")
    if not doc.text.strip():
        raise UploadRejected("empty")
    return doc
