"""Configuration. Loaded once at start-up; anything missing or unsafe stops the service.

Every value comes from the environment (in the cloud: Secret Manager). Nothing has a
production default. A real AI provider can never be selected while ENVIRONMENT=test.
"""

from __future__ import annotations

import base64
import binascii
import json
import os
import re
from dataclasses import dataclass
from typing import Literal


class ConfigError(Exception):
    """Raised when the service must not start."""


Provider = Literal["fake", "anthropic", "openai"]
Embedder = Literal["fake", "local"]


@dataclass(frozen=True)
class Secret:
    """A value that must never be printed. str() and repr() show nothing."""

    _value: str

    def reveal(self) -> str:
        return self._value

    def __repr__(self) -> str:  # pragma: no cover - trivial
        return "Secret(***)"

    __str__ = __repr__


@dataclass(frozen=True)
class Settings:
    environment: Literal["test", "development", "production"]
    database_url: Secret
    service_token_key: Secret
    ai_provider: Provider
    ai_provider_key: Secret | None
    ai_model: str
    ai_kill_switch: bool
    embedder: Embedder
    storage_budget_bytes: int
    log_level: str
    db_pool_max: int
    search_engine: Literal["memory", "sql"] = "memory"
    search_memory_bytes: int = 1024 * 1024 * 1024
    # Content keys (decision D41, step 4b). The same names as the API's settings.
    key_service: Literal["none", "local", "google-kms"] = "none"
    local_keys: tuple[tuple[str, Secret], ...] = ()      # name -> base64 key; KEY_SERVICE=local only, never in production
    platform_content_key: str | None = None              # the platform's content key: a Cloud KMS key name, or local:<name>

    def local_key_bytes(self) -> dict[str, bytes]:
        return {name: base64.b64decode(secret.reveal()) for name, secret in self.local_keys}


def _bundle(env: dict[str, str]) -> dict[str, str]:
    """The cloud groups the service's secrets into one JSON value (AI_SERVICE_CONFIG)."""
    raw = env.get("AI_SERVICE_CONFIG")
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ConfigError("AI_SERVICE_CONFIG is not valid JSON") from exc
    if not isinstance(data, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in data.items()):
        raise ConfigError("AI_SERVICE_CONFIG must be a JSON object of strings")
    return data


