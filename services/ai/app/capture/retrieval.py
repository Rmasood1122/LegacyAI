"""Retrieval (feature 17, docs/phase2/03): keyword + vector search and the access filter in ONE
SQL statement. Both searches read only from `visible`, which already contains the filter.
No vector index and no keyword index: an exact scan of one company's visible rows.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import psycopg
from pgvector import HalfVector

from app.ai_gateway import Embedder
from app.capture.filters import condition

CANDIDATES = 12


@dataclass(frozen=True)
class Candidate:
    id: str
    kind: str
    source_id: str | None
    knowledge_item_id: str | None
    verification_status: str
    score: float
    similarity: float


def retrieve(cur: psycopg.Cursor[Any], *, tenant_id: str, spec: Any, question: str, embedder: Embedder,
             contributor_person_id: str | None = None, items_only: bool = False, limit: int = CANDIDATES) -> list[Candidate]:
    where, params = condition(spec, "chunks", tenant_id)
    if where == "FALSE":
        return []
    extra = ""
    extra_params: list[Any] = []
    if contributor_person_id is not None:   # ask-the-expert narrows further; it can never widen the filter
        extra += " AND c.owner_person_id = %s"
        extra_params.append(contributor_person_id)
    if items_only:
        extra += " AND c.kind = 'item' AND c.verification_status IN ('verified', 'corrected')"
    vector = HalfVector(embedder.embed([question], "query")[0])
    sql = f"""
        WITH visible AS MATERIALIZED (
            SELECT c.id, c.kind, c.text, c.embedding, c.source_id, c.knowledge_item_id, c.verification_status
              FROM chunks c
             WHERE c.tenant_id = %s AND c.status = 'active' AND c.embedding_model = %s
               AND {where}{extra}
        ),
        semantic AS (
            SELECT id, RANK() OVER (ORDER BY embedding <=> %s) AS r
              FROM visible ORDER BY embedding <=> %s LIMIT 20
        ),
        keyword AS (
            SELECT v.id, RANK() OVER (ORDER BY ts_rank_cd(to_tsvector('english', v.text), q) DESC) AS r
              FROM visible v, websearch_to_tsquery('english', %s) q
             WHERE to_tsvector('english', v.text) @@ q
             ORDER BY ts_rank_cd(to_tsvector('english', v.text), q) DESC LIMIT 20
        )
        SELECT v.id::text AS id, v.kind, v.source_id::text AS source_id, v.knowledge_item_id::text AS knowledge_item_id,
               v.verification_status,
               COALESCE(1.0 / (60 + s.r), 0) + COALESCE(1.0 / (60 + k.r), 0) AS score,
               1 - (v.embedding <=> %s) AS similarity
          FROM visible v LEFT JOIN semantic s USING (id) LEFT JOIN keyword k USING (id)
         WHERE s.id IS NOT NULL OR k.id IS NOT NULL
         ORDER BY score DESC, (v.verification_status IN ('verified', 'corrected')) DESC, v.id
         LIMIT %s"""
    cur.execute(sql, [tenant_id, embedder.model_id, *params, *extra_params, vector, vector, question, vector, limit])
    return [Candidate(id=r["id"], kind=r["kind"], source_id=r["source_id"], knowledge_item_id=r["knowledge_item_id"],
                      verification_status=r["verification_status"], score=float(r["score"]), similarity=float(r["similarity"]))
            for r in cur.fetchall()]


def load_approved(cur: psycopg.Cursor[Any], *, tenant_id: str, spec: Any, approved_ids: list[str],
                  question_vector: list[float] | None = None) -> list[dict[str, Any]]:
    """Loads the text of chunks the API approved for this request - again under the filter.
    With a question vector, each row also carries its similarity to the question."""
    if not approved_ids:
        return []
    where, params = condition(spec, "chunks", tenant_id)
    if where == "FALSE":
        return []
    sim_sql = "1 - (c.embedding <=> %s)" if question_vector is not None else "NULL::float8"
    sim_params: list[Any] = [HalfVector(question_vector)] if question_vector is not None else []
    cur.execute(
        f"""SELECT c.id::text AS id, c.kind, c.text, c.source_id::text AS source_id, c.knowledge_item_id::text AS knowledge_item_id,
                   c.verification_status, c.owner_person_id::text AS owner_person_id, c.page_from, c.page_to,
                   {sim_sql} AS similarity
              FROM chunks c
             WHERE c.tenant_id = %s AND c.status = 'active' AND c.id = ANY(%s::uuid[]) AND {where}""",
        [*sim_params, tenant_id, approved_ids, *params])
    rows = cur.fetchall()
    order = {cid: i for i, cid in enumerate(approved_ids)}
    return sorted(rows, key=lambda r: order.get(r["id"], 1_000_000))
