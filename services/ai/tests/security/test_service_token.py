"""The service token (docs/phase2/01): every way a token can be wrong is refused."""

from __future__ import annotations

import base64
import json
import time
import uuid

import jwt
import pytest

from app.platform import ReplayGuard, TokenError, token_id, verify_service_token
from tests.conftest import TEST_KEY, mint

T = str(uuid.uuid4())
C = str(uuid.uuid4())
P = str(uuid.uuid4())


def good(**over: object) -> str:
    base: dict[str, object] = {"tenant_id": T, "card_id": C, "person_id": P}
    return mint("knowledge.answer", **{**base, **over})  # type: ignore[arg-type]


def test_a_correct_token_is_accepted() -> None:
    ctx = verify_service_token(good(approved=[str(uuid.uuid4())]), TEST_KEY, "knowledge.answer")
    assert (ctx.tenant_id, ctx.card_id, ctx.person_id, ctx.action) == (T, C, P, "knowledge.answer")
    assert len(ctx.approved) == 1


def test_a_token_for_an_api_key_names_the_key_and_carries_no_roles() -> None:
    key_id = str(uuid.uuid4())
    ctx = verify_service_token(good(roles=[], actor={"kind": "api_key", "id": key_id}), TEST_KEY, "knowledge.answer")
    # the card is the one the key acts for; the key itself is named, it has no roles - and it is nobody's person,
    # whatever the token says (so it can never be taken for a contributor or an author)
    assert (ctx.card_id, ctx.person_id, ctx.api_key_id, ctx.roles) == (C, None, key_id, ())
    assert verify_service_token(good(), TEST_KEY, "knowledge.answer").person_id == P
    assert verify_service_token(good(), TEST_KEY, "knowledge.answer").api_key_id is None


@pytest.mark.parametrize("token_factory, why", [
    (lambda: good(lifetime=-30), "expired"),
    (lambda: good(aud="someone-else"), "wrong audience"),
    (lambda: good(iss="someone-else"), "wrong issuer"),
    (lambda: good(lifetime=600), "lifetime too long"),
    (lambda: good(card_phase="suspended"), "suspended card"),
    (lambda: good(roles="owner"), "roles not a list"),
    (lambda: good(actor={"kind": "api_key", "id": str(uuid.uuid4())}), "an API key that carries roles"),
    (lambda: good(roles=[], actor={"kind": "api_key", "id": "not-a-uuid"}), "malformed key id"),
    (lambda: good(roles=[], actor={"kind": "operator", "id": str(uuid.uuid4())}), "unknown actor kind"),
    (lambda: good(roles=[], actor="api_key"), "actor as text"),
    (lambda: good(approved=[1, 2]), "approved not ids"),
    (lambda: good(limits={"calls_per_hour": "many"}), "limits not numbers"),
    (lambda: good(tenant_id="not-a-uuid"), "malformed tenant"),
    (lambda: good(filter="tenant_id = anything"), "filter as text"),
    (lambda: good(subject="../../etc"), "malformed subject"),
    (lambda: good(key="another-key-another-key-another-key-0000"), "signed with another key"),
    (lambda: "", "missing"),
    (lambda: "not.a.token", "garbage"),
])
def test_bad_tokens_are_refused(token_factory: object, why: str) -> None:
    with pytest.raises(TokenError):
        verify_service_token(token_factory(), TEST_KEY, "knowledge.answer")  # type: ignore[operator]


def test_a_token_for_another_operation_is_refused() -> None:
    with pytest.raises(TokenError):
        verify_service_token(good(), TEST_KEY, "item.verify")


def test_missing_jti_is_refused() -> None:
    now = int(time.time())
    raw = jwt.encode({"iss": "legacyai-api", "aud": "legacyai-ai", "iat": now, "exp": now + 30, "action": "knowledge.answer",
                      "tenant_id": T, "card_id": C, "card_phase": "normal", "roles": []}, TEST_KEY, algorithm="HS256")
    with pytest.raises(TokenError):
        verify_service_token(raw, TEST_KEY, "knowledge.answer")


def _segments(token: str) -> list[str]:
    return token.split(".")


def _b64(obj: dict[str, object]) -> str:
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()


def test_a_tampered_approved_list_breaks_the_signature() -> None:
    head, body, sig = _segments(good(approved=[str(uuid.uuid4())]))
    claims = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    claims["approved"].append(str(uuid.uuid4()))          # try to smuggle in one more passage
    with pytest.raises(TokenError):
        verify_service_token(".".join([head, _b64(claims), sig]), TEST_KEY, "knowledge.answer")


