"""Configuration. Loaded once at start-up; anything missing or unsafe stops the service.

Every value comes from the environment (in the cloud: Secret Manager). Nothing has a
production default. A real AI provider can never be selected while ENVIRONMENT=test.
"""

from __future__ import annotations

import json
import os
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
    ai_kill_switch: bool
    embedder: Embedder
    storage_budget_bytes: int
    log_level: str
    db_pool_max: int


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

    return Settings(
        environment=environment,  # type: ignore[arg-type]
        database_url=Secret(need("DATABASE_URL")),
        service_token_key=Secret(key),
        ai_provider=provider,  # type: ignore[arg-type]
        ai_provider_key=Secret(provider_key) if provider_key else None,
        ai_kill_switch=merged.get("AI_KILL_SWITCH", "false").lower() in ("1", "true", "yes", "on"),
        embedder=embedder,  # type: ignore[arg-type]
        storage_budget_bytes=budget,
        log_level=merged.get("LOG_LEVEL", "info"),
        db_pool_max=pool_max,
    )
