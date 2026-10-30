"""Scanned PDFs (feature 25): pages without text are drawn as pictures and read by the reader of pictures of pages.
Synthetic PDFs only. The reader here is a test stand-in that counts the black bars on each picture it is given - so
what is proven is that the right pages are drawn, as real pictures of those pages, in order, with their page numbers;
not how well any real text recognition reads them."""

from __future__ import annotations

import pytest

from app.capture.files import UploadRejected, extract
from app.capture.media import NoMediaReader
from app.capture.scans import MAX_SIDE_PIXELS, extract_pdf, png_gray, render_pages
from tests.pdfs import count_bars, make_pdf, make_scanned_pdf, read_png_gray

TEXT_PAGE = "Synthetic page: open valve V4 fully before starting feed pump P-9."


class BarReader:
    """Reads a picture as "<n> bars"; remembers every picture it was given."""

    name = "test-bars"

    def __init__(self, answers: dict[int, str] | None = None) -> None:
        self.answers = answers or {}
        self.seen: list[bytes] = []

    def transcribe(self, data: bytes, mime: str) -> list[tuple[int, str]]:
        raise AssertionError("a PDF is never sent as audio")

    def read_image(self, data: bytes, mime: str) -> str:
        assert mime == "image/png"
        self.seen.append(data)
        bars = count_bars(data)
        return self.answers.get(bars, f"This synthetic scanned page shows {bars} bars of the pump procedure.")


def test_the_png_written_here_decodes_to_the_same_pixels() -> None:
    pixels = bytes(range(256)) * 3
    width, height, rows = read_png_gray(png_gray(256, 3, 256, pixels))
    assert (width, height) == (256, 3) and b"".join(rows) == pixels
    # rows wider than the picture (the bitmap's stride) are cut to the picture's width
    _, _, cut = read_png_gray(png_gray(2, 2, 4, b"\x01\x02XX\x03\x04YY"))
    assert cut == [b"\x01\x02", b"\x03\x04"]


def test_a_page_is_drawn_as_a_grey_picture_of_that_page() -> None:
    pictures = render_pages(make_scanned_pdf([3, 0, 5]), [1, 2, 3])
    assert [n for n, _ in pictures] == [1, 2, 3]
    width, height, _ = read_png_gray(pictures[0][1])
    assert (width, height) in ((1240, 1754), (1240, 1755))     # A4 at 150 dots per inch
    assert [count_bars(p) for _, p in pictures] == [3, 0, 5]


def test_a_huge_page_is_drawn_smaller() -> None:
    (_, picture), = render_pages(make_scanned_pdf([2], size=(14400, 14400)), [1])
    width, height, _ = read_png_gray(picture)
    assert max(width, height) <= MAX_SIDE_PIXELS and count_bars(picture) == 2


def test_without_a_reader_a_scan_is_refused_as_before() -> None:
    with pytest.raises(UploadRejected) as exc:
        extract_pdf(NoMediaReader(), make_scanned_pdf([2, 3]), 50)
    assert exc.value.code == "looks_like_scan"
    with pytest.raises(UploadRejected) as exc:
        extract(make_scanned_pdf([2, 3]), "application/pdf", 50)
    assert exc.value.code == "looks_like_scan"


def test_with_a_reader_each_page_without_text_is_read_and_keeps_its_number() -> None:
    reader = BarReader({2: "Check the oil level of compressor C-2.", 4: "Listen for knocking before loading."})
    doc = extract_pdf(reader, make_scanned_pdf([2, 4]), 50)
    assert doc.pages == [(1, "Check the oil level of compressor C-2."), (2, "Listen for knocking before loading.")]
    assert doc.page_count == 2 and len(reader.seen) == 2


def test_in_a_mostly_scanned_pdf_only_the_pages_without_text_are_drawn() -> None:
    reader = BarReader()
    doc = extract_pdf(reader, make_scanned_pdf([1, "Short note: valve V4.", 3]), 50)
    assert [count_bars(p) for p in reader.seen] == [1, 3]
    assert [n for n, _ in doc.pages] == [1, 2, 3]
    assert doc.pages[1] == (2, "Short note: valve V4.")
    assert "1 bars" in doc.pages[0][1] and "3 bars" in doc.pages[2][1]


def test_a_pdf_with_text_never_reaches_the_reader() -> None:
    reader = BarReader()
    doc = extract_pdf(reader, make_pdf([TEXT_PAGE, TEXT_PAGE]), 50)
    assert reader.seen == [] and doc.page_count == 2


def test_a_reader_that_reads_nothing_leaves_the_document_empty() -> None:
    with pytest.raises(UploadRejected) as exc:
        extract_pdf(BarReader({2: "", 3: ""}), make_scanned_pdf([2, 3]), 50)
    assert exc.value.code == "empty"


def test_the_page_limit_still_applies_before_anything_is_drawn() -> None:
    reader = BarReader()
    with pytest.raises(UploadRejected) as exc:
        extract_pdf(reader, make_scanned_pdf([1, 1, 1]), 2)
    assert exc.value.code == "too_many_pages" and reader.seen == []


def test_a_broken_pdf_is_refused_not_crashed() -> None:
    with pytest.raises(UploadRejected) as exc:
        render_pages(b"%PDF-1.7\n" + b"garbage " * 200, [1])
    assert exc.value.code in ("unreadable_pdf", "too_complex")
