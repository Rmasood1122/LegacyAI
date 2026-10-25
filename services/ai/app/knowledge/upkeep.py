"""Housekeeping with the knowledge module's own steps added (docs/phase2/01, docs/phase4/01).

`platform.housekeeping` does the general sweep and knows nothing about conflicts or feedback; the steps that belong
to this module are handed to it here, so each rule is written once, in the module that owns it.

After the sweep, the rows written readable before decision D41 step 4b are sealed (step 5): batches of SEAL_BATCH
per kind, each batch its own transaction, for at most SEAL_SECONDS, so one call stays short and the rest is done by
the next call. The answer says how much was sealed and how much is still readable.
"""

from __future__ import annotations

import time
from collections.abc import Callable

from app.capture import seal_chunks, seal_turns, still_readable
from app.knowledge import item_conflicts, items, quality, scenario_erasure, scenarios
from app.platform import Database, KeyUnavailable, housekeeping

SEAL_BATCH = 200
SEAL_SECONDS = 8.0


def run(db: Database, tenant_id: str) -> dict[str, int]:
    done = housekeeping.run(
        db, tenant_id,
        after_stale=[item_conflicts.clear_many],                    # a stale item is no longer a verified statement
        after_prune=[
            quality.close_tasks_of_expired_answers,                 # a task about an answer that no longer exists is closed
            scenarios.expire_attempts,                              # a scenario run past its time limit is closed
            scenario_erasure.prune_answers,                         # learners' words go after the retention time (runs AND tests)
        ],
    )
    done.update(seal_existing(db, tenant_id))
    return done


def seal_existing(db: Database, tenant_id: str, *, batch: int = SEAL_BATCH, seconds: float = SEAL_SECONDS,
                  clock: Callable[[], float] = time.monotonic) -> dict[str, int]:
    """Seals readable chunks, knowledge versions and interview turns of ONE company (D41 step 5). When the company's
    key cannot be used (switched off, permission taken back), nothing is sealed and `seal_key_unavailable` is 1; the
    rows stay as they are until the key is back. Without content keys (development) nothing is sealed."""
    sealed = {"chunks": 0, "versions": 0, "turns": 0}
    unavailable = 0
    until = clock() + seconds
    try:
        while True:
            with db.tenant_tx(tenant_id) as cur:
                now = {"chunks": seal_chunks(cur, tenant_id, batch), "versions": items.seal_existing_versions(cur, tenant_id, batch),
                       "turns": seal_turns(cur, tenant_id, batch)}
            for kind, n in now.items():
                sealed[kind] += n
            if sum(now.values()) == 0 or clock() >= until:
                break
    except KeyUnavailable:
        unavailable = 1
    with db.tenant_tx(tenant_id) as cur:
        left = still_readable(cur, tenant_id)
        left["versions"] = items.versions_still_readable(cur, tenant_id)
    return {**{f"sealed_{k}": v for k, v in sealed.items()}, **{f"readable_{k}": v for k, v in left.items()},
            "seal_key_unavailable": unavailable}
