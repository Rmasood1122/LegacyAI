"""Platform: configuration, database, service-token check, audit writer, logging.
Other modules import from here only (never from the files inside)."""

from app.platform.audit import write_audit
from app.platform.auth import ReplayGuard, ServiceContext, TokenError, token_id, verify_service_token
from app.platform.config import ConfigError, Secret, Settings, load_settings
from app.platform.content_keys import ContentKeys, active_content_keys, use_content_keys
from app.platform.db import Database, MissingRow, UnsafeDatabaseRole, one
from app.platform.logging import Logger
from app.platform.sealing import FieldRef, KeyUnavailable, fingerprint, key_service_from, open_text, open_vector, seal_text, seal_vector

__all__ = [
    "ConfigError",
    "ContentKeys",
    "Database",
    "FieldRef",
    "KeyUnavailable",
    "Logger",
    "MissingRow",
    "ReplayGuard",
    "Secret",
    "ServiceContext",
    "Settings",
    "TokenError",
    "UnsafeDatabaseRole",
    "active_content_keys",
    "fingerprint",
    "key_service_from",
    "load_settings",
    "one",
    "open_text",
    "open_vector",
    "seal_text",
    "seal_vector",
    "token_id",
    "use_content_keys",
    "verify_service_token",
    "write_audit",
]
