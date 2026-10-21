"""Voice and scanned documents (features 7, 25) - PREPARED: the port, the stand-ins and the checks around them.

No model is involved: FakeMediaReader understands no speech and no image, it reads text a test put after a marker.
"""

from __future__ import annotations

import pytest

from app.capture.files import UploadRejected
from app.capture.media import (
    FAKE_MARKER,
    FakeMediaReader,
    NoMediaReader,
    extract_media,
    media_reader,
    sniff_media,
)

WAV = b"RIFF\x00\x00\x00\x00WAVEfmt "
PNG = b"\x89PNG\r\n\x1a\n"
JPEG = b"\xff\xd8\xff\xe0"


def test_nothing_is_read_without_a_reader() -> None:
    with pytest.raises(UploadRejected) as voice:
        extract_media(NoMediaReader(), WAV + FAKE_MARKER + b"hello", "audio/wav")
    assert voice.value.code == "voice_not_available"
    with pytest.raises(UploadRejected) as ocr:
        extract_media(NoMediaReader(), PNG + FAKE_MARKER + b"hello", "image/png")
    assert ocr.value.code == "ocr_not_available"


def test_a_recording_becomes_pages_of_segments_and_a_scan_one_page() -> None:
    recording = extract_media(FakeMediaReader(), WAV + FAKE_MARKER + b"Close valve 3 first.\n\nThen vent the line.", "audio/wav")
    assert recording.pages == [(1, "Close valve 3 first."), (3, "Then vent the line.")]
    assert recording.page_count == 2
    scan = extract_media(FakeMediaReader(), PNG + FAKE_MARKER + "Torque: 40 Nm​".encode(), "image/png")
    assert scan.pages == [(1, "Torque: 40 Nm")]          # normalised like any document (the zero-width space is gone)


@pytest.mark.parametrize(("data", "declared"), [
    (PNG, "image/jpeg"), (JPEG, "image/png"), (b"%PDF-1.7", "image/png"), (b"ID3", "audio/wav"),
    (WAV, "audio/ogg"), (b"MZ\x90\x00", "audio/mpeg"),
])
def test_the_declared_type_must_match_the_first_bytes(data: bytes, declared: str) -> None:
    with pytest.raises(UploadRejected) as exc:
        sniff_media(data + b"\x00" * 16, declared)
    assert exc.value.code == "type_mismatch"


def test_known_types_pass_and_others_are_unsupported() -> None:
    assert sniff_media(WAV + b"\x00" * 8, "audio/wav") == "audio/wav"
    assert sniff_media(b"ID3\x04" + b"\x00" * 12, "audio/mpeg") == "audio/mpeg"
    assert sniff_media(b"OggS" + b"\x00" * 12, "audio/ogg") == "audio/ogg"
    assert sniff_media(b"\x00\x00\x00\x18ftypM4A " + b"\x00" * 8, "audio/mp4") == "audio/mp4"
    assert sniff_media(JPEG + b"\x00" * 12, "image/jpeg") == "image/jpeg"
    with pytest.raises(UploadRejected) as exc:
        sniff_media(b"GIF89a" + b"\x00" * 10, "image/gif")
    assert exc.value.code == "unsupported_type"


def test_an_empty_or_unreadable_result_is_refused() -> None:
    with pytest.raises(UploadRejected) as empty:
        extract_media(FakeMediaReader(), WAV + FAKE_MARKER + b"   \n  ", "audio/wav")
    assert empty.value.code == "empty"
    with pytest.raises(UploadRejected) as unreadable:
        extract_media(FakeMediaReader(), WAV + b"no marker", "audio/wav")
    assert unreadable.value.code == "unreadable_media"


def test_the_stand_in_exists_only_where_tests_run() -> None:
    assert media_reader("none", "production").name == "none"
    assert media_reader("fake", "test").name == "fake"
    for env in ("development", "production"):
        with pytest.raises(ValueError):
            media_reader("fake", env)
    with pytest.raises(ValueError):
        media_reader("some-cloud-service", "test")
