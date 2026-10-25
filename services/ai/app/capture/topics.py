"""Topic list support (feature 10; docs/phase2/05 §5). The list itself is the company's: an admin
creates, renames, accepts and retires topics through the API, which checks their right to and sends
the request here (decision D41, step 6 part 4b: topic names and descriptions are written and read only
by this service, so they can be stored sealed). Here also: the embedding of a topic, and suggestions
from a document the caller may read - `proposed`, counting for nothing until accepted.
"""

from __future__ import annotations

from typing import Any

import psycopg
from pgvector import HalfVector

from app.ai_gateway import Caller, DataBlock, Embedder, Gateway, TopicExtractOutput
from app.capture.filters import condition
from app.capture.redaction import redact
from app.capture.sealed_chunks import SEALED_COLUMNS, Opener
from app.platform import Database, ServiceContext, one, write_audit

SUGGEST_FROM_CHUNKS = 6
MAX_TEXTS = 100
# The topic as the API shows it (KTopic in openapi.yaml).
TOPIC_ROW = """tp.id::text AS id, tp.name, tp.description, tp.department_id::text AS department_id, tp.sensitivity, tp.origin,
               tp.status, tp.created_at"""
# The status changes a person may make: accept a proposal, retire an active topic (or leave it as it is).
_MOVES = {("proposed", "active"), ("active", "retired")}


def embed_topic(cur: psycopg.Cursor[Any], tenant_id: str, topic_id: str, embedder: Embedder) -> None:
    cur.execute("SELECT name, description FROM topics WHERE tenant_id = %s AND id = %s", (tenant_id, topic_id))
    t = cur.fetchone()
    if t is None:
        return
    vector = embedder.embed([f"{t['name']}. {t['description']}".strip()], "document")[0]
    cur.execute("UPDATE topics SET embedding = %s, embedding_model = %s WHERE tenant_id = %s AND id = %s",
                (HalfVector(vector), embedder.model_id, tenant_id, topic_id))


class TopicRefused(Exception):
    def __init__(self, code: str, status: int = 409) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


def embed(db: Database, ctx: ServiceContext, embedder: Embedder, topic_id: str) -> None:
    """Computes a topic's search vector again (the API no longer needs this: creating and changing a topic do it)."""
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute("SELECT 1 FROM topics WHERE tenant_id = %s AND id = %s", (ctx.tenant_id, topic_id))
        if cur.fetchone() is None:
            raise TopicRefused("not_found", 404)
        embed_topic(cur, ctx.tenant_id, topic_id, embedder)


def _readable(spec: Any, tenant_id: str) -> tuple[str, list[Any]]:
    """The caller's topic:read filter as a condition on topics (alias tp). "Verified only" (sent for a card whose grants
    are all at level 0) concerns knowledge: topics have no verified state, and the API's own topic filter ignores the
    mark, so it is ignored here too; everything else about the filter applies unchanged."""
    if isinstance(spec, dict) and spec.get("only_verified") is True:
        spec = {**spec, "only_verified": False}
    return condition(spec, "topics", tenant_id)


def _public(row: dict[str, Any]) -> dict[str, Any]:
    return {**row, "created_at": row["created_at"].isoformat()}


def create(db: Database, ctx: ServiceContext, embedder: Embedder, *, name: str, description: str, department_id: str | None,
           sensitivity: int) -> dict[str, Any]:
    """An active topic made by a person (the API checked topic:write for them). Its search vector is computed in the
    same step, so a topic never exists without one. A topic of the same name (any case) -> 409 duplicate_topic."""
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute(
            f"""INSERT INTO topics AS tp (tenant_id, name, description, department_id, sensitivity, origin, status, created_by_card_id)
                VALUES (%s, %s, %s, %s, %s, 'admin', 'active', %s)
                ON CONFLICT (tenant_id, lower(name)) DO NOTHING RETURNING {TOPIC_ROW}""",
            (ctx.tenant_id, name, description, department_id, sensitivity, ctx.card_id))
        row = cur.fetchone()
        if row is None:
            raise TopicRefused("duplicate_topic")
        embed_topic(cur, ctx.tenant_id, row["id"], embedder)
        return _public(dict(row))


def update(db: Database, ctx: ServiceContext, embedder: Embedder, topic_id: str, *, name: str | None, description: str | None,
           status: str | None) -> dict[str, Any]:
    """Renames, re-describes, accepts or retires a topic (the API checked topic:write on it). An active topic gets its
    search vector again in the same step."""
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute("SELECT status FROM topics WHERE tenant_id = %s AND id = %s FOR UPDATE", (ctx.tenant_id, topic_id))
        before = cur.fetchone()
        if before is None:
            raise TopicRefused("not_found", 404)
        if status is not None and status != before["status"] and (before["status"], status) not in _MOVES:
            raise TopicRefused("illegal_transition")
        try:
            cur.execute(
                f"""UPDATE topics tp SET name = COALESCE(%s, name), description = COALESCE(%s, description), status = COALESCE(%s, status)
                     WHERE tenant_id = %s AND id = %s RETURNING {TOPIC_ROW}""",
                (name, description, status, ctx.tenant_id, topic_id))
        except psycopg.errors.UniqueViolation:
            raise TopicRefused("duplicate_topic") from None
        row = one(cur)
        if row["status"] == "active":
            embed_topic(cur, ctx.tenant_id, topic_id, embedder)
        return _public(dict(row))


