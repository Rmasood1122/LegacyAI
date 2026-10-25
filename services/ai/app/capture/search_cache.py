"""Companies' in-memory search indexes, kept for a short time (decision D41, step 4a; founder's choices 2026-10-25).

- An index is built on a company's first question and kept for at most 5 minutes (as long as an unwrapped key, D35).
- It is rebuilt at once when the company's chunks changed: the database counts every change per company
  (tenant_usage_counters.search_version, kept by a trigger), and each question compares that count with the one the
  index was built at. A change by any service or job is seen on the next question.
- All indexes together may use at most 1 GB (SEARCH_MEMORY_MB); when that is exceeded, the company not asked for the
  longest is dropped first and rebuilt on its next question. A company bigger than the whole limit is searched but
  not kept.
- Above 50,000 chunks in one company a warning is logged (counts only): its first question then waits seconds.

The cache holds no text (see memory_search.CompanyIndex). It is per process: two instances of the service each keep
their own, and each sees the same change count.
"""

from __future__ import annotations

import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

import psycopg

from app.capture.memory_search import CompanyIndex
from app.capture.retrieval import load_index

KEEP_SECONDS = 300
MEMORY_BYTES = 1024 * 1024 * 1024
WARN_CHUNKS = 50_000


class Warns(Protocol):
    def warn(self, msg: str, **fields: Any) -> None: ...


@dataclass
class _Kept:
    index: CompanyIndex
    version: int
    built_at: float
    size: int


class SearchCache:
    def __init__(self, *, max_bytes: int = MEMORY_BYTES, keep_seconds: float = KEEP_SECONDS, warn_chunks: int = WARN_CHUNKS,
                 log: Warns | None = None, clock: Callable[[], float] = time.monotonic) -> None:
        self.max_bytes = max_bytes
        self.keep_seconds = keep_seconds
        self.warn_chunks = warn_chunks
        self.log = log
        self.clock = clock
        self.builds = 0                   # how many indexes were built (for tests and measurements)
        self._kept: OrderedDict[tuple[str, str], _Kept] = OrderedDict()
        self._lock = threading.Lock()

    @property
    def bytes_used(self) -> int:
        with self._lock:
            return sum(k.size for k in self._kept.values())

    def companies(self) -> list[str]:
        with self._lock:
            return [tenant for tenant, _ in self._kept]

    def index(self, cur: psycopg.Cursor[Any], *, tenant_id: str, model_id: str) -> CompanyIndex:
        """The company's index, current as of this question. `cur` is inside the company's transaction."""
        cur.execute("SELECT search_version FROM tenant_usage_counters WHERE tenant_id = %s", (tenant_id,))
        row = cur.fetchone()
        version = int(row["search_version"]) if row else 0
        key = (tenant_id, model_id)
        now = self.clock()
        with self._lock:
            kept = self._kept.get(key)
            if kept is not None and kept.version == version and now - kept.built_at < self.keep_seconds:
                self._kept.move_to_end(key)
                return kept.index
            self._kept.pop(key, None)
        index = load_index(cur, tenant_id=tenant_id, model_id=model_id)
        self.builds += 1
        size = index.size_estimate()
        if len(index) > self.warn_chunks and self.log is not None:
            self.log.warn("search: a large company", tenant_id=tenant_id, chunks=len(index), limit=self.warn_chunks)
        if size > self.max_bytes:
            if self.log is not None:
                self.log.warn("search: a company's index is larger than the memory limit; not kept", tenant_id=tenant_id,
                              bytes=size, limit=self.max_bytes)
            return index
        with self._lock:
            self._kept[key] = _Kept(index, version, now, size)
            total = sum(k.size for k in self._kept.values())
            while total > self.max_bytes:
                _, dropped = self._kept.popitem(last=False)     # the company not asked for the longest
                total -= dropped.size
        return index

    def forget(self, tenant_id: str) -> None:
        with self._lock:
            for key in [k for k in self._kept if k[0] == tenant_id]:
                del self._kept[key]


# The cache the service uses unless it is given another (tests and the evaluation share this one).
SEARCH_CACHE = SearchCache()
