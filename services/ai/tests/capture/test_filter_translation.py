"""The structured access filter -> query condition (docs/phase2/03). Strict: anything unexpected means
"nothing visible". No value from the filter ever becomes SQL text."""

from __future__ import annotations

import copy
import uuid
from typing import Any

import pytest

from app.capture.filters import DESCRIPTORS, condition

T = str(uuid.uuid4())
D = str(uuid.uuid4())
P = str(uuid.uuid4())


def spec(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {"v": 1, "tenant_id": T, "action": "knowledge:read", "nothing": False, "only_verified": False,
                            "any_of": [{"scope": "department", "department_id": D, "max_sensitivity": 1},
                                       {"scope": "own", "owner_person_id": P, "max_sensitivity": 3}]}
    base.update(over)
    return base


def test_a_valid_filter_becomes_bound_parameters() -> None:
    sql, params = condition(spec(), "chunks", T)
    assert sql != "FALSE"
    assert T in params and D in params and P in params
    for value in (T, D, P):
        assert value not in sql            # values are parameters, never text


BAD: list[tuple[str, Any]] = [
    ("not a dict", "tenant"),
    ("unknown key", {**spec(), "where": "TRUE"}),
    ("wrong version", spec(v=2)),
    ("nothing true", spec(nothing=True)),
    ("missing action", {k: v for k, v in spec().items() if k != "action"}),
    ("other company", spec(tenant_id=str(uuid.uuid4()))),
    ("malformed company", spec(tenant_id="'; DROP TABLE chunks; --")),
    ("empty grants", spec(any_of=[])),
    ("grants not a list", spec(any_of={"scope": "tenant"})),
    ("unknown scope", spec(any_of=[{"scope": "everything", "max_sensitivity": 3}])),
    ("extra grant key", spec(any_of=[{"scope": "tenant", "max_sensitivity": 3, "sql": "TRUE"}])),
    ("sensitivity too high", spec(any_of=[{"scope": "tenant", "max_sensitivity": 4}])),
    ("sensitivity as text", spec(any_of=[{"scope": "tenant", "max_sensitivity": "3"}])),
    ("sensitivity as bool", spec(any_of=[{"scope": "tenant", "max_sensitivity": True}])),
    ("malformed department", spec(any_of=[{"scope": "department", "department_id": "x", "max_sensitivity": 1}])),
    ("malformed owner", spec(any_of=[{"scope": "own", "owner_person_id": "1 OR 1=1", "max_sensitivity": 1}])),
    ("only_verified as text", spec(only_verified="yes")),
]


@pytest.mark.parametrize("why, bad", BAD, ids=[b[0] for b in BAD])
def test_anything_unexpected_means_nothing(why: str, bad: Any) -> None:
    for table in DESCRIPTORS:
        assert condition(bad, table, T) == ("FALSE", []), (why, table)


def test_unknown_table_means_nothing() -> None:
    assert condition(spec(), "people", T) == ("FALSE", [])


def test_verified_only_on_a_table_without_verification_means_nothing() -> None:
    assert condition(spec(only_verified=True), "sources", T) == ("FALSE", [])
    sql, _ = condition(spec(only_verified=True), "chunks", T)
    assert "verification_status IN ('verified', 'corrected')" in sql


def test_a_department_grant_reaches_nothing_on_a_table_without_departments() -> None:
    only_dept = spec(any_of=[{"scope": "department", "department_id": D, "max_sensitivity": 3}])
    assert condition(only_dept, "quiz_attempts", T) == ("FALSE", [])


def test_the_input_is_not_modified() -> None:
    s = spec()
    before = copy.deepcopy(s)
    condition(s, "chunks", T)
    assert s == before
