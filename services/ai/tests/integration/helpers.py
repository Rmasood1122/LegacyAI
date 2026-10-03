"""Building blocks for database tests. Everything goes through the real code (as the restricted
AI login) except what only the API or an admin may do, which the superuser connection stands in for."""

from __future__ import annotations

import time
from typing import Any

import psycopg

from app.ai_gateway import Embedder
from app.capture import ingest
from app.knowledge import items
from app.platform import Database
from tests.conftest import World


def verified_item(db: Database, world: World, embedder: Embedder, body: str, *, title: str = "Synthetic know-how",
                  sensitivity: int = 1, department_id: str | None = None, author: str = "expert", verifier: str = "reviewer") -> str:
    """A company item (no named contributor) written by `author` and verified by `verifier`."""
    item_id = items.write_manual(db, world.ctx(author, "item.write"), title=title, body=body, department_id=department_id,
                                 sensitivity=sensitivity, contributor_person_id=None)
    items.submit(db, world.ctx(author, "item.submit"), item_id)
    assert items.verify(db, world.ctx(verifier, "item.verify"), item_id, embedder) == "verified"
    return item_id


def company_document(db: Database, world: World, embedder: Embedder, text: str, *, who: str = "owner", title: str = "Synthetic manual",
                     sensitivity: int = 1, department_id: str | None = None) -> str:
    ctx = world.ctx(who, "source.create")
    src = ingest.create_source(db, ctx, title=title, department_id=department_id, sensitivity=sensitivity, contributor_person_id=None,
                               company_document=True, storage_budget_bytes=10**12)
    result = ingest.process_upload(db, world.ctx(who, "source.content"), embedder, src["id"], text.encode(), "text/plain", 10**12,
                                   time.monotonic() + 60)
    assert result["status"] == "ready", result
    return str(src["id"])


def item_chunk_id(admin: psycopg.Connection[dict[str, Any]], item_id: str) -> str:
    row = admin.execute("SELECT id FROM chunks WHERE knowledge_item_id = %s", (item_id,)).fetchone()
    assert row is not None
    return str(row["id"])


def chunk_ids_of_source(admin: psycopg.Connection[dict[str, Any]], source_id: str) -> list[str]:
    return [str(r["id"]) for r in admin.execute("SELECT id FROM chunks WHERE source_id = %s ORDER BY ordinal", (source_id,)).fetchall()]
