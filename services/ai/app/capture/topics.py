"""Topic list support (feature 10; docs/phase2/05 §5). The list itself is the company's: an admin
creates, renames, accepts and retires topics through the API, which checks their right to and sends
the request here (decision D41, step 6 part 4b: topic names and descriptions are written and read only
by this service, so they can be stored sealed). Here also: the embedding of a topic, and suggestions
from a document the caller may read - `proposed`, counting for nothing until accepted.

Names and descriptions are stored sealed (step 6 part 4b), bound to "topic:<id>"; a name is unique per company in any
case, checked against readable rows and against the keyed fingerprints of sealed ones (sealed_chunks.topic_name_match)
while one writer at a time holds the company's topic-name lock.
"""

from __future__ import annotations

from typing import Any

import psycopg
from pgvector import HalfVector

from app.ai_gateway import Caller, DataBlock, Embedder, Gateway, TopicExtractOutput
from app.capture.filters import topic_condition
from app.capture.redaction import redact
from app.capture.sealed_chunks import (
    SEALED_COLUMNS,
    Fields,
    Opener,
    lock_topic_names,
    new_row_id,
    open_topic,
    seal_topic,
    topic_name_match,
    topic_text_columns,
)
from app.platform import Database, ServiceContext, one, write_audit

SUGGEST_FROM_CHUNKS = 6
MAX_TEXTS = 100
# The topic as the API shows it (KTopic in openapi.yaml).
TOPIC_ROW = f"""tp.id::text AS id, {topic_text_columns("tp")}, tp.department_id::text AS department_id, tp.sensitivity, tp.origin,
               tp.status, tp.created_at"""
# The status changes a person may make: accept a proposal, retire an active topic (or leave it as it is).
_MOVES = {("proposed", "active"), ("active", "retired")}


def embed_topic(cur: psycopg.Cursor[Any], tenant_id: str, topic_id: str, embedder: Embedder) -> None:
    cur.execute(f"SELECT tp.id::text AS id, {topic_text_columns('tp')} FROM topics tp WHERE tp.tenant_id = %s AND tp.id = %s", (tenant_id, topic_id))
    row = cur.fetchone()
    if row is None:
        return
    t = open_topic(Fields(cur, tenant_id, "topics"), dict(row))
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


def _public(fields: Fields, row: dict[str, Any]) -> dict[str, Any]:
    opened = open_topic(fields, dict(row))
    return {**opened, "created_at": opened["created_at"].isoformat()}


_COLUMNS = ("name", "name_sealed", "description", "description_sealed", "sealed_key", "name_hash")


def _add(cur: psycopg.Cursor[Any], fields: Fields, values: dict[str, Any]) -> str | None:
    """Inserts a topic with its name and description sealed. None = a topic of that name (any case) exists already.
    The caller holds the company's topic-name lock. `values`: the other columns."""
    where, params = topic_name_match(fields, values["name"])
    cur.execute(f"SELECT 1 FROM topics tp WHERE tp.tenant_id = %s AND {where}", [fields.tenant_id, *params])
    if cur.fetchone() is not None:
        return None
    topic_id = new_row_id(cur)
    texts = seal_topic(fields, topic_id, values.pop("name"), values.pop("description"))
    columns = {"id": topic_id, "tenant_id": fields.tenant_id, **values, **texts}
    cur.execute(f"INSERT INTO topics ({', '.join(columns)}) VALUES ({', '.join(['%s'] * len(columns))})", list(columns.values()))
    return topic_id


def create(db: Database, ctx: ServiceContext, embedder: Embedder, *, name: str, description: str, department_id: str | None,
           sensitivity: int) -> dict[str, Any]:
    """An active topic made by a person (the API checked topic:write for them). Its search vector is computed in the
    same step, so a topic never exists without one. A topic of the same name (any case) -> 409 duplicate_topic."""
    with db.tenant_tx(ctx.tenant_id) as cur:
        lock_topic_names(cur, ctx.tenant_id)
        fields = Fields(cur, ctx.tenant_id, "topics")
        topic_id = _add(cur, fields, {"name": name, "description": description, "department_id": department_id, "sensitivity": sensitivity,
                                      "origin": "admin", "status": "active", "created_by_card_id": ctx.card_id})
        if topic_id is None:
            raise TopicRefused("duplicate_topic")
        embed_topic(cur, ctx.tenant_id, topic_id, embedder)
        cur.execute(f"SELECT {TOPIC_ROW} FROM topics tp WHERE tp.tenant_id = %s AND tp.id = %s", (ctx.tenant_id, topic_id))
        return _public(fields, one(cur))


