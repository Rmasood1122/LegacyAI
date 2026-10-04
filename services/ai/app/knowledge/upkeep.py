"""Housekeeping with the knowledge module's own steps added (docs/phase2/01, docs/phase4/01).

`platform.housekeeping` does the general sweep and knows nothing about conflicts or feedback; the steps that belong
to this module are handed to it here, so each rule is written once, in the module that owns it.
"""

from __future__ import annotations

from app.knowledge import item_conflicts, quality
from app.platform import Database, housekeeping


def run(db: Database, tenant_id: str) -> dict[str, int]:
    return housekeeping.run(
        db, tenant_id,
        after_stale=[item_conflicts.clear_many],                    # a stale item is no longer a verified statement
        after_prune=[quality.close_tasks_of_expired_answers],       # a task about an answer that no longer exists is closed
    )
