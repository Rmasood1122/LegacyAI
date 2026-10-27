"""Re-keying, part 2 (decision D41, section 4 of the plan): what a company sealed with its own key before it CLEARED
(or changed) that key is sealed again with the company's current key by the housekeeping job (`upkeep.seal_existing`)
- here the step-6 columns. Part 1 (chunks, knowledge versions, interview turns) is in capture/seal_existing.py and
items.rekey_versions.

Every column here is one sealed text bound to its row ("answer:<id>", "topic:<id>", ...), the same binding new values
are written with, so one routine serves them all: open each sealed column of a row with its old key, seal it again
with the current key (all columns of a row with one key), write it back only while the row is still on the old key.
The database allows exactly this change (content_rekey_allowed, migrations 20261026000100 and 20261027000100).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import psycopg

from app.capture import Fields, retired_company_keys
from app.platform import one


@dataclass(frozen=True)
class SealedColumns:
    table: str
    binding: str                               # SQL: the row's binding, the same text the value was sealed with
    columns: tuple[tuple[str, str], ...]       # (stored column, the column's name in the binding)
    match: tuple[str, ...] = ("id",)           # the columns that find the row again
    where: str = "TRUE"                        # rows that hold nothing (erased) are left alone
    via: str | None = None                     # a function with the owner's rights that writes the row
    fingerprint: tuple[str, str] | None = None  # (stored fingerprint column, the column it is the fingerprint of, lower case)


# The step-6 columns, by the name housekeeping counts them under (the same names as its `sealed_*` counters).
STEPS: dict[str, SealedColumns] = {
    "questions": SealedColumns("answer_logs", "'answer:' || id::text", (("question_sealed", "question"),), via="reseal_answer_log"),
    "expert_questions": SealedColumns("expert_questions", "'expert_question:' || id::text", (("question_sealed", "question"),),
                                      where="erased_at IS NULL"),
    "feedback": SealedColumns("answer_feedback", "'feedback:' || answer_log_id::text || ':' || card_id::text", (("comment_sealed", "comment"),)),
    "titles": SealedColumns("knowledge_items", "'item:' || id::text", (("title_sealed", "title"),)),
    "conflicts": SealedColumns("knowledge_item_conflicts", "'conflict:' || item_id::text || ':' || other_item_id::text",
                               (("item_value_sealed", "item_value"), ("other_value_sealed", "other_value")), match=("item_id", "other_item_id")),
    "quiz_questions": SealedColumns("quiz_items", "'quiz_item:' || id::text", (("content_sealed", "content"),), where="erased_at IS NULL"),
    "quiz_answers": SealedColumns("quiz_answers", "'quiz_answer:' || id::text",
                                  (("answer_sealed", "answer"), ("rubric_result_sealed", "rubric_result"))),
    "scenarios": SealedColumns("scenarios", "'scenario:' || id::text", (("title_sealed", "title"), ("situation_sealed", "situation"))),
    "scenario_steps": SealedColumns("scenario_steps", "'scenario_step:' || id::text", (("prompt_sealed", "prompt"), ("rubric_sealed", "rubric")),
                                    where="erased_at IS NULL"),
    "scenario_answers": SealedColumns("scenario_answers", "'scenario_answer:' || id::text",
                                      (("answer_sealed", "answer"), ("rubric_result_sealed", "rubric_result"))),
    "document_titles": SealedColumns("sources", "'source:' || id::text", (("title_sealed", "title"),)),
    "topics": SealedColumns("topics", "'topic:' || id::text", (("name_sealed", "name"), ("description_sealed", "description")),
                            fingerprint=("name_hash", "name")),
}


def rekey(cur: psycopg.Cursor[Any], tenant_id: str, spec: SealedColumns, limit: int) -> int:
    """Seals up to `limit` rows of `spec.table` again with the company's current key, where they are still sealed with
    a retired own key. Returns how many were sealed again; raises KeyUnavailable when the old key cannot be used."""
    fields = Fields(cur, tenant_id, spec.table)
    old = retired_company_keys(cur, tenant_id) if fields.keys is not None else []
    if not old:
        return 0
    stored = ", ".join(column for column, _ in spec.columns)
    lock = "" if spec.via else " FOR UPDATE SKIP LOCKED"      # a table written through a function cannot be locked by this login
    cur.execute(f"""SELECT {", ".join(f"{m}::text AS {m}" for m in spec.match)}, {spec.binding} AS binding, {stored}, sealed_key
                      FROM {spec.table} WHERE tenant_id = %s AND sealed_key = ANY(%s) AND {spec.where}
                     ORDER BY {", ".join(spec.match)} LIMIT %s{lock}""", (tenant_id, old, limit))
    done = 0
    for r in cur.fetchall():
        values: dict[str, Any] = {}
        opened: dict[str, str] = {}
        key_id: str | None = None
        for column, name in spec.columns:
            if r[column] is None:                            # an optional column that holds nothing (an erased situation, no answer yet)
                values[column] = None
                continue
            opened[name] = fields.open(r["binding"], name, None, r[column], r["sealed_key"]) or ""
            _, values[column], key_id = fields.seal(r["binding"], name, opened[name], key_id=key_id)
        if key_id is None:
            continue
        if spec.fingerprint is not None:
            values[spec.fingerprint[0]] = fields.fingerprint(spec.fingerprint[1], opened[spec.fingerprint[1]].lower(), key_id)
        if spec.via is not None:
            cur.execute(f"SELECT {spec.via}(%s, %s, %s, %s) AS done", (r["id"], r["sealed_key"], values[spec.columns[0][0]], key_id))
            done += 1 if one(cur)["done"] else 0
            continue
        cur.execute(f"""UPDATE {spec.table} SET {", ".join(f"{c} = %s" for c in values)}, sealed_key = %s
                         WHERE tenant_id = %s AND {" AND ".join(f"{m} = %s" for m in spec.match)} AND sealed_key = %s""",
                    [*values.values(), key_id, tenant_id, *(r[m] for m in spec.match), r["sealed_key"]])
        done += cur.rowcount
    return done


def on_old_key(cur: psycopg.Cursor[Any], tenant_id: str) -> dict[str, int]:
    """How many rows of each step-6 kind are still sealed with a retired own key of the company."""
    old = retired_company_keys(cur, tenant_id)
    counts: dict[str, int] = {}
    for kind, spec in STEPS.items():
        cur.execute(f"SELECT count(*)::int AS n FROM {spec.table} WHERE tenant_id = %s AND sealed_key = ANY(%s) AND {spec.where}", (tenant_id, old))
        counts[kind] = int(one(cur)["n"])
    return counts
