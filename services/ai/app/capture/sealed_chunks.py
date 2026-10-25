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

import base64
from collections.abc import Iterable, Sequence
from typing import Any

import psycopg
from pgvector import HalfVector

from app.platform import ContentKeys, FieldRef, active_content_keys, fingerprint, open_text, open_vector, seal_text, seal_vector


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


class Fields:
    """Seals and opens single text fields of other tables the same way (decision D41, step 4b part 3): knowledge
    versions ("version:<item id>:<version no>") and interview turns ("turn:<interview id>:<ordinal>"). One instance per
    company and transaction. Without content keys a field is written readable; reading accepts both forms."""

    def __init__(self, cur: psycopg.Cursor[Any], tenant_id: str, table: str, keys: ContentKeys | None = None) -> None:
        self.cur = cur
        self.tenant_id = tenant_id
        self.table = table
        self.keys = keys if keys is not None else active_content_keys()
        self._keys: dict[str, bytes] = {}
        self._write: str | None = None

    def _ref(self, row_key: str, column: str, key_id: str) -> FieldRef:
        return FieldRef(tenant_id=self.tenant_id, table=self.table, column=column, row_id=row_key, key_id=key_id)

    def _key(self, key_id: str) -> bytes:
        if key_id not in self._keys:
            if self.keys is None:
                raise RuntimeError("a sealed value needs content keys")
            self._keys[key_id] = self.keys.for_reading(self.cur, self.tenant_id, key_id)
        return self._keys[key_id]

    def seal(self, row_key: str, column: str, text: str, key_id: str | None = None) -> tuple[str | None, bytes | None, str | None]:
        """(readable, sealed, key id) to store. `key_id`: a key the row already uses (its other fields), else the
        company's current one; without content keys the value stays readable."""
        if self.keys is None:
            return text, None, None
        if key_id is None:
            if self._write is None:
                self._write, content_key = self.keys.for_writing(self.cur, self.tenant_id)
                self._keys[self._write] = content_key
            key_id = self._write
        return None, seal_text(self._key(key_id), text, self._ref(row_key, column, key_id)), key_id

    def fingerprint(self, column: str, text: str, key_id: str) -> bytes:
        """The keyed fingerprint of `text` in `column` under the key `key_id` (equal texts, equal fingerprints)."""
        return fingerprint(self._key(key_id), text, self._ref("fingerprint", column, key_id))

    def open(self, row_key: str, column: str, readable: str | None, sealed: bytes | memoryview | None, key_id: str | None) -> str | None:
        """The text, from whichever form the row holds (None when neither: an unanswered question, say)."""
        if sealed is None:
            return readable
        if key_id is None:
            raise RuntimeError("a sealed value without its key id")
        return open_text(self._key(key_id), bytes(sealed), self._ref(row_key, column, key_id))


def version_key(item_id: str, version_no: int) -> str:
    return f"version:{item_id}:{version_no}"


def turn_key(interview_id: str, ordinal: int) -> str:
    return f"turn:{interview_id}:{ordinal}"


# Step 6 (part 1): questions people ask, questions put to an expert, readers' comments on answers.
def answer_key(answer_id: str) -> str:
    return f"answer:{answer_id}"


def expert_question_key(question_id: str) -> str:
    return f"expert_question:{question_id}"


def feedback_key(answer_id: str, card_id: str) -> str:
    return f"feedback:{answer_id}:{card_id}"


# Step 6 (part 2): knowledge items' titles and the words a stored conflict quotes from two items.
def item_title_columns(alias: str) -> str:
    """The columns a reader selects from knowledge_items (alias `alias`) to open the title with open_item_title()."""
    return f"{alias}.title, {alias}.title_sealed, {alias}.sealed_key AS title_key"


def item_title_json(alias: str) -> str:
    """The same columns inside jsonb_build_object (the sealed bytes as base64), for open_item_title()."""
    return f"'title', {alias}.title, 'title_sealed', encode({alias}.title_sealed, 'base64'), 'title_key', {alias}.sealed_key"


def open_item_title(fields: Fields, row: dict[str, Any], id_column: str = "id") -> dict[str, Any]:
    """Replaces the title columns of `row` by the opened title ('' once erased). `fields` is for table knowledge_items."""
    sealed = row.pop("title_sealed", None)
    if isinstance(sealed, str):            # from jsonb: base64
        sealed = base64.b64decode(sealed)
    row["title"] = fields.open(f"item:{row[id_column]}", "title", row.get("title"), sealed, row.pop("title_key", None)) or ""
    return row


# Step 6 (part 4a): a document's title, bound to "source:<id>" in table sources. The aliases differ from an item
# title's on purpose: a row can carry both.
def source_title_columns(alias: str) -> str:
    """The columns a reader selects from sources (alias `alias`) to open the title with open_source_title()."""
    return f"{alias}.title, {alias}.title_sealed AS source_title_sealed, {alias}.sealed_key AS source_title_key"


