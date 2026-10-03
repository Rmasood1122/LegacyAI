"""The service token: a short-lived HS256 JSON Web Token minted by the API for ONE operation.

The API is the only caller (Google's identity check sits in front of this service in the
cloud). This check is our own second lock, and the one that runs in tests and on a laptop.
Nothing in a token is trusted unless the signature, audience, issuer, lifetime and the
operation it names all check out.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

import jwt

ISSUER = "legacyai-api"
AUDIENCE = "legacyai-ai"
MAX_LIFETIME_SECONDS = 120
LEEWAY_SECONDS = 5


class TokenError(Exception):
    """Any problem with a token. The message is for logs only, never returned to the caller."""


@dataclass(frozen=True)
class ServiceContext:
    tenant_id: str
    card_id: str
    person_id: str | None
    roles: tuple[str, ...]
    card_phase: str
    action: str
    request_id: str
    filter: dict[str, Any] | None
    approved: tuple[str, ...]
    limits: dict[str, int]
    subject: str | None = None      # the one record this operation is about, when it has one
    topic_filter: dict[str, Any] | None = None   # which topics this card may read (permission topic:read), when the operation shows or links topics


def verify_service_token(token: str, key: str, expected_action: str) -> ServiceContext:
    try:
        claims = jwt.decode(
            token, key, algorithms=["HS256"], audience=AUDIENCE, issuer=ISSUER, leeway=LEEWAY_SECONDS,
            options={"require": ["exp", "iat", "iss", "aud", "jti"]},
        )
    except jwt.PyJWTError as exc:
        raise TokenError(f"invalid token: {type(exc).__name__}") from exc

    if not isinstance(claims, dict):
        raise TokenError("claims are not an object")
    if int(claims["exp"]) - int(claims["iat"]) > MAX_LIFETIME_SECONDS:
        raise TokenError("token lifetime too long")
    if claims.get("action") != expected_action:
        raise TokenError("token was issued for another operation")
    try:
        tenant_id = str(uuid.UUID(str(claims["tenant_id"])))
        card_id = str(uuid.UUID(str(claims["card_id"])))
        person_raw = claims.get("person_id")
        person_id = str(uuid.UUID(str(person_raw))) if person_raw is not None else None
    except (KeyError, ValueError) as exc:
        raise TokenError("token subject is malformed") from exc
    phase = claims.get("card_phase")
    if phase not in ("normal", "grace"):
        raise TokenError("card phase must be normal or grace")
    roles = claims.get("roles")
    if not isinstance(roles, list) or not all(isinstance(r, str) for r in roles):
        raise TokenError("roles must be a list of strings")
    flt = claims.get("filter")
    if flt is not None and not isinstance(flt, dict):
        raise TokenError("filter must be an object")
    topic_flt = claims.get("topic_filter")
    if topic_flt is not None and not isinstance(topic_flt, dict):
        raise TokenError("topic_filter must be an object")
    approved = claims.get("approved", [])
    if not isinstance(approved, list) or not all(isinstance(a, str) for a in approved):
        raise TokenError("approved must be a list of ids")
    limits = claims.get("limits", {})
    if not isinstance(limits, dict) or not all(isinstance(v, int) for v in limits.values()):
        raise TokenError("limits must be whole numbers")
    request_id = str(claims.get("request_id", ""))[:100]
    subject_raw = claims.get("subject")
    try:
        subject = str(uuid.UUID(str(subject_raw))) if subject_raw is not None else None
    except ValueError as exc:
        raise TokenError("subject is malformed") from exc
    return ServiceContext(
        tenant_id=tenant_id, card_id=card_id, person_id=person_id, roles=tuple(roles), card_phase=phase,
        action=expected_action, request_id=request_id, filter=flt, approved=tuple(approved), limits=dict(limits),
        subject=subject, topic_filter=topic_flt,
    )


class ReplayGuard:
    """Each token is accepted once by this instance (its `jti` is remembered until it expires).
    Tokens live at most two minutes, so the memory stays small. Several instances do not share
    this memory: the short lifetime is the limit there."""

    def __init__(self) -> None:
        self._seen: dict[str, float] = {}

    def check(self, jti: str, exp: float, now: float) -> None:
        if len(self._seen) > 1000:
            self._seen = {k: v for k, v in self._seen.items() if v > now}
        if jti in self._seen:
            raise TokenError("token already used")
        self._seen[jti] = exp + LEEWAY_SECONDS


def token_id(token: str) -> tuple[str, float]:
    """jti and exp of a token whose signature was ALREADY verified."""
    claims = jwt.decode(token, options={"verify_signature": False})
    return str(claims["jti"]), float(claims["exp"])
