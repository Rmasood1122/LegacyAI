"""The verification loop (feature 12): second reviewer for every origin, versions, the search copy, revert."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import psycopg
import pytest

from app.ai_gateway import FakeEmbedder
from app.knowledge import items
from app.platform import Database
from tests.conftest import World, give_consent, needs_db
from tests.integration.helpers import verified_item

pytestmark = [pytest.mark.db, needs_db]

BODY = "Flush the synthetic chiller loop every quarter, starting from the lowest drain valve."


def copies(admin: psycopg.Connection[dict[str, Any]], item_id: str) -> list[dict[str, Any]]:
    return admin.execute("SELECT verification_status, status FROM chunks WHERE knowledge_item_id = %s", (item_id,)).fetchall()


def test_the_author_cannot_verify_their_own_item(db: Database, world: World, embedder: FakeEmbedder) -> None:
    item = items.write_manual(db, world.ctx("expert", "item.write"), title="Chiller", body=BODY, department_id=None, sensitivity=1,
                              contributor_person_id=None)
    items.submit(db, world.ctx("expert", "item.submit"), item)
    with pytest.raises(items.ItemRefused) as exc:
        items.verify(db, world.ctx("expert", "item.verify"), item, embedder)
    assert exc.value.code == "self_review" and exc.value.status == 403


def test_the_contributor_cannot_verify_their_own_words_even_if_someone_else_typed_them(
        db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> None:
    give_consent(admin, world, "expert", "own_words")
    item = items.write_manual(db, world.ctx("owner", "item.write"), title="Chiller", body=BODY, department_id=None, sensitivity=1,
                              contributor_person_id=world.people["expert"].id)
    items.submit(db, world.ctx("owner", "item.submit"), item)
    for who in ("expert", "owner"):          # the contributor, and the author of the text
        with pytest.raises(items.ItemRefused):
            items.verify(db, world.ctx(who, "item.verify"), item, embedder)
    assert items.verify(db, world.ctx("reviewer", "item.verify"), item, embedder) == "verified"


def test_a_search_copy_exists_only_while_verified(db: Database, world: World, embedder: FakeEmbedder,
                                                 admin: psycopg.Connection[dict[str, Any]]) -> None:
    item = verified_item(db, world, embedder, BODY)
    assert copies(admin, item) == [{"verification_status": "verified", "status": "active"}]
    items.reopen(db, world.ctx("owner", "item.reopen"), item)
    assert copies(admin, item) == []
    assert items.verify(db, world.ctx("reviewer", "item.verify"), item, embedder) == "verified"
    items.reopen(db, world.ctx("owner", "item.reopen"), item)
    items.reject(db, world.ctx("owner", "item.reject"), item)
    assert copies(admin, item) == []


def test_a_corrector_cannot_confirm_their_own_correction(db: Database, world: World, embedder: FakeEmbedder,
                                                        admin: psycopg.Connection[dict[str, Any]]) -> None:
    item = verified_item(db, world, embedder, BODY)
    assert items.propose_version(db, world.ctx("reviewer", "item.propose"), item, BODY + " Wear gloves.") == 2
    assert copies(admin, item) == []                       # back in review: not searchable meanwhile
    with pytest.raises(items.ItemRefused):
        items.verify(db, world.ctx("reviewer", "item.verify"), item, embedder)
    assert items.verify(db, world.ctx("owner", "item.verify"), item, embedder) == "corrected"
    copy = admin.execute("SELECT text, verification_status FROM chunks WHERE knowledge_item_id = %s", (item,)).fetchone()
    assert copy["verification_status"] == "corrected" and copy["text"].endswith("Wear gloves.")


def test_illegal_moves_are_refused(db: Database, world: World, embedder: FakeEmbedder) -> None:
    item = items.write_manual(db, world.ctx("expert", "item.write"), title="Chiller", body=BODY, department_id=None, sensitivity=1,
                              contributor_person_id=None)
    with pytest.raises(items.ItemRefused):
        items.verify(db, world.ctx("reviewer", "item.verify"), item, embedder)       # still a candidate
    with pytest.raises(items.ItemRefused):
        items.retire(db, world.ctx("owner", "item.retire"), item)                     # only stale items retire


def test_revert_puts_everything_a_bad_reviewer_verified_back_in_review(db: Database, world: World, embedder: FakeEmbedder,
                                                                      admin: psycopg.Connection[dict[str, Any]]) -> None:
    a = verified_item(db, world, embedder, BODY)
    b = verified_item(db, world, embedder, BODY + " Second synthetic note.")
    now = datetime.now(UTC)
    n = items.revert_verifications(db, world.ctx("owner", "verification.revert"), world.people["reviewer"].card_id,
                                   (now - timedelta(hours=1)).isoformat(), (now + timedelta(hours=1)).isoformat())
    assert n == 2
    for i in (a, b):
        assert admin.execute("SELECT status FROM knowledge_items WHERE id = %s", (i,)).fetchone()["status"] == "in_review"
        assert copies(admin, i) == []


def test_the_database_refuses_self_verification_even_without_the_code(db: Database, world: World, embedder: FakeEmbedder) -> None:
    item = items.write_manual(db, world.ctx("expert", "item.write"), title="Chiller", body=BODY, department_id=None, sensitivity=1,
                              contributor_person_id=None)
    items.submit(db, world.ctx("expert", "item.submit"), item)
    with pytest.raises(psycopg.errors.InsufficientPrivilege), db.tenant_tx(world.tenant_id) as cur:
        cur.execute("UPDATE knowledge_items SET status = 'verified', verified_by_card_id = %s, verified_at = now() WHERE id = %s",
                    (world.people["expert"].card_id, item))