def load_settings(env: dict[str, str] | None = None) -> Settings:
    source = dict(os.environ if env is None else env)
    merged = {**_bundle(source), **{k: v for k, v in source.items() if k != "AI_SERVICE_CONFIG"}}

    def need(name: str) -> str:
        value = merged.get(name, "").strip()
        if not value:
            raise ConfigError(f"{name} is required")
        return value

    environment = merged.get("ENVIRONMENT", "production")
    if environment not in ("test", "development", "production"):
        raise ConfigError("ENVIRONMENT must be test, development or production")

    key = need("SERVICE_TOKEN_KEY")
    if len(key) < 32:
        raise ConfigError("SERVICE_TOKEN_KEY must be at least 32 characters")

    provider = merged.get("AI_PROVIDER", "fake")
    if provider not in ("fake", "anthropic", "openai"):
        raise ConfigError("AI_PROVIDER must be fake, anthropic or openai")
    provider_key = merged.get("AI_PROVIDER_KEY", "").strip() or None
    if environment == "test" and (provider != "fake" or provider_key is not None):
        # Automated tests never talk to a real provider - and never even hold a key.
        raise ConfigError("ENVIRONMENT=test allows only AI_PROVIDER=fake and no AI_PROVIDER_KEY")
    if provider != "fake" and provider_key is None:
        raise ConfigError("a real AI provider needs AI_PROVIDER_KEY")
    model = merged.get("AI_MODEL", "fake-1" if provider == "fake" else "").strip()
    if not model:
        raise ConfigError("a real AI provider needs AI_MODEL (a model with a recorded price)")

    embedder = merged.get("EMBEDDER", "local" if environment == "production" else "fake")
    if embedder not in ("fake", "local"):
        raise ConfigError("EMBEDDER must be fake or local")

    try:
        budget = int(merged.get("STORAGE_BUDGET_BYTES", str(500 * 1024 * 1024)))
        pool_max = int(merged.get("DB_POOL_MAX", "4"))
    except ValueError as exc:
        raise ConfigError("STORAGE_BUDGET_BYTES and DB_POOL_MAX must be whole numbers") from exc
    if budget < 10 * 1024 * 1024 or not 1 <= pool_max <= 20:
        raise ConfigError("STORAGE_BUDGET_BYTES or DB_POOL_MAX out of range")

    # Search in memory (decision D41, step 4a; the founder's choice of 2026-10-25: 1 GB for all companies together).
    # SEARCH_ENGINE=sql is the fallback to the database search until it is removed.
    search_engine = merged.get("SEARCH_ENGINE", "memory")
    if search_engine not in ("memory", "sql"):
        raise ConfigError("SEARCH_ENGINE must be memory or sql")
    try:
        search_mb = int(merged.get("SEARCH_MEMORY_MB", "1024"))
    except ValueError as exc:
        raise ConfigError("SEARCH_MEMORY_MB must be a whole number") from exc
    if not 64 <= search_mb <= 16384:
        raise ConfigError("SEARCH_MEMORY_MB must be between 64 and 16384")

    key_service = merged.get("KEY_SERVICE", "none")
    if key_service not in ("none", "local", "google-kms"):
        raise ConfigError("KEY_SERVICE must be none, local or google-kms")
    local_keys: list[tuple[str, Secret]] = []
    if key_service == "local":
        if environment == "production":
            raise ConfigError("KEY_SERVICE=local keeps keys in the configuration and is not allowed in production")
        try:
            parsed = json.loads(merged.get("LOCAL_KEY_SERVICE_KEYS", ""))
        except json.JSONDecodeError:
            parsed = None
        if not isinstance(parsed, dict) or not parsed:
            raise ConfigError("LOCAL_KEY_SERVICE_KEYS must be a JSON object of key name -> base64 32-byte key (KEY_SERVICE=local)")
        for name, b64 in parsed.items():
            if not re.fullmatch(r"[a-z0-9-]{1,40}", name) or not isinstance(b64, str):
                raise ConfigError("LOCAL_KEY_SERVICE_KEYS: key names are 1-40 of a-z, 0-9 and -; keys are base64 strings")
            try:
                raw = base64.b64decode(b64, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise ConfigError(f"LOCAL_KEY_SERVICE_KEYS.{name} is not base64") from exc
            if len(raw) != 32:
                raise ConfigError(f"LOCAL_KEY_SERVICE_KEYS.{name} must be 32 bytes")
            local_keys.append((name, Secret(b64)))
    platform_content_key = merged.get("PLATFORM_CONTENT_KEY", "").strip() or None
    if platform_content_key is not None and key_service == "none":
        raise ConfigError("PLATFORM_CONTENT_KEY needs a key service (KEY_SERVICE)")
    if environment == "production" and platform_content_key is None:
        # every company's content is sealed (decision D41): without a platform content key nothing could be written
        raise ConfigError("PLATFORM_CONTENT_KEY is required in production (with KEY_SERVICE=google-kms)")

    return Settings(
        environment=environment,  # type: ignore[arg-type]
        database_url=Secret(need("DATABASE_URL")),
        service_token_key=Secret(key),
        ai_provider=provider,  # type: ignore[arg-type]
        ai_provider_key=Secret(provider_key) if provider_key else None,
        ai_model=model,
        ai_kill_switch=merged.get("AI_KILL_SWITCH", "false").lower() in ("1", "true", "yes", "on"),
        embedder=embedder,  # type: ignore[arg-type]
        storage_budget_bytes=budget,
        log_level=merged.get("LOG_LEVEL", "info"),
        db_pool_max=pool_max,
        search_engine=search_engine,  # type: ignore[arg-type]
        search_memory_bytes=search_mb * 1024 * 1024,
        key_service=key_service,  # type: ignore[arg-type]
        local_keys=tuple(local_keys),
        platform_content_key=platform_content_key,
    )