def update(db: Database, ctx: ServiceContext, embedder: Embedder, topic_id: str, *, name: str | None, description: str | None,
           status: str | None) -> dict[str, Any]:
    """Renames, re-describes, accepts or retires a topic (the API checked topic:write on it). New words are sealed
    (both name and description, with the company's current key); an active topic gets its search vector again."""
    with db.tenant_tx(ctx.tenant_id) as cur:
        lock_topic_names(cur, ctx.tenant_id)
        fields = Fields(cur, ctx.tenant_id, "topics")
        cur.execute(f"SELECT {TOPIC_ROW} FROM topics tp WHERE tp.tenant_id = %s AND tp.id = %s FOR UPDATE", (ctx.tenant_id, topic_id))
        found = cur.fetchone()
        if found is None:
            raise TopicRefused("not_found", 404)
        before = open_topic(fields, dict(found))
        if status is not None and status != before["status"] and (before["status"], status) not in _MOVES:
            raise TopicRefused("illegal_transition")
        if name is not None or description is not None:
            new_name = name if name is not None else before["name"]
            if new_name.lower() != before["name"].lower():
                where, params = topic_name_match(fields, new_name)
                cur.execute(f"SELECT 1 FROM topics tp WHERE tp.tenant_id = %s AND tp.id <> %s AND {where}", [ctx.tenant_id, topic_id, *params])
                if cur.fetchone() is not None:
                    raise TopicRefused("duplicate_topic")
            texts = seal_topic(fields, topic_id, new_name, description if description is not None else before["description"])
            cur.execute(f"UPDATE topics SET {', '.join(f'{c} = %s' for c in _COLUMNS)} WHERE tenant_id = %s AND id = %s",
                        [*(texts[c] for c in _COLUMNS), ctx.tenant_id, topic_id])
        if status is not None:
            cur.execute("UPDATE topics SET status = %s WHERE tenant_id = %s AND id = %s", (status, ctx.tenant_id, topic_id))
        cur.execute(f"SELECT {TOPIC_ROW} FROM topics tp WHERE tp.tenant_id = %s AND tp.id = %s", (ctx.tenant_id, topic_id))
        row = one(cur)
        if row["status"] == "active":
            embed_topic(cur, ctx.tenant_id, topic_id, embedder)
        return _public(fields, row)


def apply_template(db: Database, ctx: ServiceContext, embedder: Embedder, entries: list[dict[str, str]]) -> list[dict[str, Any]]:
    """The topics of a department template (feature 26): each is ADDED if no topic of its name exists; otherwise the
    existing one is used only if the caller may read it (ctx.filter, built for topic:read) and it is not retired - else
    it is skipped (id None), and nothing says whether it exists at a level the caller cannot see. Nothing existing is
    changed, except that a topic still without its search vector (an earlier, interrupted run) gets it now.
    Returns, per entry, {key, id, created}; the API links the job roles."""
    where, params = topic_condition(ctx.filter, ctx.tenant_id)
    out: list[dict[str, Any]] = []
    with db.tenant_tx(ctx.tenant_id) as cur:
        lock_topic_names(cur, ctx.tenant_id)
        fields = Fields(cur, ctx.tenant_id, "topics")
        for entry in entries:
            made = _add(cur, fields, {"name": entry["name"], "description": entry["description"], "sensitivity": 0, "origin": "admin",
                                      "status": "active", "created_by_card_id": ctx.card_id})
            if made is not None:
                embed_topic(cur, ctx.tenant_id, made, embedder)
                out.append({"key": entry["key"], "id": made, "created": True})
                continue
            named, named_params = topic_name_match(fields, entry["name"])
            cur.execute(f"""SELECT tp.id::text AS id, tp.embedding IS NOT NULL AS embedded FROM topics tp
                             WHERE tp.tenant_id = %s AND {named} AND tp.status <> 'retired' AND {where}""",
                        [ctx.tenant_id, *named_params, *params])
            have = cur.fetchone()
            if have is not None and not have["embedded"]:
                embed_topic(cur, ctx.tenant_id, have["id"], embedder)
            out.append({"key": entry["key"], "id": have["id"] if have else None, "created": False})
    return out


def texts(db: Database, ctx: ServiceContext, topic_ids: list[str]) -> dict[str, dict[str, str]]:
    """The names and descriptions of these topics, for the API's topic list. Only topics the caller may read are named
    (ctx.filter, built for topic:read; "verified only" does not apply to topics, as in the API's own topic filter);
    unknown ids and ids the caller may not read are simply left out."""
    where, params = topic_condition(ctx.filter, ctx.tenant_id)
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute(f"""SELECT tp.id::text AS id, {topic_text_columns("tp")} FROM topics tp
                         WHERE tp.tenant_id = %s AND tp.id = ANY(%s::uuid[]) AND {where}""",
                    [ctx.tenant_id, list(topic_ids)[:MAX_TEXTS], *params])
        fields = Fields(cur, ctx.tenant_id, "topics")
        return {r["id"]: {"name": t["name"], "description": t["description"]} for r in cur.fetchall() for t in [open_topic(fields, dict(r))]}


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
        lock_topic_names(cur, ctx.tenant_id)
        fields = Fields(cur, ctx.tenant_id, "topics")
        for t in outcome.parsed.topics:
            name = redact(t.name).text[:120]
            if not name:
                continue
            made = _add(cur, fields, {"name": name, "description": redact(t.description).text[:500], "department_id": labels["d"],
                                      "sensitivity": labels["sensitivity"], "origin": "extracted", "extracted_from_source_id": source_id,
                                      "status": "proposed", "created_by_card_id": ctx.card_id})
            if made is not None:
                created.append(made)
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="topic:suggest", reason_code="TOPICS_SUGGESTED",
                    resource_type="source", resource_id=source_id, request_id=ctx.request_id, details={"count": len(created)})
    return created
