"""Decision D41, re-keying part 2: after a company CLEARS its own key, the housekeeping job also seals the step-6
columns again with the company's current key - questions asked, questions to experts, comments, item titles, conflict
quotes, readiness questions and answers, scenario texts and answers, document titles, topic names. Afterwards nothing
needs the old key: switched off, every screen still shows the same words. The database still refuses the key change
where the rule does not allow it. Synthetic data and made-up local keys only."""

from __future__ import annotations

from typing import Any

import psycopg
import pytest

from app.ai_gateway import FakeEmbedder, Gateway
from app.capture import topics
from app.knowledge import rekey, upkeep
from app.platform import Database, active_content_keys
from app.platform.sealing import LocalKeyService
from tests.conftest import World, needs_db, tenant_filter
from tests.integration import test_sealed_questions as questions
from tests.integration import test_sealed_quiz as quiz
from tests.integration import test_sealed_scenarios as scenarios
from tests.integration import test_sealed_titles as titles
from tests.integration.helpers import company_document
from tests.integration.test_rekey import clear_own_key, give_own_key, local  # noqa: F401  (local: the fixture with the company's key)

pytestmark = [pytest.mark.db, needs_db]


def keys_at_rest(admin: psycopg.Connection[dict[str, Any]], tenant: str) -> dict[str, set[str]]:
    """Per step-6 kind, the keys its stored values are sealed with (read by the superuser)."""
    return {kind: {r["k"] for r in admin.execute(f"SELECT DISTINCT sealed_key AS k FROM {spec.table} WHERE tenant_id = %s AND sealed_key IS NOT NULL",
                                                 (tenant,)).fetchall()}
            for kind, spec in rekey.STEPS.items()}


def shown_everywhere(db: Database, world: World, gateway: Gateway, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]],
                     planted: dict[str, Any]) -> dict[str, Any]:
    """The words as the screens get them, through each step's own reading code."""
    spec = tenant_filter(world.tenant_id, action="topic:read")
    return {"questions": questions.shown(db, world, planted["questions"]),
            "titles": titles.shown(db, world, gateway, embedder, admin, planted["titles"]),
            "quiz": quiz.shown(db, world, planted["quiz"]),
            "scenarios": scenarios.shown(db, world, planted["scenarios"]),
            "topic": topics.texts(db, world.ctx("owner", "topic.texts", filter=spec), [planted["topic"]])}


def test_after_the_key_is_cleared_every_step_6_column_is_sealed_again_and_the_old_key_is_no_longer_needed(
        db: Database, world: World, gateway: Gateway, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]],
        local: LocalKeyService) -> None:  # noqa: F811
    give_own_key(admin, world.tenant_id)
    planted = {"questions": questions.plant(db, world, gateway, embedder, admin), "titles": titles.plant(db, world, embedder, admin),
               "quiz": quiz.plant(db, world, embedder, gateway, admin), "scenarios": scenarios.plant(db, world, embedder, gateway),
               "document": company_document(db, world, embedder, "Synthetic boiler manual of the north plant.", title="Boiler manual"),
               "topic": topics.create(db, world.ctx("owner", "topic.create"), embedder, name="Boiler water", description="Dosing and blowdown",
                                      department_id=None, sensitivity=0)["id"]}
    before = keys_at_rest(admin, world.tenant_id)
    assert all(found == {"company:1"} for found in before.values()), before            # every kind holds something, all on the own key
    seen = shown_everywhere(db, world, gateway, embedder, admin, planted)

    clear_own_key(admin, world.tenant_id)
    done = upkeep.seal_existing(db, world.tenant_id, batch=1)
    assert all(done[f"rekeyed_{kind}"] >= 1 for kind in rekey.STEPS), done
    assert all(done[f"old_key_{kind}"] == 0 for kind in rekey.STEPS) and done["old_key_unavailable"] == 0
    assert all(found == {"platform:1"} for found in keys_at_rest(admin, world.tenant_id).values())

    local.disable("acme")                                                              # the company's old key is gone
    keys = active_content_keys()
    assert keys is not None
    keys.forget(world.tenant_id)
    assert shown_everywhere(db, world, gateway, embedder, admin, planted) == seen
    quiz.check_shown(seen["quiz"])
    scenarios.check_shown(seen["scenarios"])
    with pytest.raises(topics.TopicRefused):                                           # a name is still used only once
        topics.create(db, world.ctx("owner", "topic.create"), embedder, name="BOILER WATER", description="", department_id=None, sensitivity=0)
    assert upkeep.seal_existing(db, world.tenant_id)["rekeyed_topics"] == 0


def test_the_guards_refuse_a_key_change_the_rule_does_not_allow(
        db: Database, world: World, gateway: Gateway, embedder: FakeEmbedder, admin: psycopg.Connection[dict[str, Any]],
        local: LocalKeyService) -> None:  # noqa: F811
    give_own_key(admin, world.tenant_id)
    planted = questions.plant(db, world, gateway, embedder, admin)
    keys = active_content_keys()
    assert keys is not None
    # while the own key is live, the job's function refuses to move a question to another key
    with pytest.raises(psycopg.errors.InsufficientPrivilege), db.tenant_tx(world.tenant_id) as cur:
        cur.execute("SELECT reseal_answer_log(%s, 'company:1', '\\x00'::bytea, 'platform:1')", (planted["answer"],))
    with pytest.raises(psycopg.errors.CheckViolation), db.tenant_tx(world.tenant_id) as cur:
        cur.execute("UPDATE expert_questions SET sealed_key = 'platform:1' WHERE id = %s", (planted["question"],))
    clear_own_key(admin, world.tenant_id)
    with db.tenant_tx(world.tenant_id) as cur:
        current, _ = keys.for_writing(cur, world.tenant_id)
    assert current == "platform:1"
    # after clearing: still only to the current key
    with pytest.raises(psycopg.errors.CheckViolation), db.tenant_tx(world.tenant_id) as cur:
        cur.execute("UPDATE expert_questions SET sealed_key = 'platform:2' WHERE id = %s", (planted["question"],))
    with pytest.raises(psycopg.errors.InsufficientPrivilege), db.tenant_tx(world.tenant_id) as cur:
        cur.execute("SELECT reseal_answer_log(%s, 'company:1', '\\x00'::bytea, 'company:1')", (planted["answer"],))