def apply_template(db: Database, ctx: ServiceContext, embedder: Embedder, entries: list[dict[str, str]]) -> list[dict[str, Any]]:
    """The topics of a department template (feature 26): each is ADDED if no topic of its name exists; otherwise the
    existing one is used only if the caller may read it (ctx.filter, built for topic:read) and it is not retired - else
    it is skipped (id None), and nothing says whether it exists at a level the caller cannot see. Nothing existing is
    changed, except that a topic still without its search vector (an earlier, interrupted run) gets it now.
    Returns, per entry, {key, id, created}; the API links the job roles."""
    where, params = _readable(ctx.filter, ctx.tenant_id)
    out: list[dict[str, Any]] = []
    with db.tenant_tx(ctx.tenant_id) as cur:
        for entry in entries:
            cur.execute(
                """INSERT INTO topics (tenant_id, name, description, sensitivity, origin, status, created_by_card_id)
                   VALUES (%s, %s, %s, 0, 'admin', 'active', %s) ON CONFLICT (tenant_id, lower(name)) DO NOTHING RETURNING id::text AS id""",
                (ctx.tenant_id, entry["name"], entry["description"], ctx.card_id))
            made = cur.fetchone()
            if made is not None:
                embed_topic(cur, ctx.tenant_id, made["id"], embedder)
                out.append({"key": entry["key"], "id": made["id"], "created": True})
                continue
            cur.execute(f"""SELECT tp.id::text AS id, tp.embedding IS NOT NULL AS embedded FROM topics tp
                             WHERE tp.tenant_id = %s AND lower(tp.name) = lower(%s) AND tp.status <> 'retired' AND {where}""",
                        [ctx.tenant_id, entry["name"], *params])
            have = cur.fetchone()
            if have is not None and not have["embedded"]:
                embed_topic(cur, ctx.tenant_id, have["id"], embedder)
            out.append({"key": entry["key"], "id": have["id"] if have else None, "created": False})
    return out


def texts(db: Database, ctx: ServiceContext, topic_ids: list[str]) -> dict[str, dict[str, str]]:
    """The names and descriptions of these topics, for the API's topic list. Only topics the caller may read are named
    (ctx.filter, built for topic:read); unknown ids and ids the caller may not read are simply left out."""
    where, params = _readable(ctx.filter, ctx.tenant_id)
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute(f"""SELECT tp.id::text AS id, tp.name, tp.description FROM topics tp
                         WHERE tp.tenant_id = %s AND tp.id = ANY(%s::uuid[]) AND {where}""",
                    [ctx.tenant_id, list(topic_ids)[:MAX_TEXTS], *params])
        return {r["id"]: {"name": r["name"], "description": r["description"]} for r in cur.fetchall()}


def suggest(db: Database, ctx: ServiceContext, gateway: Gateway, caller: Caller, source_id: str) -> list[str]:
    """Suggestions from the first passages of a source. ctx.approved must contain the source id
    (the API checked source:read for this caller)."""
    if source_id not in ctx.approved:
        raise TopicRefused("not_found", 404)
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute(f"""SELECT {SEALED_COLUMNS} FROM chunks c JOIN sources s ON s.tenant_id = c.tenant_id AND s.id = c.source_id
                         WHERE c.tenant_id = %s AND c.source_id = %s AND c.status = 'active' AND s.status = 'ready'
                         ORDER BY c.ordinal LIMIT %s""", (ctx.tenant_id, source_id, SUGGEST_FROM_CHUNKS))
        texts = Opener(cur, ctx.tenant_id).texts(cur.fetchall())
        cur.execute("SELECT department_id::text AS d, sensitivity FROM sources WHERE tenant_id = %s AND id = %s", (ctx.tenant_id, source_id))
        labels = one(cur)
    if not texts:
        return []
    outcome = gateway.generate(caller, "topic_extract", "topic_extract", [DataBlock(f"PASSAGE_{i + 1}", t) for i, t in enumerate(texts)])
    if not isinstance(outcome.parsed, TopicExtractOutput):
        return []
    created = []
    with db.tenant_tx(ctx.tenant_id) as cur:
        for t in outcome.parsed.topics:
            cur.execute(
                """INSERT INTO topics (tenant_id, name, description, department_id, sensitivity, origin, extracted_from_source_id, status, created_by_card_id)
                   VALUES (%s, %s, %s, %s, %s, 'extracted', %s, 'proposed', %s) ON CONFLICT DO NOTHING RETURNING id::text AS id""",
                (ctx.tenant_id, redact(t.name).text[:120], redact(t.description).text[:500], labels["d"], labels["sensitivity"], source_id,
                 ctx.card_id))
            row = cur.fetchone()
            if row:
                created.append(row["id"])
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="topic:suggest", reason_code="TOPICS_SUGGESTED",
                    resource_type="source", resource_id=source_id, request_id=ctx.request_id, details={"count": len(created)})
    return created
