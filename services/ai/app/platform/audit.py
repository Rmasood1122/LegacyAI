"""Audit rows from the Python service. All of them go through the database function
audit_write(), which enforces the allow-list of detail keys and forces this login's rows to
the actor kind 'service' (docs/phase2/01, "Who writes the audit log"). Details carry ids and
counts only - never text.
"""

from __future__ import annotations

import json
from typing import Any

import psycopg

DetailValue = str | int | float | bool | None


def write_audit(
    cur: psycopg.Cursor[Any], *, tenant_id: str, card_id: str | None, action: str, reason_code: str,
    resource_type: str | None = None, resource_id: str | None = None, request_id: str | None = None,
    details: dict[str, DetailValue] | None = None, api_key_id: str | None = None,
) -> None:
    # `api_key_id`: the request was made with a machine's API key; `card_id` is then the card the key acts for and
    # the row names the key (its id, never its secret).
    if api_key_id is not None:
        details = {**(details or {}), "api_key_id": api_key_id}
    canonical = json.dumps(details or {}, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    cur.execute(
        "SELECT audit_write(%s, %s, 'service', %s, %s, %s, 'event', %s, %s, NULL, %s)",
        (tenant_id, card_id, action, resource_type, resource_id, reason_code, request_id, canonical),
    )
