"""Decision D41, step 6 part 2: knowledge item titles and the words a stored conflict quotes from two items are
stored sealed; every screen that names an item (its page, the item list, the knowledge map, answers' citations, the
other side of a conflict) opens the title for that request; older ones are sealed by the housekeeping job; erasing
an item empties its title in both forms. Synthetic data and made-up local keys only."""

from __future__ import annotations

from typing import Any

import psycopg
import pytest

from app.ai_gateway import FakeEmbedder, Gateway
from app.knowledge import answers, graph, items, reads, upkeep
from app.platform import Database, use_content_keys
from tests.conftest import TEST_CONTENT_KEYS, World, give_consent, needs_db, tenant_filter
from tests.integration.helpers import item_chunk_id, verified_item
from tests.integration.test_item_topics import make_topic, reviewer_ctx
from tests.integration.test_quality import NEW, OLD, conflict_rows
from tests.integration.test_withdrawal import erase

pytestmark = [pytest.mark.db, needs_db]

TITLE = "Handbook of the north plant"
OTHER = "Fault table of the north plant"


def plant(db: Database, world: World, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]]) -> dict[str, str]:
    """Two verified items on one topic that disagree (so a conflict is stored), the second written under consent."""
    consent = give_consent(admin, world, "expert", "own_words")
    topic = make_topic(admin, world.tenant_id, "CO2 supply")
    first = verified_item(db, world, embedder, OLD, title=TITLE, author="owner")
    items.set_topics(db, reviewer_ctx(world, first), first, [topic])
    second = items.write_manual(db, world.ctx("expert", "item.write"), title=OTHER, body=NEW, department_id=None, sensitivity=1,
                                contributor_person_id=world.people["expert"].id)
    items.set_topics(db, reviewer_ctx(world, second), second, [topic])
    items.submit(db, world.ctx("expert", "item.submit"), second)
    assert items.verify(db, world.ctx("reviewer", "item.verify"), second, embedder) == "verified"
    return {"first": first, "second": second, "consent": consent}


def at_rest(admin: psycopg.Connection[dict[str, Any]], tenant: str) -> dict[str, Any]:
    """Read by the superuser, outside the code under test."""
    row = admin.execute(
        """SELECT (SELECT count(*) FROM knowledge_items WHERE tenant_id = %(t)s AND title IS NOT NULL AND title <> '')::int AS titles,
                  (SELECT count(*) FROM knowledge_item_conflicts WHERE tenant_id = %(t)s AND item_value IS NOT NULL)::int AS conflicts,
                  (SELECT count(*) FROM knowledge_items WHERE tenant_id = %(t)s AND title_sealed IS NOT NULL)::int AS sealed_titles""",
        {"t": tenant}).fetchone()
    sealed = b"".join(bytes(r["v"]) for r in admin.execute(
        """SELECT title_sealed AS v FROM knowledge_items WHERE tenant_id = %(t)s AND title_sealed IS NOT NULL
           UNION ALL SELECT item_value_sealed FROM knowledge_item_conflicts WHERE tenant_id = %(t)s AND sealed_key IS NOT NULL
           UNION ALL SELECT other_value_sealed FROM knowledge_item_conflicts WHERE tenant_id = %(t)s AND sealed_key IS NOT NULL""",
        {"t": tenant}))
    return {**dict(row), "words_in_sealed_bytes": b"north plant" in sealed or b"bar" in sealed}


def shown(db: Database, world: World, gateway: Gateway, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]],
          planted: dict[str, str]) -> dict[str, Any]:
    """The titles and quoted words as the screens get them."""
    spec = tenant_filter(world.tenant_id)
    topics = tenant_filter(world.tenant_id, action="topic:read")
    page = reads.get_item(db, world.ctx("reviewer", "item.read", subject=planted["first"], topic_filter=topics), planted["first"])
    listed = {i["id"]: i["title"] for i in reads.list_items(db, world.ctx("reviewer", "item.list", filter=spec), status=None, owner_me=False, after=None,
                                                              limit=50)["items"]}
    around = graph.neighbourhood(db, world.ctx("owner", "graph.read", filter=spec, topic_filter=topics), "item", planted["first"])
    chunk = item_chunk_id(admin, planted["first"])
    cited = answers.answer(db, world.ctx("learner", "knowledge.answer", approved=[chunk]), gateway, embedder, world.caller("learner"),
                           "At what pressure does the CO2 low-pressure alarm come?", None, None).public()["citations"]
    return {
        "page": page["title"], "listed": listed,
        "conflict": [(c["this"]["title"], c["this"]["value"], c["other"]["title"], c["other"]["value"]) for c in page["conflicts"]],
        "map": {"centre": around["node"]["label"],
                "conflicting": [n["node"]["label"] for g in around["neighbours"] if g["group"] == "conflicting_items" for n in g["nodes"]]},
        "cited": [c["title"] for c in cited if c["kind"] == "item"],
    }