def seal_source_title(cur: psycopg.Cursor[Any], tenant_id: str, source_id: str, title: str) -> dict[str, Any]:
    """The values for title, title_sealed and sealed_key of a document."""
    readable, sealed, key_id = Fields(cur, tenant_id, "sources").seal(f"source:{source_id}", "title", title)
    return {"title": readable, "title_sealed": sealed, "sealed_key": key_id}


def open_source_title(fields: Fields, row: dict[str, Any], id_column: str = "id") -> dict[str, Any]:
    """Replaces the title columns of `row` by the opened title ('' once erased). `fields` is for table sources."""
    row["title"] = fields.open(f"source:{row[id_column]}", "title", row.get("title"), row.pop("source_title_sealed", None),
                               row.pop("source_title_key", None)) or ""
    return row


# Step 6 (part 4b): a topic's name and description, bound to "topic:<id>" in table topics. Names stay unique per company
# in any case although they are sealed: name_hash is a keyed fingerprint of the name in lower case, under the key the
# row is sealed with. Readable rows (written before) keep the database's own rule (unique lower(name)).
def topic_text_columns(alias: str) -> str:
    """The columns a reader selects from topics (alias `alias`) to open name and description with open_topic()."""
    return (f"{alias}.name, {alias}.name_sealed AS topic_name_sealed, {alias}.description, "
            f"{alias}.description_sealed AS topic_description_sealed, {alias}.sealed_key AS topic_key")


def open_topic(fields: Fields, row: dict[str, Any], id_column: str = "id") -> dict[str, Any]:
    """Replaces the text columns of `row` by the opened name and description. `fields` is for table topics."""
    key = row.pop("topic_key", None)
    row["name"] = fields.open(f"topic:{row[id_column]}", "name", row.get("name"), row.pop("topic_name_sealed", None), key) or ""
    row["description"] = fields.open(f"topic:{row[id_column]}", "description", row.get("description"),
                                     row.pop("topic_description_sealed", None), key) or ""
    return row


def seal_topic(fields: Fields, topic_id: str, name: str, description: str) -> dict[str, Any]:
    """The values for name, name_sealed, description, description_sealed, sealed_key and name_hash of a topic."""
    readable, name_sealed, key_id = fields.seal(f"topic:{topic_id}", "name", name)
    if key_id is None:
        return {"name": readable, "name_sealed": None, "description": description, "description_sealed": None, "sealed_key": None,
                "name_hash": None}
    _, description_sealed, _ = fields.seal(f"topic:{topic_id}", "description", description, key_id=key_id)
    return {"name": None, "name_sealed": name_sealed, "description": None, "description_sealed": description_sealed, "sealed_key": key_id,
            "name_hash": fields.fingerprint("name", name.lower(), key_id)}


def topic_name_match(fields: Fields, name: str, alias: str = "tp") -> tuple[str, list[Any]]:
    """The condition "this topic has the name `name`, in any case", for readable and sealed rows alike: one fingerprint
    per key the company's topics are sealed with. Hold lock_topic_names() while it decides anything. Without content
    keys (development and tests that switch them off) only readable names are compared."""
    if fields.keys is None:
        return f"lower({alias}.name) = lower(%s)", [name]
    fields.cur.execute("SELECT DISTINCT sealed_key FROM topics WHERE tenant_id = %s AND sealed_key IS NOT NULL", (fields.tenant_id,))
    hashes = [fields.fingerprint("name", name.lower(), r["sealed_key"]) for r in fields.cur.fetchall()]
    return f"(lower({alias}.name) = lower(%s) OR {alias}.name_hash = ANY(%s::bytea[]))", [name, hashes]


def lock_topic_names(cur: psycopg.Cursor[Any], tenant_id: str) -> None:
    """One writer of a company's topic names at a time (until the transaction ends), so a check for a name and the
    write that follows cannot be overtaken by another request."""
    cur.execute("SELECT pg_advisory_xact_lock(hashtext('topic-names:' || %s))", (tenant_id,))


def conflict_key(item_id: str, other_item_id: str) -> str:
    return f"conflict:{item_id}:{other_item_id}"


def new_row_id(cur: psycopg.Cursor[Any]) -> str:
    """A row id taken before the insert, so a value can be sealed to its row (the same time-ordered ids the tables use)."""
    cur.execute("SELECT uuidv7()::text AS id")
    row = cur.fetchone()
    if row is None:   # pragma: no cover - the function always returns a row
        raise RuntimeError("no id")
    return str(row["id"])


# The columns a reader of a knowledge version (alias v) selects to open its text with version_text().
VERSION_TEXT = "v.body, v.body_sealed, v.sealed_key AS body_key, v.item_id::text AS version_item_id, v.version_no AS version_number"


def version_text(fields: Fields, row: dict[str, Any]) -> str:
    """A knowledge version's text, sealed or readable ('' once erased)."""
    return fields.open(version_key(row["version_item_id"], row["version_number"]), "body", row["body"], row["body_sealed"], row["body_key"]) or ""
