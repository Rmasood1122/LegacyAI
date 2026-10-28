"""Document ingestion (feature 25; docs/phase2/05 §2).

    create_source()     the description: title (redacted), labels, contributor or company declaration
    confirm_source()    a named contributor confirms "this is mine"
    process_upload()    the file: sniff -> parse -> redact -> chunk -> store (pending) -> embed -> ready
                        (a recording or a photo of a page is read by the media reader first; features 7 and 25)
    continue_embedding()  the rest of the embedding, on a later status request

The uploaded bytes exist only in memory during process_upload(); they are never written anywhere.
Parse, redact and chunk happen in one go: if that fails, nothing is stored and the source is
`failed` (the user still has the file). Embedding is resumable; pending chunks are never searched.
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import psycopg

from app.ai_gateway import Embedder
from app.capture.chunking import chunk_pages
from app.capture.files import UploadRejected, extract, sniff
from app.capture.filters import condition
from app.capture.media import AUDIO, IMAGE, MediaReader, NoMediaReader, extract_media, sniff_media
from app.capture.redaction import Finding, redact
from app.capture.sealed_chunks import (
    SEALED_COLUMNS,
    Fields,
    Opener,
    Sealer,
    new_row_id,
    open_source_title,
    row_key,
    seal_source_title,
    source_title_columns,
)
from app.platform import Database, ServiceContext, one, write_audit

DEFAULT_CHUNK_QUOTA = 5000
SYSTEM_CHUNK_CEILING = 50_000
STORAGE_GATE = 0.8
EMBED_BATCH = 16


class CaptureRefused(Exception):
    def __init__(self, code: str, status: int = 422) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


@dataclass(frozen=True)
class Limits:
    chunk_quota: int
    max_upload_bytes: int
    max_pdf_pages: int
    review_sla_days: int


def settings(cur: psycopg.Cursor[Any], tenant_id: str) -> Limits:
    cur.execute("SELECT chunk_quota, max_upload_bytes, max_pdf_pages, review_sla_days FROM knowledge_settings WHERE tenant_id = %s",
                (tenant_id,))
    row = cur.fetchone()
    if row is None:
        return Limits(DEFAULT_CHUNK_QUOTA, 5 * 1024 * 1024, 50, 5)
    return Limits(int(row["chunk_quota"]), int(row["max_upload_bytes"]), int(row["max_pdf_pages"]), int(row["review_sla_days"]))


def allowlist(cur: psycopg.Cursor[Any]) -> frozenset[str]:
    cur.execute("SELECT term FROM redaction_allowlist")
    return frozenset(r["term"].strip().lower() for r in cur.fetchall())


def check_room(cur: psycopg.Cursor[Any], tenant_id: str, adding: int, storage_budget_bytes: int, limits: Limits) -> None:
    cur.execute("SELECT COALESCE(sum(chunk_count), 0)::int AS total, "
                "COALESCE(sum(chunk_count) FILTER (WHERE tenant_id = %s), 0)::int AS mine FROM tenant_usage_counters", (tenant_id,))
    row = one(cur)
    if row["mine"] + adding > limits.chunk_quota:
        raise CaptureRefused("quota_exceeded")
    if row["total"] + adding > SYSTEM_CHUNK_CEILING:
        raise CaptureRefused("quota_exceeded")
    cur.execute("SELECT pg_database_size(current_database())::bigint AS bytes")
    if int(one(cur)["bytes"]) > STORAGE_GATE * storage_budget_bytes:
        raise CaptureRefused("storage_full", status=507)


def valid_consent(cur: psycopg.Cursor[Any], tenant_id: str, person_id: str, scope: str) -> str | None:
    cur.execute(
        """SELECT id::text AS id FROM consents
            WHERE tenant_id = %s AND person_id = %s AND scope = %s AND withdrawn_at IS NULL AND superseded_at IS NULL
              AND granted_at <= now() AND (expires_at IS NULL OR expires_at > now())""",
        (tenant_id, person_id, scope))
    row = cur.fetchone()
    return row["id"] if row else None


def create_source(db: Database, ctx: ServiceContext, *, title: str, department_id: str | None, sensitivity: int,
                  contributor_person_id: str | None, company_document: bool, storage_budget_bytes: int) -> dict[str, Any]:
    if company_document == (contributor_person_id is not None):
        raise CaptureRefused("contributor_or_declaration_required", status=400)
    with db.tenant_tx(ctx.tenant_id) as cur:
        limits = settings(cur, ctx.tenant_id)
        check_room(cur, ctx.tenant_id, 0, storage_budget_bytes, limits)
        safe_title = redact(title, allowlist(cur)).text[:200] or "Untitled"
        consent_id = None
        status = "awaiting_content"
        if contributor_person_id is not None:
            consent_id = valid_consent(cur, ctx.tenant_id, contributor_person_id, "documents")
            if consent_id is None:
                raise CaptureRefused("consent_missing")
            if contributor_person_id != ctx.person_id:
                status = "awaiting_confirmation"
        source_id = new_row_id(cur)
        stored = seal_source_title(cur, ctx.tenant_id, source_id, safe_title)     # sealed with the company's content key (D41)
        cur.execute(
            """INSERT INTO sources (id, tenant_id, kind, title, title_sealed, sealed_key, department_id, sensitivity, owner_person_id, consent_id,
                                    company_owned_attested_by_card_id, uploaded_by_card_id, status)
               VALUES (%s, %s, 'document', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               RETURNING id::text AS id, status""",
            (source_id, ctx.tenant_id, stored["title"], stored["title_sealed"], stored["sealed_key"], department_id, sensitivity, contributor_person_id,
             consent_id, ctx.card_id if company_document else None, ctx.card_id, status))
        row = {**one(cur), "title": safe_title}
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="capture:source_created", reason_code="SOURCE_CREATED",
                    resource_type="source", resource_id=row["id"], request_id=ctx.request_id, details={"source_id": row["id"]})
    return row


MAX_TITLES = 100


def source_titles(db: Database, ctx: ServiceContext, source_ids: list[str]) -> dict[str, str]:
    """The titles of these documents, for the API's document list and page (D41 step 6: the API cannot read them
    itself). Only documents the caller may read are named (ctx.filter, built for source:read); unknown ids and ids the
    caller may not read are simply left out, so the answer says nothing about them."""
    where, params = condition(ctx.filter, "sources", ctx.tenant_id)
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute(f"""SELECT s.id::text AS id, {source_title_columns("s")} FROM sources s
                         WHERE s.tenant_id = %s AND s.id = ANY(%s::uuid[]) AND {where}""",
                    [ctx.tenant_id, list(source_ids)[:MAX_TITLES], *params])
        documents = Fields(cur, ctx.tenant_id, "sources")
        return {r["id"]: open_source_title(documents, dict(r))["title"] for r in cur.fetchall()}


def confirm_source(db: Database, ctx: ServiceContext, source_id: str) -> dict[str, Any]:
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute(
            """UPDATE sources SET status = 'awaiting_content', contributor_confirmed_at = now()
                WHERE tenant_id = %s AND id = %s AND status = 'awaiting_confirmation' AND owner_person_id = %s
                RETURNING id::text AS id, status""", (ctx.tenant_id, source_id, ctx.person_id))
        row = cur.fetchone()
        if row is None:
            raise CaptureRefused("not_found", status=404)
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="capture:source_confirmed", reason_code="CONTRIBUTOR_CONFIRMED",
                    resource_type="source", resource_id=source_id, request_id=ctx.request_id)
    return dict(row)


def _fail(db: Database, tenant_id: str, source_id: str, code: str) -> None:
    with db.tenant_tx(tenant_id) as cur:
        cur.execute("DELETE FROM chunks WHERE tenant_id = %s AND source_id = %s AND status = 'pending'", (tenant_id, source_id))
        cur.execute("UPDATE sources SET status = 'failed', failure_code = %s WHERE tenant_id = %s AND id = %s AND status IN ('awaiting_content', 'processing')",
                    (code, tenant_id, source_id))


def _duplicate_visible(cur: psycopg.Cursor[Any], ctx: ServiceContext, digest: bytes, source_id: str) -> str | None:
    """Reports a duplicate only if the uploader may READ the existing source (docs/phase2/03)."""
    where, params = condition(ctx.filter, "sources", ctx.tenant_id)
    cur.execute(
        f"""SELECT s.id::text AS id FROM sources s
             WHERE s.tenant_id = %s AND s.content_sha256 = %s AND s.status = 'ready' AND s.id <> %s AND {where} LIMIT 1""",
        [ctx.tenant_id, digest, source_id, *params])
    row = cur.fetchone()
    return row["id"] if row else None


def process_upload(db: Database, ctx: ServiceContext, embedder: Embedder, source_id: str, data: bytes, declared_mime: str,
                   storage_budget_bytes: int, deadline: float, media: MediaReader | None = None) -> dict[str, Any]:
    """`media` reads recordings and images (default: the reader that refuses them)."""
    digest = hashlib.sha256(data).digest()
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute("SELECT status, kind FROM sources WHERE tenant_id = %s AND id = %s FOR UPDATE", (ctx.tenant_id, source_id))
        src = cur.fetchone()
        if src is None or src["kind"] != "document":
            raise CaptureRefused("not_found", status=404)
        if src["status"] != "awaiting_content":
            raise CaptureRefused("not_awaiting_content", status=409)
        limits = settings(cur, ctx.tenant_id)
        terms = allowlist(cur)
        duplicate = _duplicate_visible(cur, ctx, digest, source_id)
    if duplicate is not None:
        _fail(db, ctx.tenant_id, source_id, "duplicate")
        return {"status": "failed", "failure_code": "duplicate", "duplicate_of": duplicate}
    try:
        if len(data) > limits.max_upload_bytes:
            raise UploadRejected("too_large")
        if declared_mime in AUDIO | IMAGE:
            # a recording (its pages are the minutes it was heard in) or a photo of one page; then like any document
            mime = sniff_media(data, declared_mime)
            doc = extract_media(media or NoMediaReader(), data, mime)
        else:
            mime = sniff(data, declared_mime)
            doc = extract(data, mime, limits.max_pdf_pages)
        numbering: dict[str, dict[str, int]] = {}
        redacted_pages: list[tuple[int, str]] = []
        findings: list[Finding] = []
        for page, text in doc.pages:
            r = redact(text, terms, numbering)
            redacted_pages.append((page, r.text))
            findings.extend(r.findings)
        chunks = []
        seen: set[str] = set()
        for c in chunk_pages(redacted_pages):
            if c.text in seen:
                continue
            seen.add(c.text)
            chunks.append(c)
        if not chunks:
            raise UploadRejected("empty")
    except UploadRejected as exc:
        _fail(db, ctx.tenant_id, source_id, exc.code)
        return {"status": "failed", "failure_code": exc.code}

    try:
        with db.tenant_tx(ctx.tenant_id) as cur:
            check_room(cur, ctx.tenant_id, len(chunks), storage_budget_bytes, limits)
            cur.execute(
                """UPDATE sources SET status = 'processing', mime = %s, byte_size = %s, page_count = %s, char_count = %s, content_sha256 = %s
                    WHERE tenant_id = %s AND id = %s
                    RETURNING department_id::text AS department_id, sensitivity, owner_person_id::text AS owner_person_id""",
                (mime, len(data), doc.page_count, len(doc.text), digest, ctx.tenant_id, source_id))
            labels = one(cur)
            low = sum(1 for f in findings if f.low_confidence)
            sealer = Sealer(cur, ctx.tenant_id)      # sealed with the company's content key (D41)
            for c in chunks:
                count = sum(1 for f in findings if f.placeholder and f.placeholder in c.text)
                body = sealer.text_columns(row_key(kind="source", source_id=source_id, ordinal=c.ordinal, knowledge_item_id=None), c.text)
                cur.execute(
                    """INSERT INTO chunks (tenant_id, kind, source_id, ordinal, text, text_sealed, sealed_key, token_estimate, department_id,
                                           sensitivity, owner_person_id, page_from, page_to, redaction_count, low_confidence_redactions, status)
                       VALUES (%s, 'source', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'pending')""",
                    (ctx.tenant_id, source_id, c.ordinal, body["text"], body["text_sealed"], body["sealed_key"], c.token_estimate,
                     labels["department_id"], labels["sensitivity"], labels["owner_person_id"], c.page_from, c.page_to, count,
                     any(f.low_confidence and f.placeholder in c.text for f in findings)))
            for f in findings:
                cur.execute(
                    """INSERT INTO redaction_findings (tenant_id, source_id, entity_type, detector, confidence, placeholder, char_length, low_confidence)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                    (ctx.tenant_id, source_id, f.entity_type, f.detector, f.confidence, f.placeholder, f.end - f.start, f.low_confidence))
            if low:
                cur.execute(
                    """INSERT INTO review_tasks (tenant_id, kind, subject_type, subject_id, department_id, sensitivity, owner_person_id, priority, due_at)
                       VALUES (%s, 'redaction_review', 'source', %s, %s, %s, %s, 20, now() + make_interval(days => %s))
                       ON CONFLICT DO NOTHING""",
                    (ctx.tenant_id, source_id, labels["department_id"], labels["sensitivity"], labels["owner_person_id"], limits.review_sla_days))
    except CaptureRefused as exc:
        _fail(db, ctx.tenant_id, source_id, exc.code)
        raise
    except psycopg.errors.CheckViolation:
        # the consent gate in the database (sources_guard) refused: consent withdrawn or contributor not confirmed
        _fail(db, ctx.tenant_id, source_id, "consent_missing")
        return {"status": "failed", "failure_code": "consent_missing"}
    return continue_embedding(db, ctx.tenant_id, ctx.card_id, source_id, embedder, deadline, request_id=ctx.request_id,
                              api_key_id=ctx.api_key_id)


