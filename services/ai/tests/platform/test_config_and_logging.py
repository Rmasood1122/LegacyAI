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


def test_content_key_settings_fail_closed() -> None:
    """KEY_SERVICE, LOCAL_KEY_SERVICE_KEYS and PLATFORM_CONTENT_KEY (decision D41, step 4b): the API's names and rules."""
    import base64

    key = base64.b64encode(bytes(32)).decode()
    s = load_settings(BASE)
    assert (s.key_service, s.local_keys, s.platform_content_key) == ("none", (), None)
    s = load_settings({**BASE, "KEY_SERVICE": "local", "LOCAL_KEY_SERVICE_KEYS": json.dumps({"platform": key}),
                       "PLATFORM_CONTENT_KEY": "local:platform"})
    assert s.local_key_bytes() == {"platform": bytes(32)} and s.platform_content_key == "local:platform"
    assert key not in repr(s)                                                      # never printed
    prod = {"ENVIRONMENT": "production", "DATABASE_URL": "postgres://u@h/db", "SERVICE_TOKEN_KEY": TEST_KEY, "EMBEDDER": "fake"}
    assert load_settings({**prod, "KEY_SERVICE": "google-kms",
                          "PLATFORM_CONTENT_KEY": "projects/acme-prod-1234/locations/us/keyRings/r/cryptoKeys/k"}).key_service == "google-kms"
    for bad in (
        {"KEY_SERVICE": "vault"},
        {"KEY_SERVICE": "local"},                                                  # no keys
        {"KEY_SERVICE": "local", "LOCAL_KEY_SERVICE_KEYS": "{}"},
        {"KEY_SERVICE": "local", "LOCAL_KEY_SERVICE_KEYS": json.dumps({"Bad Name": key})},
        {"KEY_SERVICE": "local", "LOCAL_KEY_SERVICE_KEYS": json.dumps({"short": base64.b64encode(bytes(16)).decode()})},
        {"KEY_SERVICE": "local", "LOCAL_KEY_SERVICE_KEYS": json.dumps({"k": "not base64!"})},
        {"PLATFORM_CONTENT_KEY": "local:platform"},                                # a platform key without a key service
    ):
        with pytest.raises(ConfigError):
            load_settings({**BASE, **bad})
    with pytest.raises(ConfigError):                                               # the stand-in is never allowed in production
        load_settings({**prod, "KEY_SERVICE": "local", "LOCAL_KEY_SERVICE_KEYS": json.dumps({"platform": key})})
