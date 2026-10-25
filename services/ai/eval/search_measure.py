"""Measures the in-memory search on large synthetic companies (decision D41, step 3): memory, time to build, time per
question, and (with --db) today's SQL search on the same rows and how often the two agree.

    python -m eval.search_measure --sizes 1000,10000,50000            # memory only, no database
    python -m eval.search_measure --sizes 1000,10000 --db             # also the SQL search (test database)

Synthetic data only: texts are random sentences made of the words of the fictional evaluation documents; vectors are
random (seeded). Random vectors say nothing about the quality of meaning search: they are there for size and time.
Times are from the machine that runs it (stated in the output) and change from one machine to another.
"""

from __future__ import annotations

import argparse
import gc
import io
import json
import os
import platform
import random
import statistics
import time
import tracemalloc
import uuid
from pathlib import Path
from typing import Any

import numpy as np
import psycopg
from psycopg.rows import dict_row

from app.capture import CompanyIndex, ingest, load_index, retrieve, retrieve_in_memory
from app.capture.memory_search import Entry
from app.platform import Database
from eval.run import GOLDEN, setup_company

DIMENSIONS = 384
QUESTIONS = 50
TOP = 5


def vocabulary() -> list[str]:
    text = " ".join(p.read_text(encoding="utf-8") for p in sorted((GOLDEN / "docs").glob("*")))
    return sorted({w.strip(".,;:()\"'").lower() for w in text.split() if w.strip(".,;:()\"'").isalpha()})


def synthetic(n: int, seed: int) -> tuple[list[str], np.ndarray]:
    rnd = random.Random(seed)
    vocab = vocabulary()
    texts = []
    for _ in range(n):
        text = " ".join(rnd.choice(vocab) for _ in range(rnd.randint(40, 300)))
        texts.append(text[:2000])
    vectors = np.random.default_rng(seed).standard_normal((n, DIMENSIONS)).astype(np.float16)   # stored as halfvec
    return texts, vectors


def questions(seed: int) -> list[tuple[str, list[float]]]:
    rnd = random.Random(seed + 1)
    vocab = vocabulary()
    rng = np.random.default_rng(seed + 1)
    return [(" ".join(rnd.choice(vocab) for _ in range(rnd.randint(2, 5))), rng.standard_normal(DIMENSIONS).astype(np.float32).tolist())
            for _ in range(QUESTIONS)]


def pct(values: list[float], q: float) -> float:
    s = sorted(values)
    return round(s[min(len(s) - 1, int(q * len(s)))], 2)


class FixedEmbedder:
    relevance_threshold = 0.0
    model_id = "measure-random-384"

    def __init__(self) -> None:
        self.vector: list[float] = []

    def embed(self, texts: list[str], kind: Any) -> list[list[float]]:
        return [self.vector for _ in texts]


def in_memory(n: int, seed: int) -> dict[str, Any]:
    texts, vectors = synthetic(n, seed)
    entries = [Entry(str(uuid.UUID(int=i + 1)), "source", t, v, None, None, "unverified")
               for i, (t, v) in enumerate(zip(texts, vectors, strict=True))]
    gc.collect()
    t0 = time.perf_counter()
    index = CompanyIndex(entries)
    build_ms = (time.perf_counter() - t0) * 1000
    del index
    gc.collect()
    tracemalloc.start()            # a second build, for memory only: tracing slows building down several times
    before = tracemalloc.get_traced_memory()[0]
    index = CompanyIndex(entries)
    current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    ids = [e.id for e in entries]
    times = []
    for q, v in questions(seed):
        t0 = time.perf_counter()
        index.search(q, v, ids, 12)
        times.append((time.perf_counter() - t0) * 1000)
    return {"chunks": n, "build_ms": round(build_ms), "index_mb": round((current - before) / 2**20, 1), "build_peak_mb": round((peak - before) / 2**20, 1),
            "arrays_mb": round(index.nbytes() / 2**20, 1), "estimate_mb": round(index.size_estimate() / 2**20, 1), "question_ms_p50": pct(times, 0.5), "question_ms_p95": pct(times, 0.95)}