def continue_embedding(db: Database, tenant_id: str, card_id: str | None, source_id: str, embedder: Embedder, deadline: float,
                       request_id: str | None = None, api_key_id: str | None = None) -> dict[str, Any]:
    """Embeds pending chunks in batches until done or out of time; then marks the source ready."""
    while time.monotonic() < deadline:
        with db.tenant_tx(tenant_id) as cur:
            cur.execute(
                f"""SELECT c.id::text AS id, {SEALED_COLUMNS} FROM chunks c
                     WHERE c.tenant_id = %s AND c.source_id = %s AND c.status = 'pending' AND c.embedding IS NULL AND c.embedding_sealed IS NULL
                     ORDER BY c.ordinal LIMIT %s""", (tenant_id, source_id, EMBED_BATCH))
            batch = cur.fetchall()
            if not batch:
                break
            vectors = embedder.embed(Opener(cur, tenant_id).texts(batch), "document")
            sealer = Sealer(cur, tenant_id)
            for r, v in zip(batch, vectors, strict=True):
                vec = sealer.vector_columns(row_key(kind="source", source_id=source_id, ordinal=r["ordinal"], knowledge_item_id=None), v,
                                            r["sealed_key"])
                cur.execute("UPDATE chunks SET embedding = %s, embedding_sealed = %s, embedding_model = %s WHERE tenant_id = %s AND id = %s",
                            (vec["embedding"], vec["embedding_sealed"], embedder.model_id, tenant_id, r["id"]))
    with db.tenant_tx(tenant_id) as cur:
        cur.execute("SELECT count(*) FILTER (WHERE embedding IS NULL AND embedding_sealed IS NULL)::int AS missing, count(*)::int AS total FROM chunks "
                    "WHERE tenant_id = %s AND source_id = %s AND status = 'pending'", (tenant_id, source_id))
        counts = one(cur)
        if counts["missing"] > 0:
            cur.execute(
                """INSERT INTO jobs (tenant_id, kind, subject_id, locked_until) VALUES (%s, 'embed', %s, NULL)
                   ON CONFLICT DO NOTHING""", (tenant_id, source_id))
            return {"status": "processing", "pending_chunks": counts["missing"]}
        cur.execute("SELECT status FROM sources WHERE tenant_id = %s AND id = %s FOR UPDATE", (tenant_id, source_id))
        if one(cur)["status"] != "processing":
            return {"status": "failed", "failure_code": "not_processing"}
        cur.execute("UPDATE chunks SET status = 'active' WHERE tenant_id = %s AND source_id = %s AND status = 'pending'", (tenant_id, source_id))
        cur.execute(
            """UPDATE sources SET status = 'ready', ready_at = now(),
                      chunk_count = (SELECT count(*) FROM chunks WHERE tenant_id = %s AND source_id = %s AND status = 'active')
                WHERE tenant_id = %s AND id = %s RETURNING chunk_count""", (tenant_id, source_id, tenant_id, source_id))
        total = int(one(cur)["chunk_count"])
        cur.execute("UPDATE jobs SET status = 'done', updated_at = now() WHERE tenant_id = %s AND kind = 'embed' AND subject_id = %s "
                    "AND status IN ('queued', 'running')", (tenant_id, source_id))
        cur.execute("SELECT count(*)::int AS n FROM redaction_findings WHERE tenant_id = %s AND source_id = %s", (tenant_id, source_id))
        redactions = int(one(cur)["n"])
        write_audit(cur, tenant_id=tenant_id, card_id=card_id, action="capture:document_ready", reason_code="SOURCE_READY",
                    resource_type="source", resource_id=source_id, request_id=request_id,
                    details={"source_id": source_id, "chunk_count": total, "redactions": redactions}, api_key_id=api_key_id)
    return {"status": "ready", "chunk_count": total}


def utcnow() -> datetime:
    return datetime.now(UTC)


def sla(days: int) -> datetime:
    return utcnow() + timedelta(days=days)
