"""Knowledge items and the verification loop (feature 12; docs/phase2/06 §1).

Every state change goes through `_move()`, which the database trigger double-checks (legal
moves; "corrected" only for a corrected version; the verifier is neither the contributor nor the
author of the current version while the company requires a second reviewer).

A verified or corrected item gets a search copy (a `chunks` row of kind 'item'); the copy is
removed when the item leaves that status and marked stale when the item goes stale. Only
verified items are searchable as items.
"""

from __future__ import annotations

import hashlib
from typing import Any

import psycopg
from pgvector import HalfVector

from app.ai_gateway import Caller, DataBlock, Embedder, Gateway, ItemExtractOutput
from app.capture import consent_family, redact, topic_condition
from app.knowledge import item_conflicts, scenario_erasure
from app.platform import Database, ServiceContext, one, write_audit

BODY_MAX = 2000


class ItemRefused(Exception):
    def __init__(self, code: str, status: int = 409) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


def _settings(cur: psycopg.Cursor[Any], tenant_id: str) -> dict[str, Any]:
    cur.execute("SELECT second_reviewer_required, stale_after_days, review_sla_days FROM knowledge_settings WHERE tenant_id = %s", (tenant_id,))
    row = cur.fetchone()
    return dict(row) if row else {"second_reviewer_required": True, "stale_after_days": 365, "review_sla_days": 5}


review_settings = _settings      # the public name, for the other modules of this package


def _item(cur: psycopg.Cursor[Any], tenant_id: str, item_id: str, lock: bool = True) -> dict[str, Any]:
    cur.execute(
        f"""SELECT i.id::text AS id, i.status, i.title, i.origin, i.department_id::text AS department_id, i.sensitivity,
                   i.owner_person_id::text AS owner_person_id, i.current_version_id::text AS current_version_id,
                   v.body, v.change_kind, v.version_no, v.author_person_id::text AS author_person_id
              FROM knowledge_items i LEFT JOIN knowledge_versions v ON v.tenant_id = i.tenant_id AND v.id = i.current_version_id
             WHERE i.tenant_id = %s AND i.id = %s{' FOR UPDATE OF i' if lock else ''}""", (tenant_id, item_id))
    row = cur.fetchone()
    if row is None:
        raise ItemRefused("not_found", 404)
    return dict(row)


def create_item(cur: psycopg.Cursor[Any], *, tenant_id: str, title: str, body: str, origin: str, ai_extracted: bool,
                department_id: str | None, sensitivity: int, owner_person_id: str | None, consent_id: str | None,
                created_by_card_id: str | None, author_card_id: str | None, author_person_id: str | None,
                change_kind: str, provenance: list[tuple[str, int, int, bytes]], prompt_version: str | None = None,
                review_sla_days: int = 5) -> str:
    """Creates a candidate with its first version and provenance. Caller passes REDACTED text.
    provenance: (chunk_id, quote_start, quote_end, quote_sha256). The item's sensitivity is raised to
    the highest of its provenance before the citations are written (the database refuses otherwise)."""
    if provenance:
        cur.execute("SELECT COALESCE(max(sensitivity), 0) AS s FROM chunks WHERE tenant_id = %s AND id = ANY(%s::uuid[])",
                    (tenant_id, [p[0] for p in provenance]))
        sensitivity = max(sensitivity, int(one(cur)["s"]))
    cur.execute(
        """INSERT INTO knowledge_items (tenant_id, title, origin, ai_extracted, department_id, sensitivity, owner_person_id, consent_id,
                                        created_by_card_id)
           VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id::text AS id""",
        (tenant_id, (title or "Untitled")[:200], origin, ai_extracted, department_id, sensitivity, owner_person_id, consent_id, created_by_card_id))
    item_id = one(cur)["id"]
    cur.execute(
        """INSERT INTO knowledge_versions (tenant_id, item_id, version_no, body, change_kind, author_card_id, author_person_id, prompt_version)
           VALUES (%s, %s, 1, %s, %s, %s, %s, %s) RETURNING id::text AS id""",
        (tenant_id, item_id, body[:BODY_MAX], change_kind, author_card_id, author_person_id, prompt_version))
    version_id = one(cur)["id"]
    cur.execute("UPDATE knowledge_items SET current_version_id = %s WHERE tenant_id = %s AND id = %s", (version_id, tenant_id, item_id))
    for chunk_id, start, end, digest in provenance:
        cur.execute(
            """INSERT INTO citations (tenant_id, subject_type, subject_id, chunk_id, quote_start, quote_end, quote_sha256)
               VALUES (%s, 'knowledge_version', %s, %s, %s, %s, %s)""", (tenant_id, version_id, chunk_id, start, end, digest))
    if ai_extracted:   # AI-extracted candidates go straight to review
        _move(cur, tenant_id, item_id, "in_review", None)
        _task(cur, tenant_id, item_id, "verify_item", review_sla_days)
    return str(item_id)