def with_database(n: int, seed: int) -> dict[str, Any]:
    admin = psycopg.connect(os.environ["DATABASE_URL_SUPERUSER"], autocommit=True, row_factory=dict_row)
    db = Database(os.environ["DATABASE_URL_AI"], pool_max=2)
    texts, vectors = synthetic(n, seed)
    company = setup_company(admin, f"Measure {n} (FICTIONAL)", ["owner"])
    tenant = company.tenant
    source = str(ingest.create_source(db, company.ctx("owner", "source.create", max_sensitivity=3), title="Synthetic", department_id=None,
                                      sensitivity=0, contributor_person_id=None, company_document=True, storage_budget_bytes=10**12)["id"])
    with admin.transaction():
        buf = io.StringIO()
        for i, (t, v) in enumerate(zip(texts, vectors, strict=True)):
            vec = "[" + ",".join(f"{x:.4g}" for x in v.tolist()) + "]"
            buf.write("\t".join([tenant, "source", source, str(i), t, str(len(t) // 4), vec, FixedEmbedder.model_id, "0", "active"]) + "\n")
        with admin.cursor().copy("""COPY chunks (tenant_id, kind, source_id, ordinal, text, token_estimate, embedding, embedding_model,
                                                  sensitivity, status) FROM STDIN""") as copy:
            copy.write(buf.getvalue())
    admin.execute("ANALYZE chunks")
    spec = {"v": 1, "tenant_id": tenant, "action": "knowledge:read", "nothing": False, "only_verified": False,
            "any_of": [{"scope": "tenant", "max_sensitivity": 1}]}
    emb = FixedEmbedder()
    with db.tenant_tx(tenant) as cur:
        t0 = time.perf_counter()
        index = load_index(cur, tenant_id=tenant, model_id=emb.model_id)
        load_ms = (time.perf_counter() - t0) * 1000
    sql_ms, mem_ms, same, first = [], [], [], 0
    for q, v in questions(seed):
        emb.vector = v
        with db.tenant_tx(tenant) as cur:
            t0 = time.perf_counter()
            a = retrieve(cur, tenant_id=tenant, spec=spec, question=q, embedder=emb)
            t1 = time.perf_counter()
            b = retrieve_in_memory(cur, index, tenant_id=tenant, spec=spec, question=q, embedder=emb)
            t2 = time.perf_counter()
        sql_ms.append((t1 - t0) * 1000)
        mem_ms.append((t2 - t1) * 1000)
        same.append(len({c.id for c in a[:TOP]} & {c.id for c in b[:TOP]}))
        first += bool(a and b and a[0].id == b[0].id)
    admin.execute("DELETE FROM chunks WHERE tenant_id = %s", (tenant,))
    db.close()
    admin.close()
    return {"chunks": n, "load_from_database_ms": round(load_ms), "sql_question_ms_p50": pct(sql_ms, 0.5), "sql_question_ms_p95": pct(sql_ms, 0.95),
            "memory_question_ms_p50": pct(mem_ms, 0.5), "memory_question_ms_p95": pct(mem_ms, 0.95),
            "same_in_top5_mean": round(statistics.mean(same), 2), "same_first": first, "questions": QUESTIONS}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sizes", default="1000,10000,50000")
    ap.add_argument("--db", action="store_true")
    ap.add_argument("--seed", type=int, default=20261024)
    ap.add_argument("--out", default="eval/out/search-measure.json")
    args = ap.parse_args()
    machine = f"{platform.machine()}, {os.cpu_count()} CPUs, Python {platform.python_version()}"
    result: dict[str, Any] = {"machine": machine, "memory": [], "database": []}
    for n in (int(s) for s in args.sizes.split(",")):
        m = in_memory(n, args.seed)
        result["memory"].append(m)
        print(f"sizes: {n} chunks in memory: index {m['index_mb']} MB (estimated by the service: {m['estimate_mb']} MB; peak while building {m['build_peak_mb']} MB), built in {m['build_ms']} ms; "
              f"per question p50 {m['question_ms_p50']} ms, p95 {m['question_ms_p95']} ms ({machine})")
        if args.db:
            d = with_database(n, args.seed)
            result["database"].append(d)
            print(f"sizes: {n} chunks with the database: loading the company {d['load_from_database_ms']} ms; per question SQL p50 "
                  f"{d['sql_question_ms_p50']} ms / p95 {d['sql_question_ms_p95']} ms, memory p50 {d['memory_question_ms_p50']} ms / p95 "
                  f"{d['memory_question_ms_p95']} ms; same chunks in the top 5: {d['same_in_top5_mean']} of 5, same first {d['same_first']} of {d['questions']}")
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(result, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
