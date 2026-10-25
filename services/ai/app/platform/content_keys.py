"""Which key a company's content is sealed with (decision D41, step 4b; the founder's choices of 2026-10-24/25).

Every company's content is sealed (not only companies with their own key). For writing, a company's content key is:
- the company brought its own key: its LIVE data key (company_data_keys, made by the API, wrapped by the company's
  key). The AI service unwraps it with its own service account. If that key cannot be used, nothing is written: the
  content is never sealed with the platform's key instead (fail closed, as the API does for secrets);
- otherwise: the company's data key in content_data_keys, wrapped by the PLATFORM's content key (a Cloud KMS key in
  the platform's project, PLATFORM_CONTENT_KEY). Made the first time the company needs one.
For reading, the key id stored with each sealed value ("company:3", "platform:1") names the exact data key, retired
versions included: content sealed before a company changed or cleared its key keeps opening while that key works.

Unwrapped keys are kept for at most 5 minutes (KeyCache). Nothing here logs or returns a key's bytes except the
derived content key handed to the caller.
"""

from __future__ import annotations

import os
from typing import Any

import psycopg

from app.platform.sealing import KeyCache, KeyService, KeyUnavailable, parse_key_id, platform_wrap_aad


class ContentKeys:
    def __init__(self, keys: KeyService, platform_ref: str | None, cache: KeyCache | None = None) -> None:
        self.keys = keys
        self.platform_ref = platform_ref
        self.cache = cache or KeyCache(keys)

    def for_writing(self, cur: psycopg.Cursor[Any], tenant_id: str) -> tuple[str, bytes]:
        """(key id, content key) for sealing new content of this company. `cur` is in the company's transaction."""
        cur.execute("SELECT version, key_ref, wrapped_key FROM company_data_keys WHERE tenant_id = %s AND retired_at IS NULL",
                    (tenant_id,))
        own = cur.fetchone()
        if own is not None:
            key_id = f"company:{own['version']}"
            return key_id, self.cache.content_key(tenant_id, key_id, own["key_ref"], bytes(own["wrapped_key"]))
        row = self._live_platform_row(cur, tenant_id) or self._make_platform_key(cur, tenant_id)
        key_id = f"platform:{row['version']}"
        return key_id, self.cache.content_key(tenant_id, key_id, row["key_ref"], bytes(row["wrapped_key"]))

    def for_reading(self, cur: psycopg.Cursor[Any], tenant_id: str, key_id: str) -> bytes:
        """The content key named by a sealed value's key id (retired versions too)."""
        kind, version = parse_key_id(key_id)
        table = "company_data_keys" if kind == "company" else "content_data_keys"
        cur.execute(f"SELECT key_ref, wrapped_key FROM {table} WHERE tenant_id = %s AND version = %s",
                    (tenant_id, version))
        row = cur.fetchone()
        if row is None:
            raise KeyUnavailable("no such data key")
        return self.cache.content_key(tenant_id, key_id, row["key_ref"], bytes(row["wrapped_key"]))

    def forget(self, tenant_id: str) -> None:
        self.cache.forget(tenant_id)

    @staticmethod
    def _live_platform_row(cur: psycopg.Cursor[Any], tenant_id: str) -> dict[str, Any] | None:
        cur.execute("SELECT version, key_ref, wrapped_key FROM content_data_keys WHERE tenant_id = %s AND retired_at IS NULL",
                    (tenant_id,))
        return cur.fetchone()

    def _make_platform_key(self, cur: psycopg.Cursor[Any], tenant_id: str) -> dict[str, Any]:
        ref = self.platform_ref
        if not ref or not self.keys.valid_ref(ref):
            raise KeyUnavailable("no platform content key is configured (PLATFORM_CONTENT_KEY)")
        # one writer at a time per company; another may have made the key while this one waited
        cur.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (f"content-data-key:{tenant_id}",))
        row = self._live_platform_row(cur, tenant_id)
        if row is not None:
            return row
        cur.execute("SELECT coalesce(max(version), 0) + 1 AS v FROM content_data_keys WHERE tenant_id = %s", (tenant_id,))
        version = int(cur.fetchone()["v"])  # type: ignore[index]
        data_key = os.urandom(32)
        aad = platform_wrap_aad(tenant_id, version)
        wrapped = self.keys.wrap(ref, data_key, aad)
        if self.keys.unwrap(ref, wrapped, aad) != data_key:     # prove the key works before anything is sealed with it
            raise KeyUnavailable("the platform content key did not give the data key back")
        cur.execute("INSERT INTO content_data_keys (tenant_id, version, key_ref, wrapped_key) VALUES (%s, %s, %s, %s)",
                    (tenant_id, version, ref, wrapped))
        return {"version": version, "key_ref": ref, "wrapped_key": wrapped}