def test_a_tampered_filter_breaks_the_signature() -> None:
    head, body, sig = _segments(good(filter={"v": 1}))
    claims = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    claims["filter"] = {"v": 1, "any_of": [{"scope": "tenant", "max_sensitivity": 3}]}
    with pytest.raises(TokenError):
        verify_service_token(".".join([head, _b64(claims), sig]), TEST_KEY, "knowledge.answer")


def test_the_none_algorithm_is_refused() -> None:
    _, body, _ = _segments(good())
    unsigned = _b64({"alg": "none", "typ": "JWT"}) + "." + body + "."
    with pytest.raises(TokenError):
        verify_service_token(unsigned, TEST_KEY, "knowledge.answer")


def test_another_algorithm_is_refused() -> None:
    now = int(time.time())
    raw = jwt.encode({"iss": "legacyai-api", "aud": "legacyai-ai", "iat": now, "exp": now + 30, "jti": "x", "action": "knowledge.answer",
                      "tenant_id": T, "card_id": C, "card_phase": "normal", "roles": []}, TEST_KEY, algorithm="HS512")
    with pytest.raises(TokenError):
        verify_service_token(raw, TEST_KEY, "knowledge.answer")


def test_a_token_is_accepted_once() -> None:
    guard = ReplayGuard()
    raw = good()
    jti, exp = token_id(raw)
    guard.check(jti, exp, time.time())
    with pytest.raises(TokenError):
        guard.check(jti, exp, time.time())


def test_the_topic_filter_travels_in_the_token_and_must_be_an_object() -> None:
    """Operations that show or link topics carry a second filter, for the permission topic:read."""
    spec = {"v": 1, "tenant_id": T, "action": "topic:read", "nothing": False, "only_verified": False,
            "any_of": [{"scope": "tenant", "max_sensitivity": 0}]}
    assert verify_service_token(good(topic_filter=spec), TEST_KEY, "knowledge.answer").topic_filter == spec
    assert verify_service_token(good(), TEST_KEY, "knowledge.answer").topic_filter is None
    with pytest.raises(TokenError):
        verify_service_token(good(topic_filter="tenant"), TEST_KEY, "knowledge.answer")


def test_named_filters_travel_in_the_token_and_must_map_a_permission_to_an_object() -> None:
    spec = {"v": 1, "tenant_id": T, "action": "interview:read", "nothing": False, "only_verified": False,
            "any_of": [{"scope": "tenant", "max_sensitivity": 1}]}
    assert verify_service_token(good(filters={"interview:read": spec}), TEST_KEY, "knowledge.answer").filters == {"interview:read": spec}
    assert verify_service_token(good(), TEST_KEY, "knowledge.answer").filters == {}          # absent = none
    for bad in ("tenant", ["interview:read"], {"interview:read": "everything"}, {"interview:read": None}):
        with pytest.raises(TokenError):
            verify_service_token(good(filters=bad), TEST_KEY, "knowledge.answer")



def _internal_actions() -> set[str]:
    """Every operation name this service accepts a token for: read from app/main.py, so a new one cannot be missed."""
    import re
    from pathlib import Path

    text = (Path(__file__).resolve().parents[2] / "app" / "main.py").read_text(encoding="utf-8")
    return set(re.findall(r"""Depends\(token\(\s*["']([a-z_.]+)["']""", text))


def test_a_token_for_an_api_key_is_accepted_only_for_reading_and_asking() -> None:
    from app.platform.auth import API_KEY_ACTIONS

    allowed = set(API_KEY_ACTIONS)
    assert allowed == {"knowledge.candidates", "knowledge.answer", "item.list", "item.read", "graph.read", "gap.report"}
    actions = _internal_actions()
    assert len(actions) > 40 and allowed <= actions      # the list names real operations, and the scan found them
    key = {"kind": "api_key", "id": str(uuid.uuid4())}
    for action in sorted(actions):
        token = mint(action, tenant_id=T, card_id=C, person_id=P, roles=[], actor=key)
        if action in allowed:
            assert verify_service_token(token, TEST_KEY, action).person_id is None
        else:
            with pytest.raises(TokenError):
                verify_service_token(token, TEST_KEY, action)
        # the same operation with a card's token is not affected
        assert verify_service_token(mint(action, tenant_id=T, card_id=C, person_id=P), TEST_KEY, action).person_id == P


@pytest.mark.parametrize("action", ["source.create", "source.continue", "source.confirm", "item.create", "label.change", "topic.embed"])
def test_a_key_token_cannot_add_change_or_start_anything(action: str) -> None:
    with pytest.raises(TokenError, match="API key"):
        key = {"kind": "api_key", "id": str(uuid.uuid4())}
        verify_service_token(mint(action, tenant_id=T, card_id=C, person_id=P, roles=[], actor=key), TEST_KEY, action)
