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


@pytest.mark.parametrize("token_factory, why", [
    (lambda: good(lifetime=-30), "expired"),
    (lambda: good(aud="someone-else"), "wrong audience"),
    (lambda: good(iss="someone-else"), "wrong issuer"),
    (lambda: good(lifetime=600), "lifetime too long"),
    (lambda: good(card_phase="suspended"), "suspended card"),
    (lambda: good(roles="owner"), "roles not a list"),
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