def _task(cur: psycopg.Cursor[Any], tenant_id: str, item_id: str, kind: str, sla_days: int) -> None:
    cur.execute(
        """INSERT INTO review_tasks (tenant_id, kind, subject_type, subject_id, department_id, sensitivity, owner_person_id, priority, due_at)
           SELECT tenant_id, %s, 'knowledge_item', id, department_id, sensitivity, owner_person_id, usage_count, now() + make_interval(days => %s)
             FROM knowledge_items WHERE tenant_id = %s AND id = %s
           ON CONFLICT DO NOTHING""", (kind, sla_days, tenant_id, item_id))


def _resolve_tasks(cur: psycopg.Cursor[Any], tenant_id: str, item_id: str, card_id: str | None, resolution: str) -> None:
    cur.execute(
        """UPDATE review_tasks SET status = 'resolved', resolved_at = now(), resolved_by_card_id = %s, resolution = %s,
                  assigned_to_card_id = NULL, first_response_at = COALESCE(first_response_at, now())
            WHERE tenant_id = %s AND subject_type = 'knowledge_item' AND subject_id = %s AND status IN ('open', 'assigned')""",
        (card_id, resolution, tenant_id, item_id))


def _move(cur: psycopg.Cursor[Any], tenant_id: str, item_id: str, status: str, verifier_card: str | None) -> None:
    if status in ("verified", "corrected"):
        cur.execute(
            """UPDATE knowledge_items SET status = %s, verified_by_card_id = %s, verified_at = now(),
                      stale_after = now() + make_interval(days => COALESCE((SELECT stale_after_days FROM knowledge_settings WHERE tenant_id = %s), 365))
                WHERE tenant_id = %s AND id = %s""", (status, verifier_card, tenant_id, tenant_id, item_id))
    else:
        cur.execute("UPDATE knowledge_items SET status = %s WHERE tenant_id = %s AND id = %s", (status, tenant_id, item_id))
        # The ONE place an item leaves the verified state: whatever the reason, it is no longer a verified statement,
        # so its conflicts with other items end here (feature 23). Callers do not have to remember it.
        item_conflicts.clear(cur, tenant_id, item_id)


def _search_copy(cur: psycopg.Cursor[Any], tenant_id: str, item: dict[str, Any], status: str, embedder: Embedder) -> None:
    """Keep the item's chunk in step with its status: present while verified/corrected/stale, gone otherwise."""
    if status in ("verified", "corrected"):
        vector = HalfVector(embedder.embed([item["body"]], "document")[0])
        cur.execute(
            """INSERT INTO chunks (tenant_id, kind, knowledge_item_id, ordinal, text, token_estimate, embedding, embedding_model,
                                   department_id, sensitivity, owner_person_id, verification_status, status)
               VALUES (%s, 'item', %s, 0, %s, %s, %s, %s, %s, %s, %s, %s, 'active')
               ON CONFLICT (tenant_id, knowledge_item_id) WHERE knowledge_item_id IS NOT NULL
               DO UPDATE SET text = EXCLUDED.text, token_estimate = EXCLUDED.token_estimate, embedding = EXCLUDED.embedding,
                             embedding_model = EXCLUDED.embedding_model, verification_status = EXCLUDED.verification_status""",
            (tenant_id, item["id"], item["body"], max(1, len(item["body"]) // 4), vector, embedder.model_id, item["department_id"],
             item["sensitivity"], item["owner_person_id"], status))
    elif status == "stale":
        cur.execute("UPDATE chunks SET verification_status = 'stale' WHERE tenant_id = %s AND knowledge_item_id = %s", (tenant_id, item["id"]))
    else:
        cur.execute("DELETE FROM chunks WHERE tenant_id = %s AND knowledge_item_id = %s", (tenant_id, item["id"]))


def _audit(cur: psycopg.Cursor[Any], ctx: ServiceContext, item_id: str, action: str, reason: str, version_no: int | None = None) -> None:
    write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action=action, reason_code=reason, resource_type="knowledge_item",
                resource_id=item_id, request_id=ctx.request_id, details={"item_id": item_id, **({"version_no": version_no} if version_no else {})})


