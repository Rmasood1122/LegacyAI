"""Compares the in-memory search with today's SQL search (decision D41, step 3). Synthetic data only: the fictional
Northfield company of the evaluation (eval/golden), every question of questions.yaml, asked as its reviewer.

    python -m eval.search_compare --embedder fake  --out eval/out/search-compare-fake.json    # in CI ($0)
    python -m eval.search_compare --embedder local --out eval/out/search-compare-local.json   # the real local model ($0)

Needs the test database (DATABASE_URL_AI, DATABASE_URL_SUPERUSER). No AI provider is called.

What it reports, per question and in total:
- the top 5 of each search, and how many of them are the same chunks;
- for questions with known source documents: whether each search has one of them in its top 5;
- how often both searches put the same chunk first;
- the time each search took (the question's embedding counted once, outside both);
- how far our word splitting and stemming agree with PostgreSQL's on every word of the documents.

These numbers come from 13 short invented documents and 90 questions written by the same author as the system. They
show whether the two searches behave alike on this set; they do not predict quality on real documents.
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import time
from pathlib import Path
from typing import Any

import psycopg
import yaml
from psycopg.rows import dict_row

from app.ai_gateway import FakeEmbedder, make_embedder
from app.capture import load_index, retrieve, retrieve_in_memory
from app.capture.memory_search import words
from app.platform import Database
from eval.run import GOLDEN, chunk_rows, load_docs, setup_company

TOP = 5
GROUPS = ("answerable", "unanswerable", "conflicting", "restricted", "injection_questions")


class FixedEmbedder:
    relevance_threshold = 0.0
    """Hands back a vector computed once, so both searches use the same question vector and neither pays for it."""

    def __init__(self, model_id: str, vector: list[float]) -> None:
        self.model_id = model_id
        self.vector = vector

    def embed(self, texts: list[str], kind: Any) -> list[list[float]]:
        return [self.vector for _ in texts]


def stem_agreement(admin: psycopg.Connection[dict[str, Any]], texts: list[str]) -> dict[str, Any]:
    """Every distinct letters-only word of the documents: our stem against PostgreSQL's (to_tsvector('english'))."""
    vocabulary = sorted({w for t in texts for w in t.lower().split() if w.isalpha()})
    rows = admin.execute("SELECT w, ARRAY(SELECT lexeme FROM unnest(to_tsvector('english', w))) AS lex FROM unnest(%s::text[]) AS w",
                         (vocabulary,)).fetchall()
    differ = [r["w"] for r in rows if list(r["lex"]) != words(r["w"])]
    return {"words": len(rows), "same": len(rows) - len(differ), "differ": differ}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--embedder", choices=["fake", "local"], default="fake")
    ap.add_argument("--out", default="eval/out/search-compare.json")
    args = ap.parse_args()

    db = Database(os.environ["DATABASE_URL_AI"], pool_max=2)
    admin = psycopg.connect(os.environ["DATABASE_URL_SUPERUSER"], autocommit=True, row_factory=dict_row)
    embedder = make_embedder("local") if args.embedder == "local" else FakeEmbedder()
    manifest = yaml.safe_load((GOLDEN / "manifest.yaml").read_text(encoding="utf-8"))
    questions = yaml.safe_load((GOLDEN / "questions.yaml").read_text(encoding="utf-8"))

    north = setup_company(admin, "Northfield Bottling Plant (FICTIONAL)", ["owner", "reviewer", "shift_lead"])
    admin.execute("""INSERT INTO consents (tenant_id, person_id, scope, purpose, policy_version, granted_by_card_id)
                     VALUES (%s, %s, 'documents', 'Synthetic evaluation', 'eval-1', %s)""",
                  (north.tenant, north.people["shift_lead"].id, north.people["shift_lead"].card))
    sources = load_docs(db, admin, north, manifest["documents"], embedder)
    doc_of_source = {v: k for k, v in sources.items()}
    chunks = chunk_rows(admin, north.tenant)

    with db.tenant_tx(north.tenant) as cur:
        started = time.perf_counter()
        index = load_index(cur, tenant_id=north.tenant, model_id=embedder.model_id)
        build_ms = (time.perf_counter() - started) * 1000

    rows: list[dict[str, Any]] = []
    for group in GROUPS:
        for q in questions[group]:
            spec = north.ctx("reviewer", "knowledge.candidates", max_sensitivity=1).filter
            fixed = FixedEmbedder(embedder.model_id, embedder.embed([q["q"]], "query")[0])
            with db.tenant_tx(north.tenant) as cur:
                t0 = time.perf_counter()
                sql = retrieve(cur, tenant_id=north.tenant, spec=spec, question=q["q"], embedder=fixed)
                t1 = time.perf_counter()
                mem = retrieve_in_memory(cur, index, tenant_id=north.tenant, spec=spec, question=q["q"], embedder=fixed)
                t2 = time.perf_counter()
            sql_top, mem_top = [c.id for c in sql[:TOP]], [c.id for c in mem[:TOP]]
            row: dict[str, Any] = {
                "id": q["id"], "group": group, "question": q["q"], "sql_top5": sql_top, "memory_top5": mem_top,
                "same_in_top5": len(set(sql_top) & set(mem_top)), "same_first": bool(sql_top and mem_top and sql_top[0] == mem_top[0]),
                "sql_ms": round((t1 - t0) * 1000, 2), "memory_ms": round((t2 - t1) * 1000, 2),
                "sql_docs": [doc_of_source.get(chunks[c]["source_id"]) for c in sql_top],
                "memory_docs": [doc_of_source.get(chunks[c]["source_id"]) for c in mem_top],
            }
            if q.get("docs"):
                row["expected_docs"] = q["docs"]
                row["sql_found_doc"] = any(d in q["docs"] for d in row["sql_docs"])
                row["memory_found_doc"] = any(d in q["docs"] for d in row["memory_docs"])
            rows.append(row)

    with_docs = [r for r in rows if "expected_docs" in r]
    summary = {
        "embedder": embedder.model_id, "questions": len(rows), "chunks": len(index), "index_build_ms": round(build_ms, 1),
        "same_in_top5_mean": round(statistics.mean(r["same_in_top5"] for r in rows), 2),
        "same_top5_all_five": sum(1 for r in rows if r["same_in_top5"] == TOP or (r["same_in_top5"] == len(r["sql_top5"]) == len(r["memory_top5"]))),
        "same_first": sum(1 for r in rows if r["same_first"]),
        "questions_with_known_docs": len(with_docs),
        "sql_found_doc_in_top5": sum(1 for r in with_docs if r["sql_found_doc"]),
        "memory_found_doc_in_top5": sum(1 for r in with_docs if r["memory_found_doc"]),
        "only_sql_found": [r["id"] for r in with_docs if r["sql_found_doc"] and not r["memory_found_doc"]],
        "only_memory_found": [r["id"] for r in with_docs if r["memory_found_doc"] and not r["sql_found_doc"]],
        "sql_ms_p50": round(statistics.median(r["sql_ms"] for r in rows), 2),
        "memory_ms_p50": round(statistics.median(r["memory_ms"] for r in rows), 2),
        "stems": stem_agreement(admin, [c["text"] for c in chunks.values()]),
    }
    db.close()
    admin.close()
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps({"summary": summary, "questions": rows}, indent=2), encoding="utf-8")
    s = summary
    print(f"search-compare: {s['embedder']}, {s['questions']} questions, {s['chunks']} chunks; same chunks in the top 5: "
          f"{s['same_in_top5_mean']} of 5 on average, all the same in {s['same_top5_all_five']}; same first chunk in {s['same_first']}")
    print(f"search-compare: a known source document in the top 5 ({s['questions_with_known_docs']} questions): SQL {s['sql_found_doc_in_top5']}, "
          f"memory {s['memory_found_doc_in_top5']}; only SQL: {s['only_sql_found'] or 'none'}; only memory: {s['only_memory_found'] or 'none'}")
    print(f"search-compare: median time per question: SQL {s['sql_ms_p50']} ms, memory {s['memory_ms_p50']} ms (index built in {s['index_build_ms']} ms); "
          f"stems equal to PostgreSQL's for {s['stems']['same']} of {s['stems']['words']} words")


if __name__ == "__main__":
    main()
