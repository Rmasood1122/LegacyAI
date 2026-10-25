"""Which key a company's content is sealed with (decision D41, step 4b part 1): the company's own key when it brought
one, otherwise a data key of its own wrapped by the platform's content key, made on first use. Stand-ins only: a
local key service with made-up keys; no cloud account."""

from __future__ import annotations

import threading
from typing import Any

import psycopg
import pytest

from app.platform import ContentKeys, Database, KeyUnavailable
from app.platform.sealing import LocalKeyService, wrap_aad
from tests.conftest import World, make_world, needs_db

pytestmark = [pytest.mark.db, needs_db]

PLATFORM_KEY = bytes([11]) * 32          # made-up keys, in this file only
COMPANY_KEY = bytes([22]) * 32


def service() -> LocalKeyService:
    return LocalKeyService({"platform": PLATFORM_KEY, "acme": COMPANY_KEY})


def keys(local: LocalKeyService | None = None, platform: str | None = "local:platform") -> ContentKeys:
    return ContentKeys(local or service(), platform)


def write_key(db: Database, ck: ContentKeys, tenant: str) -> tuple[str, bytes]:
    with db.tenant_tx(tenant) as cur:
        return ck.for_writing(cur, tenant)


def read_key(db: Database, ck: ContentKeys, tenant: str, key_id: str) -> bytes:
    with db.tenant_tx(tenant) as cur:
        return ck.for_reading(cur, tenant, key_id)


def platform_rows(admin: psycopg.Connection[dict[str, Any]], tenant: str) -> list[dict[str, Any]]:
    return admin.execute("SELECT version, key_ref, wrapped_key, retired_at FROM content_data_keys WHERE tenant_id = %s ORDER BY version",
                         (tenant,)).fetchall()


def give_own_key(admin: psycopg.Connection[dict[str, Any]], tenant: str, version: int = 1) -> None:
    """What the API's setKey stores when a company brings its key (here wrapped by the made-up local key "acme")."""
    import os

    wrapped = LocalKeyService({"acme": COMPANY_KEY}).wrap("local:acme", os.urandom(32), wrap_aad(tenant, version))
    with admin.transaction():
        admin.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant,))
        admin.execute("UPDATE company_data_keys SET retired_at = now() WHERE tenant_id = %s AND retired_at IS NULL", (tenant,))
        admin.execute("INSERT INTO company_data_keys (tenant_id, version, key_ref, wrapped_key) VALUES (%s, %s, 'local:acme', %s)",
                      (tenant, version, wrapped))


def test_a_company_without_its_own_key_gets_one_wrapped_by_the_platform_key_once(
        db: Database, world: World, admin: psycopg.Connection[dict[str, Any]]) -> None:
    ck = keys()
    key_id, key = write_key(db, ck, world.tenant_id)
    assert key_id == "platform:1" and len(key) == 32
    rows = platform_rows(admin, world.tenant_id)
    assert len(rows) == 1 and rows[0]["key_ref"] == "local:platform" and rows[0]["retired_at"] is None
    assert key not in bytes(rows[0]["wrapped_key"])                              # only the wrapped form is stored
    assert write_key(db, keys(), world.tenant_id) == (key_id, key)               # another instance: the same key, no new row
    assert len(platform_rows(admin, world.tenant_id)) == 1
    assert read_key(db, keys(), world.tenant_id, "platform:1") == key


def test_two_first_writes_at_once_make_one_key(db: Database, admin: psycopg.Connection[dict[str, Any]]) -> None:
    world = make_world(admin)
    got: list[tuple[str, bytes]] = []
    threads = [threading.Thread(target=lambda: got.append(write_key(db, keys(), world.tenant_id))) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(got) == 2 and got[0] == got[1]
    assert len(platform_rows(admin, world.tenant_id)) == 1


def test_without_a_platform_key_nothing_is_made(db: Database, world: World, admin: psycopg.Connection[dict[str, Any]]) -> None:
    for ck in (keys(platform=None), keys(platform="local:nobody"), keys(platform="projects/x")):
        with pytest.raises(KeyUnavailable):
            write_key(db, ck, world.tenant_id)
    assert platform_rows(admin, world.tenant_id) == []
    local = service()
    local.disable("platform")                                                    # the platform key is switched off
    with pytest.raises(KeyUnavailable):
        write_key(db, keys(local), world.tenant_id)
    assert platform_rows(admin, world.tenant_id) == []


def test_a_company_with_its_own_key_uses_it_and_never_falls_back_to_the_platform(
        db: Database, world: World, admin: psycopg.Connection[dict[str, Any]]) -> None:
    give_own_key(admin, world.tenant_id)
    local = service()
    key_id, key = write_key(db, keys(local), world.tenant_id)
    assert key_id == "company:1" and len(key) == 32
    assert platform_rows(admin, world.tenant_id) == []
    local.disable("acme")                                                        # the company switches its key off
    with pytest.raises(KeyUnavailable):
        write_key(db, keys(local), world.tenant_id)
    with pytest.raises(KeyUnavailable):
        read_key(db, keys(local), world.tenant_id, "company:1")
    assert platform_rows(admin, world.tenant_id) == []                           # not sealed with the platform key instead


def test_after_a_company_clears_its_key_new_content_uses_the_platform_key_and_old_content_still_opens(
        db: Database, world: World, admin: psycopg.Connection[dict[str, Any]]) -> None:
    give_own_key(admin, world.tenant_id)
    old_id, old_key = write_key(db, keys(), world.tenant_id)
    with admin.transaction():
        admin.execute("SELECT set_config('app.tenant_id', %s, true)", (world.tenant_id,))
        admin.execute("UPDATE company_data_keys SET retired_at = now() WHERE tenant_id = %s", (world.tenant_id,))
    new_id, new_key = write_key(db, keys(), world.tenant_id)
    assert (old_id, new_id) == ("company:1", "platform:1") and old_key != new_key
    assert read_key(db, keys(), world.tenant_id, old_id) == old_key


def test_keys_are_per_company_and_one_company_cannot_open_anothers(db: Database, admin: psycopg.Connection[dict[str, Any]]) -> None:
    a, b = make_world(admin), make_world(admin)
    a_id, a_key = write_key(db, keys(), a.tenant_id)
    _, b_key = write_key(db, keys(), b.tenant_id)
    assert a_key != b_key
    with pytest.raises(KeyUnavailable), db.tenant_tx(b.tenant_id) as cur:      # company b's transaction cannot see a's row
        keys().for_reading(cur, a.tenant_id, a_id)


def test_a_key_version_cannot_be_changed_or_removed_by_the_ai_service(db: Database, world: World) -> None:
    write_key(db, keys(), world.tenant_id)
    for sql in ("UPDATE content_data_keys SET wrapped_key = '\\x00' || wrapped_key WHERE tenant_id = %s",
                "DELETE FROM content_data_keys WHERE tenant_id = %s"):
        with pytest.raises(psycopg.Error), db.tenant_tx(world.tenant_id) as cur:
            cur.execute(sql, (world.tenant_id,))