def write_manual(db: Database, ctx: ServiceContext, *, title: str, body: str, department_id: str | None, sensitivity: int,
                 contributor_person_id: str | None) -> str:
    with db.tenant_tx(ctx.tenant_id) as cur:
        consent_id = None
        if contributor_person_id is not None:
            cur.execute("""SELECT id::text AS id FROM consents WHERE tenant_id = %s AND person_id = %s AND scope = 'own_words'
                             AND withdrawn_at IS NULL AND superseded_at IS NULL AND (expires_at IS NULL OR expires_at > now())""",
                        (ctx.tenant_id, contributor_person_id))
            row = cur.fetchone()
            if row is None:
                raise ItemRefused("consent_missing", 422)
            consent_id = row["id"]
        item_id = create_item(cur, tenant_id=ctx.tenant_id, title=redact(title).text, body=redact(body).text, origin="manual",
                              ai_extracted=False, department_id=department_id, sensitivity=sensitivity, owner_person_id=contributor_person_id,
                              consent_id=consent_id, created_by_card_id=ctx.card_id, author_card_id=ctx.card_id, author_person_id=ctx.person_id,
                              change_kind="written", provenance=[])
        _audit(cur, ctx, item_id, "knowledge:item_written", "ITEM_WRITTEN")
    return item_id


def submit(db: Database, ctx: ServiceContext, item_id: str) -> None:
    with db.tenant_tx(ctx.tenant_id) as cur:
        item = _item(cur, ctx.tenant_id, item_id)
        if item["status"] != "candidate":
            raise ItemRefused("illegal_transition")
        _move(cur, ctx.tenant_id, item_id, "in_review", None)
        _task(cur, ctx.tenant_id, item_id, "verify_item", _settings(cur, ctx.tenant_id)["review_sla_days"])
        _audit(cur, ctx, item_id, "knowledge:submit", "ITEM_SUBMITTED")


def propose_version(db: Database, ctx: ServiceContext, item_id: str, body: str) -> int:
    """A corrected text, by a reviewer or by the contributor. It verifies nothing: the item is (back) in review."""
    with db.tenant_tx(ctx.tenant_id) as cur:
        item = _item(cur, ctx.tenant_id, item_id)
        if item["status"] in ("withdrawn",):
            raise ItemRefused("illegal_transition")
        cur.execute("SELECT max(version_no) AS n FROM knowledge_versions WHERE tenant_id = %s AND item_id = %s", (ctx.tenant_id, item_id))
        version_no = int(one(cur)["n"]) + 1
        cur.execute(
            """INSERT INTO knowledge_versions (tenant_id, item_id, version_no, body, change_kind, author_card_id, author_person_id)
               VALUES (%s, %s, %s, %s, 'corrected', %s, %s) RETURNING id::text AS id""",
            (ctx.tenant_id, item_id, version_no, redact(body).text[:BODY_MAX], ctx.card_id, ctx.person_id))
        version_id = one(cur)["id"]
        cur.execute("UPDATE knowledge_items SET current_version_id = %s WHERE tenant_id = %s AND id = %s", (version_id, ctx.tenant_id, item_id))
        if item["status"] != "in_review":
            if item["status"] == "candidate":
                _move(cur, ctx.tenant_id, item_id, "in_review", None)
            else:
                _move(cur, ctx.tenant_id, item_id, "in_review", None)
            _search_copy(cur, ctx.tenant_id, item, "in_review", _NO_EMBEDDER)
        _task(cur, ctx.tenant_id, item_id, "verify_item", _settings(cur, ctx.tenant_id)["review_sla_days"])
        _audit(cur, ctx, item_id, "knowledge:propose_version", "VERSION_PROPOSED", version_no)
        return version_no


