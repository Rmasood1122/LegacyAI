"""MEASURED numbers the design left as assumptions (docs/phase2/01, 08), and housekeeping.

Printed as `sizes:` lines in CI. They are measurements on CI hardware with synthetic data and the
fake embedder (same vector size as the real one); they are not guarantees for production.
"""

from __future__ import annotations

import io
import json
import time
from typing import Any

import psycopg
import pytest

from app.ai_gateway import FakeEmbedder
from app.capture import redact, retrieve
from app.capture.chunking import chunk_pages
from app.capture.files import extract
from app.platform import Database, Logger, housekeeping
from tests.conftest import World, make_world, needs_db, tenant_filter
from tests.integration.helpers import verified_item
from tests.pdfs import make_pdf

PARAGRAPH = ("Before starting pump {n}, the operator opens valve V{n} fully and checks that the gauge reads below four bar. "
             "If the reading is higher, the bypass is opened slowly and the shift lead is informed before any further step.")


def test_a_50_page_text_pdf_fits_in_one_upload_request(capsys: pytest.CaptureFixture[str]) -> None:
    pages = ["\n".join(PARAGRAPH.format(n=p * 10 + i) for i in range(6)) for p in range(50)]
    pdf = make_pdf(pages)
    warm = time.monotonic()
    redact("Warm-up for the language model.")   # loading the model happens once per instance; reported separately
    loaded = time.monotonic()
    started = time.monotonic()
    doc = extract(pdf, "application/pdf", 50)
    parsed = time.monotonic()
    numbering: dict[str, dict[str, int]] = {}
    red = [(p, redact(t, frozenset(), numbering).text) for p, t in doc.pages]
    redacted = time.monotonic()
    chunks = chunk_pages(red)
    done = time.monotonic()
    with capsys.disabled():
        print(f"\nsizes: redaction model load (once per instance) {loaded - warm:.1f} s")
        print(f"sizes: 50-page synthetic text PDF ({len(pdf)} bytes, {len(doc.text)} characters): parse {parsed - started:.1f} s, "
              f"redact {redacted - parsed:.1f} s, chunk {done - redacted:.2f} s -> {len(chunks)} passages")
    assert doc.page_count == 50 and chunks
    assert done - started < 50, "the upload request has a 50-second working budget before embedding"