EXPECTED_CONFLICT = [(TITLE, "3.0 bar", OTHER, "3.2 bar")]


def test_titles_and_quoted_words_are_stored_sealed_and_shown_opened(db: Database, world: World, gateway: Gateway, embedder: FakeEmbedder,
                                                                    admin: psycopg.Connection[dict[str, Any]]) -> None:
    planted = plant(db, world, embedder, admin)
    stored = at_rest(admin, world.tenant_id)
    assert (stored["titles"], stored["conflicts"], stored["sealed_titles"], stored["words_in_sealed_bytes"]) == (0, 0, 2, False)
    seen = shown(db, world, gateway, embedder, admin, planted)
    assert seen["page"] == TITLE and seen["listed"] == {planted["first"]: TITLE, planted["second"]: OTHER}
    assert seen["conflict"] == EXPECTED_CONFLICT
    assert seen["map"] == {"centre": TITLE, "conflicting": [OTHER]} and seen["cited"] == [TITLE]


def test_titles_and_quoted_words_written_before_are_sealed_by_housekeeping(db: Database, world: World, gateway: Gateway,
                                                                          embedder: FakeEmbedder,
                                                                          admin: psycopg.Connection[dict[str, Any]]) -> None:
    use_content_keys(None)                                   # as before this step
    try:
        planted = plant(db, world, embedder, admin)
    finally:
        use_content_keys(TEST_CONTENT_KEYS)
    before = at_rest(admin, world.tenant_id)
    assert (before["titles"], before["conflicts"], before["sealed_titles"]) == (2, 1, 0)
    assert shown(db, world, gateway, embedder, admin, planted)["conflict"] == EXPECTED_CONFLICT     # readable rows read as before

    done = upkeep.seal_existing(db, world.tenant_id, batch=1)
    assert (done["sealed_titles"], done["sealed_conflicts"], done["readable_titles"], done["readable_conflicts"]) == (2, 1, 0, 0)
    after = at_rest(admin, world.tenant_id)
    assert (after["titles"], after["conflicts"], after["sealed_titles"], after["words_in_sealed_bytes"]) == (0, 0, 2, False)
    seen = shown(db, world, gateway, embedder, admin, planted)
    assert seen["page"] == TITLE and seen["conflict"] == EXPECTED_CONFLICT and seen["map"]["conflicting"] == [OTHER]
    assert all(r["sealed"] for r in conflict_rows(admin, world.tenant_id))
    again = upkeep.seal_existing(db, world.tenant_id)
    assert (again["sealed_titles"], again["sealed_conflicts"]) == (0, 0)


def test_erasing_an_item_empties_its_sealed_title(db: Database, world: World, embedder: FakeEmbedder,
                                                  admin: psycopg.Connection[dict[str, Any]]) -> None:
    planted = plant(db, world, embedder, admin)
    admin.execute("UPDATE consents SET withdrawn_at = now(), withdrawn_by_card_id = %s WHERE id = %s",
                  (world.people["expert"].card_id, planted["consent"]))
    erase(db, world, planted["consent"])
    row = admin.execute("SELECT title, title_sealed, sealed_key, status FROM knowledge_items WHERE id = %s", (planted["second"],)).fetchone()
    assert (row["title"], row["title_sealed"], row["sealed_key"], row["status"]) == ("", None, None, "withdrawn")
    assert conflict_rows(admin, world.tenant_id) == []
    assert admin.execute("SELECT title_sealed IS NOT NULL AS sealed FROM knowledge_items WHERE id = %s", (planted["first"],)).fetchone()["sealed"]