class _NoEmbedder:
    model_id = "none"
    relevance_threshold = 1.0

    def embed(self, texts: list[str], kind: str) -> list[list[float]]:  # pragma: no cover - never called for removals
        raise AssertionError("not used")


_NO_EMBEDDER: Embedder = _NoEmbedder()


def verify(db: Database, ctx: ServiceContext, item_id: str, embedder: Embedder) -> str:
    """in_review -> verified (original text) or corrected (a corrected version). The database refuses
    a verifier who is the contributor or the author of the current version (while required)."""
    with db.tenant_tx(ctx.tenant_id) as cur:
        item = _item(cur, ctx.tenant_id, item_id)
        if item["status"] != "in_review":
            raise ItemRefused("illegal_transition")
        status = "corrected" if item["change_kind"] == "corrected" else "verified"
        try:
            _move(cur, ctx.tenant_id, item_id, status, ctx.card_id)
        except psycopg.errors.InsufficientPrivilege as exc:
            raise ItemRefused("self_review", 403) from exc
        _search_copy(cur, ctx.tenant_id, item, status, embedder)
        _resolve_tasks(cur, ctx.tenant_id, item_id, ctx.card_id, status)
        # after the item's own tasks are closed: a conflict with another verified item opens a new one (feature 23)
        item_conflicts.sync(cur, ctx.tenant_id, item_id)
        _audit(cur, ctx, item_id, f"knowledge:{status}", f"ITEM_{status.upper()}", int(item["version_no"]))
        return status


def reject(db: Database, ctx: ServiceContext, item_id: str) -> None:
    with db.tenant_tx(ctx.tenant_id) as cur:
        item = _item(cur, ctx.tenant_id, item_id)
        if item["status"] not in ("candidate", "in_review", "stale"):
            raise ItemRefused("illegal_transition")
        if item["status"] == "candidate" and item["owner_person_id"] != ctx.person_id:
            raise ItemRefused("illegal_transition")   # a draft is discarded by its contributor
        _move(cur, ctx.tenant_id, item_id, "rejected", None)
        _search_copy(cur, ctx.tenant_id, item, "rejected", _NO_EMBEDDER)
        _resolve_tasks(cur, ctx.tenant_id, item_id, ctx.card_id, "rejected")
        cur.execute("UPDATE quiz_items SET status = 'retired' WHERE tenant_id = %s AND knowledge_item_id = %s AND status <> 'retired'",
                    (ctx.tenant_id, item_id))
        _audit(cur, ctx, item_id, "knowledge:reject", "ITEM_REJECTED")


def reopen(db: Database, ctx: ServiceContext, item_id: str, rollback_to_version: int | None = None) -> None:
    with db.tenant_tx(ctx.tenant_id) as cur:
        item = _item(cur, ctx.tenant_id, item_id)
        if item["status"] not in ("verified", "corrected", "stale", "rejected"):
            raise ItemRefused("illegal_transition")
        if rollback_to_version is not None:
            cur.execute("SELECT id::text AS id FROM knowledge_versions WHERE tenant_id = %s AND item_id = %s AND version_no = %s AND erased_at IS NULL",
                        (ctx.tenant_id, item_id, rollback_to_version))
            row = cur.fetchone()
            if row is None:
                raise ItemRefused("no_such_version", 404)
            cur.execute("UPDATE knowledge_items SET current_version_id = %s WHERE tenant_id = %s AND id = %s", (row["id"], ctx.tenant_id, item_id))
        _move(cur, ctx.tenant_id, item_id, "in_review", None)
        _search_copy(cur, ctx.tenant_id, item, "in_review", _NO_EMBEDDER)
        cur.execute("UPDATE quiz_items SET status = 'retired' WHERE tenant_id = %s AND knowledge_item_id = %s AND status <> 'retired'",
                    (ctx.tenant_id, item_id))
        _task(cur, ctx.tenant_id, item_id, "verify_item", _settings(cur, ctx.tenant_id)["review_sla_days"])
        _audit(cur, ctx, item_id, "knowledge:reopen", "ITEM_REOPENED")


