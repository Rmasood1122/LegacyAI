"""Voice and scanned documents (features 7 and 25) through the real upload pipeline, against the real database as the AI
login. The reader is the test stand-in (FakeMediaReader): it understands no speech and no image - it reads the text a
test put after a marker - so what is proven here is everything around a real reader: types, refusal, redaction,
chunking, sealing, search, and that the file itself is kept nowhere. Synthetic data only."""

from __future__ import annotations

import time
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.ai_gateway import FakeEmbedder, FakeProvider
from app.capture import ingest
from app.capture.media import FAKE_MARKER, FakeMediaReader
from app.knowledge import reads
from app.knowledge.items import create_item
from app.main import Services, create_app
from app.platform import Database, Logger
from tests.conftest import World, make_settings, mint, needs_db
from tests.integration.helpers import chunk_ids_of_source, chunk_texts, search
from tests.integration.test_item_topics import may_read_topics

pytestmark = [pytest.mark.db, needs_db]

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8
WAV = b"RIFF\x00\x00\x00\x00WAVEfmt "
SCAN = PNG + FAKE_MARKER + b"Feed pump P-9 start-up. Open valve V4 fully before starting.\nQuestions: rae.kim@corp.test or (212) 555-0199."
RECORDING = WAV + FAKE_MARKER + b"First we check the oil level of compressor C-2.\nThen we listen for knocking.\nIf it knocks, stop it."


def new_source(db: Database, world: World, title: str = "Synthetic scan") -> str:
    src = ingest.create_source(db, world.ctx("owner", "source.create"), title=title, department_id=None, sensitivity=1,
                               contributor_person_id=None, company_document=True, storage_budget_bytes=10**12)
    return str(src["id"])


def upload(db: Database, world: World, embedder: FakeEmbedder, source_id: str, data: bytes, mime: str, media: Any = None) -> dict[str, Any]:
    return ingest.process_upload(db, world.ctx("owner", "source.content"), embedder, source_id, data, mime, 10**12, time.monotonic() + 60, media)


def source_row(admin: psycopg.Connection[dict[str, Any]], source_id: str) -> dict[str, Any]:
    row = admin.execute("SELECT status, failure_code, mime, page_count FROM sources WHERE id = %s", (source_id,)).fetchone()
    assert row is not None
    return row


def test_a_scanned_page_is_read_redacted_sealed_and_found(db: Database, world: World, embedder: FakeEmbedder,
                                                         admin: psycopg.Connection[dict[str, Any]]) -> None:
    source_id = new_source(db, world)
    assert upload(db, world, embedder, source_id, SCAN, "image/png", FakeMediaReader())["status"] == "ready"
    assert source_row(admin, source_id) == {"status": "ready", "failure_code": None, "mime": "image/png", "page_count": 1}
    rows = chunk_texts(admin, "c.source_id = %s", (source_id,))
    joined = " ".join(r["text"] for r in rows)
    assert "valve V4" in joined
    assert "rae.kim@corp.test" not in joined and "555-0199" not in joined and "[EMAIL_1]" in joined
    assert all(r["sealed"] for r in rows)
    assert search(db, world.tenant_id, embedder, "how do I start feed pump P-9")


def test_a_recording_becomes_one_page_per_minute_heard(db: Database, world: World, embedder: FakeEmbedder,
                                                      admin: psycopg.Connection[dict[str, Any]]) -> None:
    source_id = new_source(db, world, "Synthetic walk-through")
    assert upload(db, world, embedder, source_id, RECORDING, "audio/wav", FakeMediaReader())["status"] == "ready"
    row = source_row(admin, source_id)
    assert row["mime"] == "audio/wav" and row["page_count"] == 3
    spans = admin.execute("SELECT page_from, page_to FROM chunks WHERE source_id = %s", (source_id,)).fetchall()
    assert spans and all(1 <= s["page_from"] <= s["page_to"] <= 3 for s in spans)
    assert "oil level of compressor C-2" in " ".join(r["text"] for r in chunk_texts(admin, "c.source_id = %s", (source_id,)))


