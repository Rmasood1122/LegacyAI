"""Migration 20261004000100 on a database that HOLDS rows (docs/phase4/01).

The migrations check in CI applies and rolls back on an empty database, which cannot show this: the role that runs
migrations cannot bypass row-level security, the policy is forced on the owner as well, and with no company set a
plain UPDATE or DELETE in a migration matches nothing. Both data steps of this migration (existing "sources conflict"
refusals get their finder on the way up; tasks of the two new kinds are removed on the way down) must therefore work
AS THAT ROLE, on rows of a company.

The test runs the migration's own SQL, down and then up, as the migration role, inside one transaction that is rolled
back at the end, so the database the other tests use is left exactly as it was.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import psycopg
import pytest
from psycopg.rows import dict_row

from app.ai_gateway import FakeEmbedder, FakeProvider, Gateway
from app.knowledge import quality
from app.platform import Database
from tests.conftest import SUPER_URL, World, needs_db
from tests.integration.helpers import item_chunk_id, verified_item
from tests.integration.test_quality import OLD, ask, two_items_in_conflict

pytestmark = [pytest.mark.db, needs_db]

MIGRATION = Path(__file__).resolve().parents[4] / "db" / "migrations" / "20261004000100_quality.sql"


def sections() -> tuple[str, str]:
    up, down = MIGRATION.read_text(encoding="utf-8").split("-- migrate:down")
    return up.replace("-- migrate:up", ""), down


def test_both_data_steps_work_as_the_migration_role_on_rows_of_a_company(
        db: Database, world: World, gateway: Gateway, provider: FakeProvider, embedder: FakeEmbedder,
        admin: psycopg.Connection[dict[str, Any]]) -> None:
    # rows of every kind the migration touches: a refusal for a conflict found by the model, a feedback row with its
    # task, and two items in conflict with their tasks
    chunk = item_chunk_id(admin, verified_item(db, world, embedder, OLD))
    answered = ask(db, world, gateway, embedder, [chunk]).public()["answer_id"]
    provider.script = lambda req: {"answerable": True, "answer": "x", "claims": [], "conflict": True}
    refused = ask(db, world, gateway, embedder, [chunk]).public()["answer_id"]
    provider.script = None
    quality.put_feedback(db, world.ctx("learner", "answer.feedback", subject=answered), answered, "wrong", None, False)
    two_items_in_conflict(db, world, embedder, admin)
    new_kinds = "kind IN ('item_conflict', 'answer_feedback')"
    assert admin.execute(f"SELECT count(*) AS n FROM review_tasks WHERE tenant_id = %s AND {new_kinds}", (world.tenant_id,)).fetchone()["n"] == 3

    up, down = sections()
    with psycopg.connect(SUPER_URL, autocommit=False, row_factory=dict_row) as tx:
        try:
            tx.execute("SET LOCAL ROLE legacyai_migrator")
            # as this role, with no company set, the rows are invisible - which is exactly why the migration needs its exemption
            assert tx.execute("SELECT count(*) AS n FROM review_tasks").fetchone()["n"] == 0
            tx.execute(down)       # fails here ("violates check constraint") if the new-kind tasks were not really deleted
            tx.execute(up)         # fails here if the refusal recorded before the migration did not get its finder
            tx.execute("RESET ROLE")
            row = tx.execute("SELECT reason, conflict_found_by FROM answer_logs WHERE id = %s", (refused,)).fetchone()
            assert (row["reason"], row["conflict_found_by"]) == ("sources_conflict", "ai_model")
            assert tx.execute("SELECT conflict_found_by FROM answer_logs WHERE id = %s", (answered,)).fetchone()["conflict_found_by"] is None
            assert tx.execute(f"SELECT count(*) AS n FROM review_tasks WHERE tenant_id = %s AND {new_kinds}", (world.tenant_id,)).fetchone()["n"] == 0
            # the exemption did not outlive its statement: both tables are forced again
            forced = tx.execute("SELECT relname, relforcerowsecurity FROM pg_class WHERE relname IN ('answer_logs', 'review_tasks')").fetchall()
            assert {r["relname"]: r["relforcerowsecurity"] for r in forced} == {"answer_logs": True, "review_tasks": True}
            # the two NEW tables: row-level security on AND forced, with a policy; and the trigger that ends conflicts is back
            new = tx.execute("SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class "
                             "WHERE relname IN ('answer_feedback', 'knowledge_item_conflicts')").fetchall()
            assert {r["relname"]: (r["relrowsecurity"], r["relforcerowsecurity"]) for r in new} == {
                "answer_feedback": (True, True), "knowledge_item_conflicts": (True, True)}
            policies = tx.execute("SELECT tablename FROM pg_policies WHERE tablename IN ('answer_feedback', 'knowledge_item_conflicts')").fetchall()
            assert {r["tablename"] for r in policies} == {"answer_feedback", "knowledge_item_conflicts"}
            assert tx.execute("SELECT count(*) AS n FROM pg_trigger WHERE tgname = 'knowledge_items_end_conflicts'").fetchone()["n"] == 1
        finally:
            tx.rollback()
    # nothing of this was kept
    assert admin.execute(f"SELECT count(*) AS n FROM review_tasks WHERE tenant_id = %s AND {new_kinds}", (world.tenant_id,)).fetchone()["n"] == 3