def retire(db: Database, ctx: ServiceContext, item_id: str) -> None:
    with db.tenant_tx(ctx.tenant_id) as cur:
        item = _item(cur, ctx.tenant_id, item_id)
        if item["status"] != "stale":
            raise ItemRefused("illegal_transition")
        _move(cur, ctx.tenant_id, item_id, "rejected", None)
        _search_copy(cur, ctx.tenant_id, item, "rejected", _NO_EMBEDDER)
        _resolve_tasks(cur, ctx.tenant_id, item_id, ctx.card_id, "retired")
        _audit(cur, ctx, item_id, "knowledge:retire", "ITEM_RETIRED")


def revert_verifications(db: Database, ctx: ServiceContext, verifier_card_id: str, since: str, until: str) -> int:
    """Owner's clean-up after a bad reviewer: reopen everything that card verified in the window, and
    roll corrections that card made back to the version before them."""
    count = 0
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute(
            """SELECT id::text AS id FROM knowledge_items WHERE tenant_id = %s AND verified_by_card_id = %s
                  AND verified_at BETWEEN %s::timestamptz AND %s::timestamptz AND status IN ('verified', 'corrected', 'stale') FOR UPDATE""",
            (ctx.tenant_id, verifier_card_id, since, until))
        ids = [r["id"] for r in cur.fetchall()]
        cur.execute(
            """SELECT DISTINCT item_id::text AS item_id FROM knowledge_versions WHERE tenant_id = %s AND author_card_id = %s
                  AND change_kind = 'corrected' AND created_at BETWEEN %s::timestamptz AND %s::timestamptz""", (ctx.tenant_id, verifier_card_id, since, until))
        corrected_by_them = {r["item_id"] for r in cur.fetchall()}
        for item_id in ids + [i for i in corrected_by_them if i not in ids]:
            item = _item(cur, ctx.tenant_id, item_id)
            if item_id in corrected_by_them:
                cur.execute(
                    """SELECT id::text AS id FROM knowledge_versions WHERE tenant_id = %s AND item_id = %s AND erased_at IS NULL
                          AND NOT (author_card_id = %s AND change_kind = 'corrected') ORDER BY version_no DESC LIMIT 1""",
                    (ctx.tenant_id, item_id, verifier_card_id))
                prev = cur.fetchone()
                if prev is not None:
                    cur.execute("UPDATE knowledge_items SET current_version_id = %s WHERE tenant_id = %s AND id = %s",
                                (prev["id"], ctx.tenant_id, item_id))
            if item["status"] in ("verified", "corrected", "stale", "rejected"):
                _move(cur, ctx.tenant_id, item_id, "in_review", None)
                _search_copy(cur, ctx.tenant_id, item, "in_review", _NO_EMBEDDER)
                _task(cur, ctx.tenant_id, item_id, "verify_item", 5)
            count += 1
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="knowledge:revert", reason_code="VERIFICATIONS_REVERTED",
                    request_id=ctx.request_id, details={"count": count})
    return count


def relabel(db: Database, ctx: ServiceContext, kind: str, target_id: str, department_id: str | None, sensitivity: int) -> int:
    with db.tenant_tx(ctx.tenant_id) as cur:
        table = "sources" if kind == "source" else "knowledge_items"
        cur.execute(f"SELECT department_id::text AS d, sensitivity FROM {table} WHERE tenant_id = %s AND id = %s FOR UPDATE",
                    (ctx.tenant_id, target_id))
        before = cur.fetchone()
        if before is None:
            raise ItemRefused("not_found", 404)
        cur.execute("SELECT relabel(%s, %s, %s, %s::smallint) AS n", ("source" if kind == "source" else "item", target_id, department_id, sensitivity))
        n = int(one(cur)["n"])
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="knowledge:label", reason_code="LABELS_CHANGED",
                    resource_type=kind, resource_id=target_id, request_id=ctx.request_id,
                    details={"sensitivity_from": int(before["sensitivity"]), "sensitivity_to": sensitivity,
                             "department_from": before["d"], "department_to": department_id, "count": n})
    return n


MAX_TOPICS_PER_ITEM = 20


