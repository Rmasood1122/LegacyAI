"""File checks, sandboxed PDF parsing and chunking (feature 25; docs/phase2/05 §2)."""

from __future__ import annotations

import pytest

from app.capture.chunking import MAX_CHARS, chunk_pages
from app.capture.files import UploadRejected, extract, sniff
from tests.pdfs import bomb_pdf, make_pdf


def test_text_and_pdf_pass_the_type_check() -> None:
    assert sniff(b"Plain synthetic notes.\n", "text/plain") == "text/plain"
    assert sniff(make_pdf(["Synthetic page"]), "application/pdf") == "application/pdf"


@pytest.mark.parametrize("data, declared, code", [
    (b"plain text", "application/pdf", "type_mismatch"),
    (make_pdf(["x"]), "text/plain", "type_mismatch"),
    (b"PK\x03\x04 zip pretending to be text", "text/plain", "type_mismatch"),
    (b"MZ\x90\x00 windows program", "text/plain", "type_mismatch"),
    (b"<!DOCTYPE html><script>alert(1)</script>", "text/plain", "type_mismatch"),
    (b"null\x00byte", "text/plain", "type_mismatch"),
    (b"\xff\xfe not utf-8", "text/plain", "not_utf8"),
    (b"\x01\x02\x03\x04\x05\x06" * 20, "text/plain", "type_mismatch"),
    (b"anything", "application/zip", "unsupported_type"),
    (b"anything", "text/html", "unsupported_type"),
])
def test_files_that_are_not_what_they_claim_are_refused(data: bytes, declared: str, code: str) -> None:
    with pytest.raises(UploadRejected) as exc:
        sniff(data, declared)
    assert exc.value.code == code


def test_pdf_text_is_extracted_page_by_page() -> None:
    doc = extract(make_pdf(["First synthetic page about pump checks.", "Second page about valve torque."]), "application/pdf", 50)
    assert doc.page_count == 2
    assert "pump checks" in doc.pages[0][1] and "valve torque" in doc.pages[1][1]


def test_too_many_pages_is_refused() -> None:
    with pytest.raises(UploadRejected) as exc:
        extract(make_pdf(["a", "b", "c"]), "application/pdf", 2)
    assert exc.value.code == "too_many_pages"


def test_a_broken_pdf_is_refused_not_crashed() -> None:
    with pytest.raises(UploadRejected) as exc:
        extract(b"%PDF-1.7\n" + b"garbage " * 200, "application/pdf", 50)
    assert exc.value.code in ("unreadable_pdf", "empty", "scanned_pdf")


def test_a_decompression_bomb_does_not_take_the_service_down() -> None:
    with pytest.raises(UploadRejected) as exc:
        extract(bomb_pdf(60), "application/pdf", 50)
    assert exc.value.code in ("unreadable_pdf", "too_complex", "too_much_text")


def test_empty_text_is_refused() -> None:
    with pytest.raises(UploadRejected):
        extract(b"   \n\n  ", "text/plain", 50)


def test_invisible_characters_are_removed() -> None:
    doc = extract("pass​word re‍set".encode(), "text/plain", 50)
    assert doc.text == "password reset"


def test_chunks_respect_the_maximum_and_keep_placeholders_whole() -> None:
    sentence = "The synthetic pump [PERSON_1] checks the valve before start. "
    text = sentence * 200 + "x" * 3000 + " [EMAIL_2] end."
    chunks = chunk_pages([(1, text)])
    assert chunks and all(len(c.text) <= MAX_CHARS for c in chunks)
    for c in chunks:
        assert c.text.count("[") == c.text.count("]")
    assert [c.ordinal for c in chunks] == list(range(len(chunks)))


def test_chunks_remember_their_pages() -> None:
    chunks = chunk_pages([(1, "Page one fact. " * 10), (2, "Page two fact. " * 10)])
    assert chunks[0].page_from == 1 and chunks[-1].page_to == 2
