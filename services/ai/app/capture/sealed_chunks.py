"""Sealing chunks (decision D41, step 4b part 2): every place that writes or reads a chunk's text or vector goes
through here, so the rules are in one place.

- A chunk is written SEALED when the service has content keys (always in production): text_sealed and
  embedding_sealed hold the text and the vector encrypted with the company's content key, sealed_key names the key,
  and the readable columns stay empty. Without content keys (tests and development that switch them off) it is written
  readable, as before.
- Each sealed value is bound to its exact place: the company, the table, the column and the chunk's natural key
  ("source:<source id>:<ordinal>" or "item:<item id>", unique per company), so a value copied to another chunk,
  column or company does not open.
- Reading accepts both forms: chunks written before this step stay readable until step 5 seals them.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from typing import Any

import psycopg
from pgvector import HalfVector

from app.platform import ContentKeys, FieldRef, active_content_keys, open_text, open_vector, seal_text, seal_vector


def row_key(*, kind: str, source_id: str | None, ordinal: int | None, knowledge_item_id: str | None) -> str:
    """The chunk's natural key, unique within its company (the indexes chunks_source_ordinal and chunks_item)."""
    if kind == "item":
        return f"item:{knowledge_item_id}"
    return f"source:{source_id}:{ordinal}"


def _ref(tenant_id: str, key: str, column: str, key_id: str) -> FieldRef:
    return FieldRef(tenant_id=tenant_id, table="chunks", column=column, row_id=key, key_id=key_id)


class Sealer:
    """Seals the chunks of one company inside one transaction (one key lookup per transaction)."""

    def __init__(self, cur: psycopg.Cursor[Any], tenant_id: str, keys: ContentKeys | None = None) -> None:
        self.cur = cur
        self.tenant_id = tenant_id
        self.keys = keys if keys is not None else active_content_keys()
        self._write: tuple[str, bytes] | None = None

    @property
    def sealing(self) -> bool:
        return self.keys is not None

    def _write_key(self) -> tuple[str, bytes]:
        if self.keys is None:
            raise RuntimeError("no content keys")
        if self._write is None:
            self._write = self.keys.for_writing(self.cur, self.tenant_id)
        return self._write

    def text_columns(self, key: str, text: str) -> dict[str, Any]:
        """The values for text, text_sealed and sealed_key."""
        if not self.sealing:
            return {"text": text, "text_sealed": None, "sealed_key": None}
        key_id, content_key = self._write_key()
        return {"text": None, "text_sealed": seal_text(content_key, text, _ref(self.tenant_id, key, "text", key_id)), "sealed_key": key_id}

    def vector_columns(self, key: str, vector: Sequence[float], sealed_key: str | None) -> dict[str, Any]:
        """The values for embedding and embedding_sealed. A sealed chunk's vector is sealed with the key its text was."""
        if sealed_key is None:
            return {"embedding": HalfVector(list(vector)), "embedding_sealed": None}
        if self.keys is None:
            raise RuntimeError("a sealed chunk needs content keys")
        content_key = self.keys.for_reading(self.cur, self.tenant_id, sealed_key)
        return {"embedding": None, "embedding_sealed": seal_vector(content_key, vector, _ref(self.tenant_id, key, "embedding", sealed_key))}


class Opener:
    """Opens sealed chunks of one company; leaves readable ones as they are."""

    def __init__(self, cur: psycopg.Cursor[Any], tenant_id: str, keys: ContentKeys | None = None) -> None:
        self.cur = cur
        self.tenant_id = tenant_id
        self.keys = keys if keys is not None else active_content_keys()
        self._keys: dict[str, bytes] = {}

    def _key(self, key_id: str) -> bytes:
        if key_id not in self._keys:
            if self.keys is None:
                raise RuntimeError("a sealed chunk needs content keys")
            self._keys[key_id] = self.keys.for_reading(self.cur, self.tenant_id, key_id)
        return self._keys[key_id]

    def text(self, row: dict[str, Any]) -> str:
        """The row needs: text, text_sealed, sealed_key, kind, source_id, ordinal, knowledge_item_id."""
        if row.get("text_sealed") is None:
            return str(row["text"])
        key = row_key(kind=row["kind"], source_id=row["source_id"], ordinal=row["ordinal"], knowledge_item_id=row["knowledge_item_id"])
        return open_text(self._key(row["sealed_key"]), bytes(row["text_sealed"]), _ref(self.tenant_id, key, "text", row["sealed_key"]))

    def vector(self, row: dict[str, Any]) -> list[float] | None:
        """As text(), plus embedding and embedding_sealed. None when the chunk has no vector yet."""
        if row.get("embedding_sealed") is None:
            return None if row.get("embedding") is None else [float(x) for x in row["embedding"].to_list()]
        key = row_key(kind=row["kind"], source_id=row["source_id"], ordinal=row["ordinal"], knowledge_item_id=row["knowledge_item_id"])
        return open_vector(self._key(row["sealed_key"]), bytes(row["embedding_sealed"]), _ref(self.tenant_id, key, "embedding", row["sealed_key"]))

    def texts(self, rows: Iterable[dict[str, Any]]) -> list[str]:
        return [self.text(r) for r in rows]


# The columns a reader selects to be able to open a chunk (alias c).
SEALED_COLUMNS = """c.text, c.text_sealed, c.sealed_key, c.kind, c.source_id::text AS source_id, c.ordinal,
                    c.knowledge_item_id::text AS knowledge_item_id"""