def set_topics(db: Database, ctx: ServiceContext, item_id: str, topic_ids: list[str]) -> list[dict[str, Any]]:
    """A reviewer says which topics an item belongs to (docs/phase2/05: "a reviewer can add or remove a link, and
    manual links win").

    The given list is the wanted set among the links THIS reviewer can see: topics it may read (the topic filter in the
    token) that are not retired - exactly what item_topics() returns for it. So:
      - a link that stays is left as it is (its link_source and score are kept: writing back what was read changes nothing);
      - a link that is in the list but does not exist yet is added as a reviewer link, and must be to an ACTIVE topic;
      - a visible link that is not in the list is removed;
      - a link the reviewer cannot see (another department, a higher level, a retired topic) is neither shown nor touched.
    The composite foreign keys make a link to another company's topic impossible."""
    wanted = list(dict.fromkeys(topic_ids))
    if len(wanted) > MAX_TOPICS_PER_ITEM:
        raise ItemRefused("too_many_topics", 422)
    with db.tenant_tx(ctx.tenant_id) as cur:
        item = _item(cur, ctx.tenant_id, item_id)
        if item["status"] == "withdrawn":
            raise ItemRefused("not_found", 404)
        where, params = topic_condition(ctx.topic_filter, ctx.tenant_id)
        before = {t["topic_id"] for t in item_topics(cur, ctx.tenant_id, item_id, where, params)}
        to_add = [t for t in wanted if t not in before]
        to_remove = sorted(before - set(wanted))
        if to_add:
            # active topics of this company that this reviewer may read; anything else is "unknown" (the API checked the same)
            cur.execute(f"SELECT tp.id::text AS id FROM topics tp WHERE tp.tenant_id = %s AND tp.id = ANY(%s::uuid[]) AND tp.status = 'active' AND {where}",
                        [ctx.tenant_id, to_add, *params])
            if {r["id"] for r in cur.fetchall()} != set(to_add):
                raise ItemRefused("unknown_topic", 422)
        if to_remove:
            cur.execute("DELETE FROM knowledge_item_topics WHERE tenant_id = %s AND item_id = %s AND topic_id = ANY(%s::uuid[])",
                        (ctx.tenant_id, item_id, to_remove))
        for topic_id in to_add:
            # a hidden link to the same topic cannot exist (the topic is readable, so its link would be in `before`)
            cur.execute("""INSERT INTO knowledge_item_topics (tenant_id, item_id, topic_id, link_source) VALUES (%s, %s, %s, 'reviewer')
                           ON CONFLICT DO NOTHING""", (ctx.tenant_id, item_id, topic_id))
        _audit_topic_changes(cur, ctx, item_id, wanted=len(wanted), removed=to_remove, added=sorted(to_add))
        if (to_add or to_remove) and item["status"] in ("verified", "corrected"):
            item_conflicts.sync(cur, ctx.tenant_id, item_id)      # topics decide which items are compared with each other
        return item_topics(cur, ctx.tenant_id, item_id, where, params)


def _audit_topic_changes(cur: psycopg.Cursor[Any], ctx: ServiceContext, item_id: str, *, wanted: int, removed: list[str], added: list[str]) -> None:
    """One row for the request, and one per link that was really added or removed (ids only, never names): the log then
    shows WHICH topics an item was put into or taken out of, and by which card."""
    write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="knowledge:label", reason_code="ITEM_TOPICS_SET",
                resource_type="knowledge_item", resource_id=item_id, request_id=ctx.request_id,
                details={"item_id": item_id, "count": wanted})
    for changed, reason, ids in (("removed", "ITEM_TOPIC_UNLINKED", removed), ("added", "ITEM_TOPIC_LINKED", added)):
        for topic_id in ids:
            write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="knowledge:label", reason_code=reason,
                        resource_type="knowledge_item", resource_id=item_id, request_id=ctx.request_id,
                        details={"item_id": item_id, "topic_id": topic_id, "changed": changed})


