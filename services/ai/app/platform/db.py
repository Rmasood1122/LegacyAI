"""Database access. The only way to run SQL against company data is `tenant_tx(tenant_id)`:
one transaction, with the company set for that transaction only (row-level security does
the rest). The service refuses to start with a login that could bypass row-level security.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import psycopg
from pgvector.psycopg import register_vector
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool


class UnsafeDatabaseRole(Exception):
    pass


def _configure(conn: psycopg.Connection[Any]) -> None:
    register_vector(conn)


class Database:
    def __init__(self, url: str, pool_max: int = 4) -> None:
        # prepare_threshold=None: transaction-mode poolers (Neon's pooled host) reject prepared statements.
        self._pool = ConnectionPool(
            url, min_size=0, max_size=pool_max, open=True, configure=_configure,
            kwargs={"prepare_threshold": None, "row_factory": dict_row, "autocommit": True},
        )

    def close(self) -> None:
        self._pool.close()

    @contextmanager
    def tenant_tx(self, tenant_id: str) -> Iterator[psycopg.Cursor[dict[str, Any]]]:
        """One transaction for one company. Commits on success, rolls back on any exception."""
        str(uuid.UUID(tenant_id))  # refuses anything that is not a UUID
        with self._pool.connection() as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
                    cur.execute("SELECT set_config('statement_timeout', '15000', true)")
                    yield cur

    @contextmanager
    def global_cursor(self) -> Iterator[psycopg.Cursor[dict[str, Any]]]:
        """For GLOBAL tables only (no company is set; row-level security returns nothing of a company)."""
        with self._pool.connection() as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    yield cur

    def assert_safe_role(self) -> None:
        with self.global_cursor() as cur:
            cur.execute("SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user")
            row = cur.fetchone()
        if row is None:
            raise UnsafeDatabaseRole("could not read the current database role")
        if row["rolsuper"] or row["rolbypassrls"] or row["rolcreaterole"]:
            raise UnsafeDatabaseRole("the database login can bypass row-level security or manage roles")

    def ping(self) -> bool:
        try:
            with self.global_cursor() as cur:
                cur.execute("SELECT 1")
            return True
        except psycopg.Error:
            return False
