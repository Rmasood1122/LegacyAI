"""Configuration fails closed; tests can never select a real provider; logs carry no content."""

from __future__ import annotations

import io
import json

import pytest

from app.platform import ConfigError, Logger, load_settings
from tests.conftest import TEST_KEY

BASE = {"ENVIRONMENT": "test", "DATABASE_URL": "postgres://u@h/db", "SERVICE_TOKEN_KEY": TEST_KEY}


def test_test_environment_uses_the_fake_provider_and_embedder() -> None:
    s = load_settings(BASE)
    assert (s.ai_provider, s.embedder, s.ai_provider_key) == ("fake", "fake", None)


@pytest.mark.parametrize("extra", [
    {"AI_PROVIDER": "anthropic", "AI_PROVIDER_KEY": "synthetic-not-a-key"},
    {"AI_PROVIDER": "openai", "AI_PROVIDER_KEY": "synthetic-not-a-key"},
    {"AI_PROVIDER_KEY": "synthetic-not-a-key"},
])
def test_test_environment_refuses_any_real_provider_or_key(extra: dict[str, str]) -> None:
    with pytest.raises(ConfigError):
        load_settings({**BASE, **extra})


@pytest.mark.parametrize("env", [
    {k: v for k, v in BASE.items() if k != "SERVICE_TOKEN_KEY"},
    {**BASE, "SERVICE_TOKEN_KEY": "short"},
    {k: v for k, v in BASE.items() if k != "DATABASE_URL"},
    {**BASE, "ENVIRONMENT": "staging"},
    {**BASE, "ENVIRONMENT": "production", "AI_PROVIDER": "anthropic"},   # a real provider without a key
    {**BASE, "AI_SERVICE_CONFIG": "{not json"},
    {**BASE, "DB_POOL_MAX": "500"},
])
def test_missing_or_unsafe_configuration_stops_the_service(env: dict[str, str]) -> None:
    with pytest.raises(ConfigError):
        load_settings(env)


def test_secrets_are_never_printed() -> None:
    s = load_settings(BASE)
    assert TEST_KEY not in repr(s) and TEST_KEY not in str(s.service_token_key)


def test_logs_refuse_content_fields() -> None:
    out = io.StringIO()
    log = Logger("info", out)
    log.info("answered", tenant_id="t", count=3)
    assert json.loads(out.getvalue())["count"] == 3
    for key in ("text", "question", "answer", "prompt", "body", "title", "token", "password"):
        with pytest.raises(ValueError):
            log.info("x", **{key: "synthetic content"})