def item_topics(cur: psycopg.Cursor[Any], tenant_id: str, item_id: str, topic_where: str = "TRUE",
                topic_params: list[Any] | None = None) -> list[dict[str, Any]]:
    """The topics an item is linked to. `topic_where` narrows them to what a reader may see (alias tp).
    A link to a RETIRED topic is left out: it is kept in the database but is neither shown nor changed by set_topics()."""
    cur.execute(
        f"""SELECT kt.topic_id::text AS topic_id, tp.name, kt.link_source
              FROM knowledge_item_topics kt JOIN topics tp ON tp.tenant_id = kt.tenant_id AND tp.id = kt.topic_id
             WHERE kt.tenant_id = %s AND kt.item_id = %s AND tp.status <> 'retired' AND {topic_where} ORDER BY tp.name, kt.topic_id""",
        [tenant_id, item_id, *(topic_params or [])])
    return [dict(r) for r in cur.fetchall()]


def link_item_to_topics(cur: psycopg.Cursor[Any], *, tenant_id: str, item_id: str, item_vector: list[float], embedding_model: str,
                        threshold: float) -> int:
    """Links an item to every active topic whose description is similar enough (code, repeatable).
    Manual links made by a reviewer are never changed here."""
    cur.execute(
        """INSERT INTO knowledge_item_topics (tenant_id, item_id, topic_id, link_source, score)
           SELECT tenant_id, %s, id, 'similarity', 1 - (embedding <=> %s)
             FROM topics WHERE tenant_id = %s AND status = 'active' AND embedding_model = %s AND 1 - (embedding <=> %s) >= %s
           ON CONFLICT DO NOTHING""",
        (item_id, HalfVector(item_vector), tenant_id, embedding_model, HalfVector(item_vector), threshold))
    return cur.rowcount


def candidate_from_answer(cur: psycopg.Cursor[Any], ctx: ServiceContext, *, consent_id: str, chunk_id: str, text: str,
                          embedder: Embedder, gateway: Gateway | None, caller: Caller | None) -> tuple[str | None, int]:
    """Turns an interview answer into a candidate item with provenance. The model may only restate the
    answer; its quote must appear in the answer, otherwise the extraction is not used. Without AI the
    answer itself becomes the item. Returns (item id or None, AI cost)."""
    if len(text.split()) < 8:
        return None, 0
    title, body, quote, ai, cost = " ".join(text.split()[:10]), text, None, False, 0
    if gateway is not None and caller is not None:
        outcome = gateway.generate(caller, "item_extract", "item_extract", [DataBlock("ANSWER", text)])
        cost = outcome.cost_micro_usd
        if isinstance(outcome.parsed, ItemExtractOutput):
            if not outcome.parsed.substantive:
                return None, cost
            title, body, quote, ai = outcome.parsed.title, outcome.parsed.body, outcome.parsed.quote, True
    start, end = 0, min(len(text), 600)
    if quote:
        pos = text.find(quote)
        if pos < 0:
            title, body, ai = " ".join(text.split()[:10]), text, False
        else:
            start, end = pos, pos + len(quote)
    settings = _settings(cur, ctx.tenant_id)
    item_id = create_item(
        cur, tenant_id=ctx.tenant_id, title=redact(title).text, body=redact(body).text, origin="interview", ai_extracted=ai,
        department_id=None, sensitivity=1, owner_person_id=ctx.person_id, consent_id=consent_id, created_by_card_id=ctx.card_id,
        author_card_id=None if ai else ctx.card_id, author_person_id=None if ai else ctx.person_id,
        change_kind="extracted" if ai else "written",
        provenance=[(chunk_id, start, max(end, start + 1), hashlib.sha256(text[start:end].encode()).digest())],
        prompt_version="item_extract@v1" if ai else None, review_sla_days=int(settings["review_sla_days"]))
    link_item_to_topics(cur, tenant_id=ctx.tenant_id, item_id=item_id, item_vector=embedder.embed([body], "document")[0],
                        embedding_model=embedder.model_id, threshold=embedder.relevance_threshold)
    return item_id, cost


