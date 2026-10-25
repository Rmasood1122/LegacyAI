"""Companies' search indexes in memory (decision D41, step 4a; the founder's choices of 2026-10-25): kept 5 minutes,
rebuilt when the company's chunks change, 1 GB for all companies together with the least recently asked dropped first,
a warning above 50,000 chunks. Synthetic companies only."""

from __future__ import annotations

from typing import Any

import psycopg
import pytest

from app.ai_gateway import FakeEmbedder
from app.capture import SearchCache
from app.knowledge import answers
from app.platform import ConfigError, Database, load_settings
from tests.conftest import World, make_world, needs_db
from tests.integration.helpers import company_document

pytestmark = [pytest.mark.db, needs_db]

PUMP = "Restart the cooling pump P-7 after a power cut: open valve V-2, then press start."
BOILER = "The boiler relief valve is tested every Monday by the shift lead."


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


class Warnings:
    def __init__(self) -> None:
        self.seen: list[tuple[str, dict[str, Any]]] = []

    def warn(self, msg: str, **fields: Any) -> None:
        self.seen.append((msg, fields))


def version(admin: psycopg.Connection[dict[str, Any]], tenant_id: str) -> int:
    row = admin.execute("SELECT search_version FROM tenant_usage_counters WHERE tenant_id = %s", (tenant_id,)).fetchone()
    return int(row["search_version"]) if row else 0


def ask(db: Database, world: World, question: str, cache: SearchCache | None) -> list[str]:
    return [c["id"] for c in answers.candidate_ids(db, world.ctx("reviewer", "knowledge.candidates"), FakeEmbedder(), question, None,
                                                   search=cache)]


def test_every_change_to_a_companys_chunks_moves_its_search_version(db: Database, world: World,
                                                                   admin: psycopg.Connection[dict[str, Any]]) -> None:
    embedder = FakeEmbedder()
    before = version(admin, world.tenant_id)
    source = company_document(db, world, embedder, PUMP)                 # written by the AI service's own role
    after_insert = version(admin, world.tenant_id)
    assert after_insert > before
    other = make_world(admin)
    other_before = version(admin, other.tenant_id)
    with admin.transaction():
        admin.execute("SELECT set_config('app.tenant_id', %s, true)", (world.tenant_id,))
        admin.execute("UPDATE chunks SET verification_status = verification_status WHERE source_id = %s", (source,))
    assert version(admin, world.tenant_id) > after_insert                # any update counts
    assert version(admin, other.tenant_id) == other_before               # another company is untouched


def test_an_index_is_reused_then_rebuilt_after_a_change_or_five_minutes(db: Database, world: World) -> None:
    embedder = FakeEmbedder()
    clock = Clock()
    cache = SearchCache(clock=clock)
    pump_source = company_document(db, world, embedder, PUMP)
    first = ask(db, world, "cooling pump restart", cache)
    assert set(first) == set(chunk_ids_of_source_db(db, world, pump_source))
    ask(db, world, "power cut", cache)
    assert cache.builds == 1                                             # the same index, no rebuild

    boiler_source = company_document(db, world, embedder, BOILER)       # a new document: the version moved
    found = ask(db, world, "boiler relief valve", cache)
    assert cache.builds == 2
    assert set(chunk_ids_of_source_db(db, world, boiler_source)) <= set(found)

    clock.now += 299
    ask(db, world, "boiler", cache)
    assert cache.builds == 2
    clock.now += 2                                                       # more than 5 minutes after it was built
    ask(db, world, "boiler", cache)
    assert cache.builds == 3


def chunk_ids_of_source_db(db: Database, world: World, source_id: str) -> list[str]:
    with db.tenant_tx(world.tenant_id) as cur:
        cur.execute("SELECT id::text AS id FROM chunks WHERE source_id = %s", (source_id,))
        return [r["id"] for r in cur.fetchall()]


def test_the_memory_limit_drops_the_company_asked_for_the_longest(db: Database, admin: psycopg.Connection[dict[str, Any]]) -> None:
    embedder = FakeEmbedder()
    worlds = [make_world(admin) for _ in range(3)]
    for w in worlds:
        company_document(db, w, embedder, PUMP)
    probe = SearchCache()
    ask(db, worlds[0], "pump", probe)
    one = probe.bytes_used
    cache = SearchCache(max_bytes=int(one * 2.5))                       # room for two companies
    for w in worlds[:2]:
        ask(db, w, "pump", cache)
    ask(db, worlds[0], "pump", cache)                                    # company 0 asked again: company 1 is the oldest now
    ask(db, worlds[2], "pump", cache)
    assert cache.companies() == [worlds[0].tenant_id, worlds[2].tenant_id]
    assert cache.bytes_used <= cache.max_bytes


def test_a_company_bigger_than_the_limit_is_searched_but_not_kept_and_large_ones_are_reported(
        db: Database, world: World) -> None:
    company_document(db, world, FakeEmbedder(), PUMP)
    warnings = Warnings()
    cache = SearchCache(max_bytes=1, warn_chunks=0, log=warnings)
    assert ask(db, world, "cooling pump", cache) != []
    assert cache.companies() == [] and cache.bytes_used == 0
    messages = [m for m, _ in warnings.seen]
    assert messages == ["search: a large company", "search: a company's index is larger than the memory limit; not kept"]
    assert all(set(f) <= {"tenant_id", "chunks", "limit", "bytes"} for _, f in warnings.seen)   # counts only, never text


def test_the_sql_fallback_finds_the_same(db: Database, world: World) -> None:
    company_document(db, world, FakeEmbedder(), PUMP)
    company_document(db, world, FakeEmbedder(), BOILER)
    for question in ("cooling pump restart", "boiler relief valve", "who tests the valve"):
        assert ask(db, world, question, None) == ask(db, world, question, SearchCache())


def test_the_search_settings() -> None:
    base = {"ENVIRONMENT": "test", "DATABASE_URL": "postgres://x", "SERVICE_TOKEN_KEY": "k" * 40}
    s = load_settings(base)
    assert s.search_engine == "memory" and s.search_memory_bytes == 1024 * 1024 * 1024     # the founder's 1 GB
    assert load_settings({**base, "SEARCH_ENGINE": "sql", "SEARCH_MEMORY_MB": "512"}).search_memory_bytes == 512 * 1024 * 1024
    for bad in ({"SEARCH_ENGINE": "elastic"}, {"SEARCH_MEMORY_MB": "10"}, {"SEARCH_MEMORY_MB": "lots"}):
        with pytest.raises(ConfigError):
            load_settings({**base, **bad})