def test_without_a_reader_recordings_and_scans_are_refused_and_nothing_is_stored(db: Database, world: World, embedder: FakeEmbedder,
                                                                                admin: psycopg.Connection[dict[str, Any]]) -> None:
    for data, mime, code in ((RECORDING, "audio/wav", "voice_not_available"), (SCAN, "image/png", "ocr_not_available")):
        source_id = new_source(db, world, f"Synthetic {mime}")
        assert upload(db, world, embedder, source_id, data, mime) == {"status": "failed", "failure_code": code}
        assert source_row(admin, source_id)["status"] == "failed"
        assert admin.execute("SELECT count(*) AS n FROM chunks WHERE source_id = %s", (source_id,)).fetchone() == {"n": 0}


def test_the_declared_type_must_match_the_bytes(db: Database, world: World, embedder: FakeEmbedder) -> None:
    source_id = new_source(db, world)
    assert upload(db, world, embedder, source_id, RECORDING, "image/png", FakeMediaReader()) == {"status": "failed", "failure_code": "type_mismatch"}
    other = new_source(db, world)
    assert upload(db, world, embedder, other, PNG + b"no marker", "image/png", FakeMediaReader()) == {"status": "failed", "failure_code": "unreadable_media"}


def test_the_recording_or_image_itself_is_stored_nowhere(db: Database, world: World, embedder: FakeEmbedder,
                                                        admin: psycopg.Connection[dict[str, Any]]) -> None:
    for data, mime in ((SCAN, "image/png"), (RECORDING, "audio/wav")):
        assert upload(db, world, embedder, new_source(db, world, f"Synthetic {mime}"), data, mime, FakeMediaReader())["status"] == "ready"
    byte_cols = admin.execute("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND data_type = 'bytea'").fetchall()
    for col in byte_cols:
        for signature in (b"\x89PNG", b"RIFF", FAKE_MARKER):
            hit = admin.execute(f'SELECT count(*) AS n FROM "{col["table_name"]}" WHERE position(%s IN "{col["column_name"]}") > 0', (signature,)).fetchone()
            assert hit["n"] == 0, f"{col['table_name']}.{col['column_name']} holds bytes of the uploaded file"


def test_an_item_from_a_recording_counts_minutes_and_from_a_scan_pages(db: Database, world: World, embedder: FakeEmbedder,
                                                                         admin: psycopg.Connection[dict[str, Any]]) -> None:
    heard = new_source(db, world, "Synthetic walk-through")
    scanned = new_source(db, world, "Synthetic scan")
    upload(db, world, embedder, heard, RECORDING, "audio/wav", FakeMediaReader())
    upload(db, world, embedder, scanned, SCAN, "image/png", FakeMediaReader())
    cited = [chunk_ids_of_source(admin, heard)[0], chunk_ids_of_source(admin, scanned)[0]]
    with db.tenant_tx(world.tenant_id) as cur:
        item = create_item(cur, tenant_id=world.tenant_id, title="Synthetic start-up", body="Check the oil, open valve V4.", origin="manual",
                           ai_extracted=False, department_id=None, sensitivity=1, owner_person_id=None, consent_id=None, created_by_card_id=None,
                           author_card_id=None, author_person_id=None, change_kind="written", provenance=[(c, 0, 1, b"0" * 32) for c in cited])
    page = reads.get_item(db, world.ctx("owner", "item.read", subject=item, topic_filter=may_read_topics(world)), item)
    units = {p["source_id"]: p["unit"] for p in page["provenance"]}
    assert units == {heard: "minute", scanned: "page"}


def test_the_service_uses_its_configured_reader(db: Database, world: World) -> None:
    def client(reader: str) -> TestClient:
        return TestClient(create_app(Services(make_settings(MEDIA_READER=reader), db, FakeProvider(), FakeEmbedder(), Logger("error"))))

    def put(c: TestClient) -> dict[str, Any]:
        source_id = new_source(db, world)
        token = mint("source.content", tenant_id=world.tenant_id, card_id=world.people["owner"].card_id, person_id=world.people["owner"].id,
                     roles=["owner"], subject=source_id)
        res = c.put(f"/internal/sources/{source_id}/content", content=SCAN, headers={"Authorization": f"Bearer {token}", "content-type": "image/png"})
        assert res.status_code == 200, res.text
        return dict(res.json())

    assert put(client("fake"))["status"] == "ready"
    assert put(client("none"))["failure_code"] == "ocr_not_available"