def erase_withdrawn_items(cur: psycopg.Cursor[Any], tenant_id: str, consent_id: str, mixed_item_ids: list[str]) -> int:
    """Withdrawal, step 2 for knowledge. Items hidden by the withdrawal lose their text (every version)
    and title. Items that ALSO rest on other material (mixed provenance) are not erased: they go back
    to review, because a passage they cited is about to disappear. Returns the number of items erased."""
    family = consent_family(cur, tenant_id, consent_id)   # the consent and any it superseded
    cur.execute(
        """SELECT DISTINCT i.id::text AS id FROM knowledge_items i
            WHERE i.tenant_id = %s AND i.status = 'withdrawn'
              AND (i.consent_id = ANY(%s::uuid[]) OR EXISTS (
                     SELECT 1 FROM knowledge_versions v JOIN citations ci ON ci.tenant_id = v.tenant_id AND ci.subject_type = 'knowledge_version'
                                                                        AND ci.subject_id = v.id
                       JOIN chunks c ON c.tenant_id = ci.tenant_id AND c.id = ci.chunk_id
                       JOIN sources s ON s.tenant_id = c.tenant_id AND s.id = c.source_id
                      WHERE v.tenant_id = i.tenant_id AND v.item_id = i.id AND s.consent_id = ANY(%s::uuid[])))""",
        (tenant_id, family, family))
    erased = [r["id"] for r in cur.fetchall()]
    for item_id in erased:
        cur.execute("SELECT id FROM knowledge_versions WHERE tenant_id = %s AND item_id = %s AND erased_at IS NULL", (tenant_id, item_id))
        for v in cur.fetchall():
            cur.execute("SELECT erase_version(%s)", (v["id"],))
        cur.execute("UPDATE knowledge_items SET title = '' WHERE tenant_id = %s AND id = %s", (tenant_id, item_id))
    # The withdrawal itself is recorded by the database (migration 15), not through _move: the words a stored conflict
    # quotes from the erased text must go here, and the partner item loses its mark and its task.
    item_conflicts.clear_many(cur, tenant_id, erased)
    scenario_erasure.erase_for_items(cur, tenant_id, erased)     # and what scenarios quote of it (the trigger only hid them)
    sla = int(_settings(cur, tenant_id)["review_sla_days"])
    for item_id in mixed_item_ids:
        item = _item(cur, tenant_id, item_id)
        if item["status"] in ("verified", "corrected", "stale", "rejected"):
            _move(cur, tenant_id, item_id, "in_review", None)
            _search_copy(cur, tenant_id, item, "in_review", _NO_EMBEDDER)
        if item["status"] != "withdrawn":
            _task(cur, tenant_id, item_id, "verify_item", sla)
    return len(erased)


def withdraw_items(cur: psycopg.Cursor[Any], tenant_id: str, only: list[str], mixed: list[str]) -> None:
    """For a withdrawn document: items that rested only on it are withdrawn and erased; items that
    also rest on other material go back to review (a passage they cited is about to disappear)."""
    for item_id in only:
        cur.execute("UPDATE knowledge_items SET status = 'withdrawn' WHERE tenant_id = %s AND id = %s AND status <> 'withdrawn'",
                    (tenant_id, item_id))
        cur.execute("DELETE FROM chunks WHERE tenant_id = %s AND knowledge_item_id = %s", (tenant_id, item_id))
        cur.execute("UPDATE quiz_items SET status = 'retired' WHERE tenant_id = %s AND knowledge_item_id = %s AND status <> 'retired'",
                    (tenant_id, item_id))
        cur.execute("SELECT id FROM knowledge_versions WHERE tenant_id = %s AND item_id = %s AND erased_at IS NULL", (tenant_id, item_id))
        for v in cur.fetchall():
            cur.execute("SELECT erase_version(%s)", (v["id"],))
        cur.execute("UPDATE knowledge_items SET title = '' WHERE tenant_id = %s AND id = %s", (tenant_id, item_id))
        item_conflicts.clear(cur, tenant_id, item_id)        # the stored conflict quotes words of the erased text
    scenario_erasure.erase_for_items(cur, tenant_id, only)   # and so does a scenario built on it
    sla = int(_settings(cur, tenant_id)["review_sla_days"])
    for item_id in mixed:
        item = _item(cur, tenant_id, item_id)
        if item["status"] in ("verified", "corrected", "stale", "rejected"):
            _move(cur, tenant_id, item_id, "in_review", None)
            _search_copy(cur, tenant_id, item, "in_review", _NO_EMBEDDER)
        _task(cur, tenant_id, item_id, "verify_item", sla)
