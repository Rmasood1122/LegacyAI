"""Voice and scanned documents (features 7 and 25) - PREPARED, not complete (docs/phase4/09-batch-c-prepared.md).

Speech-to-text and text-from-images (OCR) need a model: paid, or one much larger than this service's machine. What is
built here is everything around it, so that switching it on is one adapter plus the steps listed in the document:

  MediaReader      the port: audio -> timed segments of text; an image -> text
  NoMediaReader    the default: refuses (voice_not_available / ocr_not_available)
  FakeMediaReader  tests only: reads the text a test put after a marker - it understands no speech and no image
  sniff_media      the declared type is not trusted: the first bytes must agree (as for PDFs)
  extract_media    the reader's text in the same shape a PDF becomes (Extracted), normalised and limited the same way

Nothing here is reachable through the API yet: the contract's upload types, the database's accepted types
(sources.mime) and the call in ingest.process_upload are the remaining steps, each listed in the document.
"""

from __future__ import annotations

from typing import Protocol

from app.capture.files import MAX_CHARS, Extracted, UploadRejected, _normalise

AUDIO = frozenset({"audio/wav", "audio/mpeg", "audio/ogg", "audio/webm", "audio/mp4"})
IMAGE = frozenset({"image/png", "image/jpeg"})
FAKE_MARKER = b"FAKE-MEDIA\n"


class MediaReader(Protocol):
    name: str

    def transcribe(self, data: bytes, mime: str) -> list[tuple[int, str]]:
        """Audio -> segments (the minute each starts in, from 1; its text)."""

    def read_image(self, data: bytes, mime: str) -> str:
        """An image of a page -> its text."""


class NoMediaReader:
    name = "none"

    def transcribe(self, data: bytes, mime: str) -> list[tuple[int, str]]:
        raise UploadRejected("voice_not_available")

    def read_image(self, data: bytes, mime: str) -> str:
        raise UploadRejected("ocr_not_available")


class FakeMediaReader:
    """Stand-in for tests: the "recording" or "scan" carries its text after FAKE_MARKER. One segment per line."""

    name = "fake"

    @staticmethod
    def _text(data: bytes) -> str:
        at = data.find(FAKE_MARKER)
        if at < 0:
            raise UploadRejected("unreadable_media")
        try:
            return data[at + len(FAKE_MARKER):].decode("utf-8")
        except UnicodeDecodeError as exc:
            raise UploadRejected("unreadable_media") from exc

    def transcribe(self, data: bytes, mime: str) -> list[tuple[int, str]]:
        return [(i, line) for i, line in enumerate(self._text(data).splitlines(), start=1) if line.strip()]

    def read_image(self, data: bytes, mime: str) -> str:
        return self._text(data)


def media_reader(name: str, environment: str) -> MediaReader:
    if name == "none":
        return NoMediaReader()
    if name == "fake" and environment == "test":
        return FakeMediaReader()
    raise ValueError("MEDIA_READER must be none (or fake, only when ENVIRONMENT=test)")


def _looks_like(data: bytes, mime: str) -> bool:
    head = data[:16]
    if mime == "audio/wav":
        return head[:4] == b"RIFF" and head[8:12] == b"WAVE"
    if mime == "audio/mpeg":
        return head[:3] == b"ID3" or (len(head) > 1 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0)
    if mime == "audio/ogg":
        return head[:4] == b"OggS"
    if mime == "audio/webm":
        return head[:4] == b"\x1a\x45\xdf\xa3"
    if mime == "audio/mp4":
        return head[4:8] == b"ftyp"
    if mime == "image/png":
        return head[:8] == b"\x89PNG\r\n\x1a\n"
    if mime == "image/jpeg":
        return head[:3] == b"\xff\xd8\xff"
    return False


def sniff_media(data: bytes, declared: str) -> str:
    if declared not in AUDIO | IMAGE:
        raise UploadRejected("unsupported_type")
    if not _looks_like(data, declared):
        raise UploadRejected("type_mismatch")
    return declared


def extract_media(reader: MediaReader, data: bytes, mime: str) -> Extracted:
    """What the reader heard or read, as pages: a recording's segments, or the one page of a scan."""
    if mime in AUDIO:
        pages = [(n, _normalise(t)) for n, t in reader.transcribe(data, mime)]
    elif mime in IMAGE:
        pages = [(1, _normalise(reader.read_image(data, mime)))]
    else:
        raise UploadRejected("unsupported_type")
    text = "\n\n".join(t for _, t in pages)
    if len(text) > MAX_CHARS:
        raise UploadRejected("too_much_text")
    if not text.strip():
        raise UploadRejected("empty")
    return Extracted(text=text, pages=pages, page_count=len(pages))
