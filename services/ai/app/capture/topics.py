"""Topic list support (feature 10; docs/phase2/05 §5). The list itself is the company's: an admin
creates, renames and accepts topics through the API (the database lets this service only PROPOSE
topics and set embeddings). Here: the embedding of a topic, and suggestions from a document the
caller may read - `proposed`, counting for nothing until accepted.
"""

from __future__ import annotations

from typing import Any

import psycopg
from pgvector import HalfVector

from app.ai_gateway import Caller, DataBlock, Embedder, Gateway, TopicExtractOutput
from app.capture.redaction import redact
from app.platform import Database, ServiceContext, one, write_audit

SUGGEST_FROM_CHUNKS = 6


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
    """After the API created or renamed a topic: compute its embedding (the only topic columns this login may change)."""
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute("SELECT 1 FROM topics WHERE tenant_id = %s AND id = %s", (ctx.tenant_id, topic_id))
        if cur.fetchone() is None:
            raise TopicRefused("not_found", 404)
        embed_topic(cur, ctx.tenant_id, topic_id, embedder)


def suggest(db: Database, ctx: ServiceContext, gateway: Gateway, caller: Caller, source_id: str) -> list[str]:
    """Suggestions from the first passages of a source. ctx.approved must contain the source id
    (the API checked source:read for this caller)."""
    if source_id not in ctx.approved:
        raise TopicRefused("not_found", 404)
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute("""SELECT c.text FROM chunks c JOIN sources s ON s.tenant_id = c.tenant_id AND s.id = c.source_id
                        WHERE c.tenant_id = %s AND c.source_id = %s AND c.status = 'active' AND s.status = 'ready'
                        ORDER BY c.ordinal LIMIT %s""", (ctx.tenant_id, source_id, SUGGEST_FROM_CHUNKS))
        texts = [r["text"] for r in cur.fetchall()]
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
