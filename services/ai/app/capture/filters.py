"""Lock 2 (docs/phase2/03): the structured access filter, produced by the API's policy decision
point and turned into a query condition HERE. No SQL arrives from outside: column names come
from the fixed descriptors below, and every value from the filter is a bound parameter.

Strict by design: an unknown version, scope or key, a wrong type, a missing id, or a company
id different from the token's -> the condition is FALSE (nothing visible).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

NOTHING: tuple[str, list[Any]] = ("FALSE", [])


@dataclass(frozen=True)
class Descriptor:
    """Where a table keeps the attributes the policy needs. Written in code only."""

    tenant: str
    department: str | None
    sensitivity: str | None
    owner_person: tuple[str, ...]
    owner_card: tuple[str, ...] = ()
    verified: str | None = None          # condition text for "verified or corrected", if the table has one


DESCRIPTORS: dict[str, Descriptor] = {
    "chunks": Descriptor("c.tenant_id", "c.department_id", "c.sensitivity", ("c.owner_person_id",),
                         verified="c.verification_status IN ('verified', 'corrected')"),
    "sources": Descriptor("s.tenant_id", "s.department_id", "s.sensitivity", ("s.owner_person_id",)),
    "knowledge_items": Descriptor("i.tenant_id", "i.department_id", "i.sensitivity", ("i.owner_person_id",),
                                  verified="i.status IN ('verified', 'corrected')"),
    "quiz_items": Descriptor("q.tenant_id", "q.department_id", "q.sensitivity", ("q.owner_person_id",)),
    "topics": Descriptor("tp.tenant_id", "tp.department_id", "tp.sensitivity", ()),
    "review_tasks": Descriptor("r.tenant_id", "r.department_id", "r.sensitivity", ("r.owner_person_id",)),
    "expert_questions": Descriptor("eq.tenant_id", "eq.department_id", "eq.sensitivity", ("eq.owner_person_id",),
                                   owner_card=("eq.asked_by_card_id",)),
    "quiz_attempts": Descriptor("qa.tenant_id", None, None, ("qa.owner_person_id",)),
}

_SCOPE_KEYS = {
    "tenant": {"scope", "max_sensitivity"},
    "department": {"scope", "max_sensitivity", "department_id"},
    "own": {"scope", "max_sensitivity", "owner_person_id", "owner_card_id"},
}


def _uuid(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        return str(uuid.UUID(value))
    except ValueError:
        return None


def condition(spec: Any, table: str, token_tenant_id: str) -> tuple[str, list[Any]]:
    """Returns (SQL condition, parameters) for the given table, or FALSE."""
    descriptor = DESCRIPTORS.get(table)
    if descriptor is None or not isinstance(spec, dict):
        return NOTHING
    if set(spec) - {"v", "tenant_id", "action", "nothing", "any_of", "only_verified"}:
        return NOTHING
    if spec.get("v") != 1 or spec.get("nothing") is not False or not isinstance(spec.get("action"), str):
        return NOTHING
    tenant = _uuid(spec.get("tenant_id"))
    if tenant is None or tenant != token_tenant_id:
        return NOTHING
    any_of = spec.get("any_of")
    only_verified = spec.get("only_verified", False)
    if not isinstance(any_of, list) or not any_of or not isinstance(only_verified, bool):
        return NOTHING

    params: list[Any] = [tenant]
    clauses: list[str] = []
    for grant in any_of:
        if not isinstance(grant, dict):
            return NOTHING
        scope = grant.get("scope")
        if scope not in _SCOPE_KEYS or set(grant) - _SCOPE_KEYS[scope]:
            return NOTHING
        max_sens = grant.get("max_sensitivity")
        if not isinstance(max_sens, int) or isinstance(max_sens, bool) or not 0 <= max_sens <= 3:
            return NOTHING
        parts: list[str] = []
        if scope == "department":
            dept = _uuid(grant.get("department_id"))
            if dept is None:
                return NOTHING
            if descriptor.department is None:
                continue  # this table has no department: a department grant reaches nothing here
            parts.append(f"{descriptor.department} = %s")
            params.append(dept)
        elif scope == "own":
            own: list[str] = []
            person = grant.get("owner_person_id")
            card = grant.get("owner_card_id")
            if person is not None:
                person_id = _uuid(person)
                if person_id is None:
                    return NOTHING
                for col in descriptor.owner_person:
                    own.append(f"{col} = %s")
                    params.append(person_id)
            if card is not None:
                card_id = _uuid(card)
                if card_id is None:
                    return NOTHING
                for col in descriptor.owner_card:
                    own.append(f"{col} = %s")
                    params.append(card_id)
            if not own:
                continue
            parts.append("(" + " OR ".join(own) + ")")
        if descriptor.sensitivity is not None:
            parts.append(f"{descriptor.sensitivity} <= %s")
            params.append(max_sens)
        clauses.append("(" + " AND ".join(parts) + ")" if parts else "TRUE")
    if not clauses:
        return NOTHING
    sql = f"({descriptor.tenant} = %s AND ({' OR '.join(clauses)})"
    if only_verified:
        if descriptor.verified is None:
            return NOTHING  # "verified only" cannot be honoured on this table: show nothing
        sql += f" AND {descriptor.verified}"
    return sql + ")", params


def topic_condition(spec: Any, token_tenant_id: str) -> tuple[str, list[Any]]:
    """The condition for topics (alias tp) from the token's `topic_filter`: which topics this card may READ.

    It must be the filter of the permission topic:read - the filter of another permission (for example the one for
    reading knowledge) says nothing about topics and gives FALSE. Topics are not verified or unverified, so the
    "verified only" rule for learners does not apply to them (the API's own topic list ignores it in the same way);
    everything else is as strict as condition(): anything missing or malformed gives FALSE.
    """
    if not isinstance(spec, dict) or spec.get("action") != "topic:read":
        return NOTHING
    if not isinstance(spec.get("only_verified", False), bool):
        return NOTHING
    return condition({**spec, "only_verified": False}, "topics", token_tenant_id)