@pytest.mark.db
@needs_db
def test_bytes_per_passage_and_search_time_at_5000_passages(db: Database, admin: psycopg.Connection[dict[str, Any]],
                                                            capsys: pytest.CaptureFixture[str]) -> None:
    world = make_world(admin, people=("owner",))
    embedder = FakeEmbedder()
    with admin.transaction():
        admin.execute("SELECT set_config('app.tenant_id', %s, true)", (world.tenant_id,))
        src = admin.execute("""INSERT INTO sources (tenant_id, kind, title, sensitivity, company_owned_attested_by_card_id, uploaded_by_card_id, status)
                               VALUES (%s, 'document', 'Size test', 1, %s, %s, 'awaiting_content') RETURNING id""",
                            (world.tenant_id, world.people["owner"].card_id, world.people["owner"].card_id)).fetchone()["id"]
        admin.execute("UPDATE sources SET status = 'processing' WHERE id = %s", (src,))
        before = admin.execute("SELECT pg_total_relation_size('chunks')::bigint AS b").fetchone()["b"]
        rows = []
        for n in range(5000):
            text = PARAGRAPH.format(n=n)
            vec = "[" + ",".join(f"{x:.5f}" for x in embedder.embed([text], "document")[0]) + "]"
            rows.append((world.tenant_id, src, n, text, len(text) // 4, vec, embedder.model_id))
        with admin.cursor() as cur:
            cur.executemany("""INSERT INTO chunks (tenant_id, kind, source_id, ordinal, text, token_estimate, embedding, embedding_model, sensitivity, status)
                               VALUES (%s, 'source', %s, %s, %s, %s, %s::halfvec, %s, 1, 'active')""", rows)
        admin.execute("UPDATE sources SET status = 'ready' WHERE id = %s", (src,))
    admin.execute("VACUUM ANALYZE chunks")
    after = admin.execute("SELECT pg_total_relation_size('chunks')::bigint AS b").fetchone()["b"]
    per = (after - before) / 5000
    timings = []
    for q in ("what does the operator check before starting the pump", "bypass shift lead", "valve V4321 gauge"):
        started = time.monotonic()
        with db.tenant_tx(world.tenant_id) as cur:
            found = retrieve(cur, tenant_id=world.tenant_id, spec=tenant_filter(world.tenant_id), question=q, embedder=embedder)
        timings.append(time.monotonic() - started)
        assert found
    timings.sort()
    with capsys.disabled():
        print(f"sizes: chunks table grew {after - before} bytes for 5000 passages = {per:.0f} bytes per passage "
              f"(text ~{len(PARAGRAPH)} chars, 384-dim half vector)")
        print(f"sizes: search over 5000 passages (exact, no vector index): median {timings[1] * 1000:.0f} ms, slowest {timings[-1] * 1000:.0f} ms")
    assert per < 8000
    assert timings[-1] < 5.0


@pytest.mark.db
@needs_db
def test_no_document_text_reaches_the_logs(db: Database, world: World, admin: psycopg.Connection[dict[str, Any]],
                                           capsys: pytest.CaptureFixture[str]) -> None:
    from app.ai_gateway import FakeProvider, Gateway, load_prices, load_prompts
    from app.knowledge import answers

    stream = io.StringIO()
    logger = Logger("debug", stream)
    embedder = FakeEmbedder()
    marker = "LOGMARK-synthetic-boiler-fact"
    item = verified_item(db, world, embedder, f"The relief valve is tested monthly. {marker}.")
    chunk = admin.execute("SELECT id FROM chunks WHERE knowledge_item_id = %s", (item,)).fetchone()["id"]
    provider = FakeProvider()
    provider.script = lambda req: {"answerable": True, "answer": "x", "claims": [], "conflict": False}   # forces a retry path and warnings
    gateway = Gateway(db, provider, load_prompts(), load_prices(), logger)
    answers.answer(db, world.ctx("learner", "knowledge.answer", approved=[str(chunk)]), gateway, embedder, world.caller("learner"),
                   f"When is the relief valve tested? {marker}", None, None)
    printed = capsys.readouterr()
    for text in (stream.getvalue(), printed.out, printed.err):
        assert marker not in text
    for line in stream.getvalue().splitlines():
        assert not ({"text", "question", "answer", "body", "prompt"} & set(json.loads(line)))


@pytest.mark.db
@needs_db
def test_housekeeping_marks_stale_expires_and_is_bounded(db: Database, world: World, admin: psycopg.Connection[dict[str, Any]]) -> None:
    embedder = FakeEmbedder()
    item = verified_item(db, world, embedder, "The chiller loop is flushed every quarter by the day shift.")
    with admin.transaction():
        admin.execute("SELECT set_config('app.tenant_id', %s, true)", (world.tenant_id,))
        admin.execute("UPDATE knowledge_items SET stale_after = now() - interval '1 day' WHERE id = %s", (item,))
    first = housekeeping.run(db, world.tenant_id)
    assert first["stale"] == 1
    assert admin.execute("SELECT status FROM knowledge_items WHERE id = %s", (item,)).fetchone()["status"] == "stale"
    assert admin.execute("SELECT verification_status FROM chunks WHERE knowledge_item_id = %s", (item,)).fetchone()["verification_status"] == "stale"
    assert admin.execute("SELECT count(*)::int AS n FROM review_tasks WHERE subject_id = %s AND kind = 'stale_item'", (item,)).fetchone()["n"] == 1
    again = housekeeping.run(db, world.tenant_id)          # idempotent: nothing left to do
    assert again["stale"] == 0
