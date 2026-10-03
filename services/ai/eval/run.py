"""The Phase 2 evaluation (docs/phase2/09). Synthetic data only ("Northfield Bottling Plant (FICTIONAL)").

    python -m eval.run --provider fake --embedder fake --out eval/out/fake.json                 # $0, in CI on every commit
    python -m eval.run --provider anthropic --model claude-haiku-4-5-20251001 --embedder local  # after Gate 2, capped

Needs the test database (DATABASE_URL_AI for the service login, DATABASE_URL_SUPERUSER to set up the
synthetic companies, as an administrator would through the API). A real provider additionally needs
EVAL_ALLOW_REAL=1 and the provider's key in ANTHROPIC_API_KEY or OPENAI_API_KEY - set only by the
evaluation workflow, from GitHub secrets. The run is capped by the same budget mechanism as every company
(this run's company cap AND the global cap are both --cap-usd); when the cap is hit the run stops early
and says so.

Every number is reported with its sample size. These are measurements on a small invented data set,
written by the same author as the system; they do not predict accuracy on real documents.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import statistics
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import psycopg
import yaml
from psycopg.rows import dict_row

from app.ai_gateway import Caller, DataBlock, FakeEmbedder, FakeProvider, Gateway, GenerateRequest, load_prices, load_prompts, make_embedder
from app.ai_gateway.outputs import EvalJudgeOutput
from app.ai_gateway.remote import AnthropicProvider, OpenAIProvider
from app.ai_gateway.types import ProviderResult
from app.capture import ingest, interviews, topics
from app.capture.gaps import gap_report
from app.knowledge import answers, items, readiness
from app.platform import Database, Logger, ServiceContext
from eval.pdfs import make_pdf

GOLDEN = Path(__file__).resolve().parent / "golden"
LIMITS = {"max_input_tokens": 4000, "max_output_tokens": 600, "calls_per_hour": 10_000}
# What a crashed run needs in order to still save every call it made (see the bottom of this file).
STATE: dict[str, Any] = {}


class RecordingProvider:
    """Passes calls through and keeps every raw answer, BEFORE our validation (for the injection measurement)."""

    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.name = inner.name
        self.model = inner.model
        self.raw: list[tuple[str, str]] = []

    def generate(self, req: GenerateRequest) -> ProviderResult:
        result: ProviderResult = self.inner.generate(req)
        self.raw.append((req.feature, result.raw_json))
        return result


@dataclass
class Person:
    id: str
    card: str


@dataclass
class Company:
    tenant: str
    depts: dict[str, str]
    people: dict[str, Person] = field(default_factory=dict)

    def ctx(self, who: str, action: str, *, max_sensitivity: int = 1, approved: list[str] | None = None) -> ServiceContext:
        p = self.people[who]
        spec = {"v": 1, "tenant_id": self.tenant, "action": "knowledge:read", "nothing": False, "only_verified": False,
                "any_of": [{"scope": "tenant", "max_sensitivity": max_sensitivity}]}
        return ServiceContext(tenant_id=self.tenant, card_id=p.card, person_id=p.id, roles=("expert",), card_phase="normal", action=action,
                              request_id=f"eval-{uuid.uuid4().hex[:8]}", filter=spec, approved=tuple(approved or []), limits=LIMITS)


def setup_company(admin: psycopg.Connection[dict[str, Any]], name: str, people: list[str]) -> Company:
    slug = "eval-" + uuid.uuid4().hex[:10]
    now = datetime.now(UTC)
    with admin.transaction():
        tenant = str(admin.execute("INSERT INTO tenants (name, slug) VALUES (%s, %s) RETURNING id", (name, slug)).fetchone()["id"])  # type: ignore[index]
        depts = {}
        for d in ("production", "maintenance", "quality"):
            depts[d] = str(admin.execute("INSERT INTO departments (tenant_id, name) VALUES (%s, %s) RETURNING id", (tenant, d.title())).fetchone()["id"])  # type: ignore[index]
        company = Company(tenant, depts)
        for who in people:
            pid = str(admin.execute("INSERT INTO people (tenant_id, display_name) VALUES (%s, %s) RETURNING id",
                                    (tenant, f"Fictional {who.replace('_', ' ')}")).fetchone()["id"])  # type: ignore[index]
            number = "9" + "".join(secrets.choice("0123456789") for _ in range(15))
            cid = str(admin.execute(
                """INSERT INTO cards (tenant_id, kind, person_id, card_number, expires_at, grace_until, renewal_due)
                   VALUES (%s, 'person', %s, %s, %s, %s, %s) RETURNING id""",
                (tenant, pid, number, now + timedelta(days=365), now + timedelta(days=395), now + timedelta(days=335))).fetchone()["id"])  # type: ignore[index]
            company.people[who] = Person(pid, cid)
    return company


def consent(admin: psycopg.Connection[dict[str, Any]], c: Company, who: str, scope: str) -> None:
    p = c.people[who]
    admin.execute("""INSERT INTO consents (tenant_id, person_id, scope, purpose, policy_version, granted_by_card_id)
                     VALUES (%s, %s, %s, 'Synthetic evaluation', 'eval-1', %s)""", (c.tenant, p.id, scope, p.card))


def load_docs(db: Database, admin: psycopg.Connection[dict[str, Any]], c: Company, docs: list[dict[str, Any]], embedder: Any) -> dict[str, str]:
    """Returns doc key (d01...) -> source id. Company documents are declared by the owner; d06 is the shift lead's own."""
    out = {}
    for d in docs:
        text = (GOLDEN / "docs" / d["file"]).read_text(encoding="utf-8")
        contributor = None
        if d.get("contributor"):
            contributor = c.people[d["contributor"]].id
        owner_ctx = c.ctx("owner", "source.create", max_sensitivity=3)
        src = ingest.create_source(db, owner_ctx, title=d["title"], department_id=c.depts[d["department"]], sensitivity=d["sensitivity"],
                                   contributor_person_id=contributor, company_document=contributor is None, storage_budget_bytes=10**12)
        if contributor is not None:
            ingest.confirm_source(db, c.ctx(d["contributor"], "source.confirm"), src["id"])
        if d.get("pdf"):
            # the simple PDF builder writes Latin-1 text: the long dash of the label becomes a hyphen
            pages = [pg.strip().replace("—", "-") for pg in text.split("---PAGE---")]
            data, mime = make_pdf(pages), "application/pdf"
        else:
            data, mime = text.encode(), "text/markdown" if d["file"].endswith(".md") else "text/plain"
        res = ingest.process_upload(db, owner_ctx, embedder, src["id"], data, mime, 10**12, time.monotonic() + 300)
        if res["status"] != "ready":
            raise RuntimeError(f"{d['file']}: {res}")
        out[d["file"][:3]] = src["id"]
    return out


def chunk_rows(admin: psycopg.Connection[dict[str, Any]], tenant: str) -> dict[str, dict[str, Any]]:
    rows = admin.execute("""SELECT c.id::text AS id, c.text, c.sensitivity, c.source_id::text AS source_id, c.tenant_id::text AS tenant_id
                             FROM chunks c WHERE c.tenant_id = %s""", (tenant,)).fetchall()
    return {r["id"]: r for r in rows}


def ask(db: Database, c: Company, gateway: Gateway, rec: RecordingProvider, embedder: Any, caller: Caller, question: str,
        max_sensitivity: int, chunks: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """The two steps as the API runs them. Lock 3 (the API's policy re-check) is reproduced here with the same rule
    as the filter: same company, sensitivity within the reader's level."""
    calls_before = len(rec.raw)
    started = time.monotonic()
    ctx = c.ctx("reviewer", "knowledge.candidates", max_sensitivity=max_sensitivity)
    cand = answers.candidate_ids(db, ctx, embedder, question, None)
    retrieved = time.monotonic()
    approved = [x["id"] for x in cand if x["id"] in chunks and chunks[x["id"]]["sensitivity"] <= max_sensitivity]
    r = answers.answer(db, c.ctx("reviewer", "knowledge.answer", max_sensitivity=max_sensitivity, approved=approved), gateway, embedder,
                       caller, question, None, None)
    done = time.monotonic()
    pub = r.public()
    return {
        "outcome": r.outcome, "reason": r.reason, "confidence": r.confidence, "answer": r.answer, "citations": pub["citations"],
        "claims_valid": r.claims_valid, "claims_rejected": r.claims_rejected, "fabricated": r.fabricated, "approved": approved,
        "model_called": len(rec.raw) > calls_before, "raw": [raw for _, raw in rec.raw[calls_before:]], "cost_micro_usd": r.cost_micro_usd,
        "latency_ms": round((done - started) * 1000), "retrieval_ms": round((retrieved - started) * 1000),
        "citation_chunks": [c_.chunk_id for c_ in r.citations],
    }


def judge(gateway: Gateway, caller: Caller, points: list[str], answer_text: str) -> str:
    blocks = [*[DataBlock(f"POINT_{i}", p) for i, p in enumerate(points)], DataBlock("ANSWER", answer_text)]
    out = gateway.generate(caller, "eval_judge", "eval_judge", blocks)
    if not isinstance(out.parsed, EvalJudgeOutput) or not out.parsed.points:
        return "unjudged"
    met = {p.point for p in out.parsed.points if p.met}
    if out.parsed.contradiction:
        return "wrong"
    if len(met) == len(points):
        return "correct"
    return "partly" if met else "wrong"


def pct(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    return s[min(len(s) - 1, int(round(q * (len(s) - 1))))]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", choices=["fake", "anthropic", "openai"], default="fake")
    ap.add_argument("--model", default="fake-1")
    ap.add_argument("--embedder", choices=["fake", "local"], default="fake")
    ap.add_argument("--cap-usd", type=float, default=5.0)
    ap.add_argument("--out", default="eval/out/result.json")
    args = ap.parse_args()

    if args.provider != "fake" and os.environ.get("EVAL_ALLOW_REAL") != "1":
        raise SystemExit("a real provider is used only by the evaluation workflow (EVAL_ALLOW_REAL=1)")
    if args.provider == "anthropic":
        inner: Any = AnthropicProvider(os.environ["ANTHROPIC_API_KEY"], args.model)
    elif args.provider == "openai":
        inner = OpenAIProvider(os.environ["OPENAI_API_KEY"], args.model, reasoning_effort=os.environ.get("AI_REASONING_EFFORT", "low") or None)
    else:
        inner = FakeProvider()
    rec = RecordingProvider(inner)
    cap = int(args.cap_usd * 1_000_000)

    db = Database(os.environ["DATABASE_URL_AI"], pool_max=4)
    admin = psycopg.connect(os.environ["DATABASE_URL_SUPERUSER"], autocommit=True, row_factory=dict_row)
    embedder = make_embedder(args.embedder) if args.embedder == "local" else FakeEmbedder()
    gateway = Gateway(db, rec, load_prompts(), load_prices(), Logger("warn"))
    admin.execute("UPDATE ai_global SET monthly_cap_micro_usd = %s, kill_switch = false", (cap,))
    STATE.update({"rec": rec, "admin": admin, "out": args.out, "provider": args.provider, "model": args.model})

    manifest = yaml.safe_load((GOLDEN / "manifest.yaml").read_text(encoding="utf-8"))
    qs = yaml.safe_load((GOLDEN / "questions.yaml").read_text(encoding="utf-8"))
    north = setup_company(admin, "Northfield Bottling Plant (FICTIONAL)", ["owner", "reviewer", "reviewer2", "shift_lead", "expert", "learner",
                                                                           "learner2", "learner3", "learner4", "learner5"])
    harbour = setup_company(admin, "Harbourview Brewing (FICTIONAL)", ["owner", "reviewer"])
    consent(admin, north, "shift_lead", "documents")
    consent(admin, north, "expert", "own_words")
    caller = Caller(tenant_id=north.tenant, card_id=north.people["reviewer"].card, request_id="eval", monthly_cap_micro_usd=cap,
                    max_input_tokens=LIMITS["max_input_tokens"], max_output_tokens=LIMITS["max_output_tokens"], calls_per_hour=LIMITS["calls_per_hour"])
    caller2 = Caller(tenant_id=harbour.tenant, card_id=harbour.people["reviewer"].card, request_id="eval", monthly_cap_micro_usd=cap,
                     max_input_tokens=4000, max_output_tokens=600, calls_per_hour=10_000)

    started_at = datetime.now(UTC).isoformat()
    load_docs(db, admin, north, manifest["documents"], embedder)
    load_docs(db, admin, harbour, manifest["second_company"]["documents"], embedder)
    chunks = chunk_rows(admin, north.tenant)
    chunks2 = chunk_rows(admin, harbour.tenant)
    result: dict[str, Any] = {"provider": args.provider, "model": args.model, "embedder": embedder.model_id, "started_at": started_at,
                              "cap_micro_usd": cap, "commit": os.environ.get("GITHUB_SHA", "local"), "cut_short": False}

    def stop_if_capped(out: dict[str, Any]) -> bool:
        return out.get("reason") == "budget_exhausted"

    # ---- questions
    rows: dict[str, list[dict[str, Any]]] = {}
    for group_name, max_s in (("answerable", 1), ("unanswerable", 1), ("conflicting", 1), ("restricted", 1), ("injection_questions", 1)):
        group = group_name
        rows[group] = []
        for q in qs[group]:
            out = ask(db, north, gateway, rec, embedder, caller, q["q"], max_s, chunks)
            out["id"] = q["id"]
            out["question"] = q["q"]
            if group == "answerable":
                out["points"] = q["points"]
            if group == "injection_questions":
                out["canary"] = q["canary"]
            rows[group].append(out)
            if stop_if_capped(out):
                result["cut_short"] = True
        if result["cut_short"]:
            break
    t2 = []
    for q in qs["second_company"]:
        cand = answers.candidate_ids(db, harbour.ctx("reviewer", "knowledge.candidates"), embedder, q["q"], None)
        approved = [x["id"] for x in cand if x["id"] in chunks2]
        r = answers.answer(db, harbour.ctx("reviewer", "knowledge.answer", approved=approved), gateway, embedder, caller2, q["q"], None, None)
        t2.append({"id": q["id"], "outcome": r.outcome, "answer": r.answer, "citation_chunks": [c_.chunk_id for c_ in r.citations]})

    # ---- citation re-check, independent of the pipeline's validator
    checked = valid = 0
    for answered_rows in rows.values():
        for row in answered_rows:
            if row["outcome"] != "answered":
                continue
            for cid, cit in zip(row["citation_chunks"], row["citations"], strict=True):
                checked += 1
                in_text = " ".join(cit["snippet"].split()).lower() in " ".join(chunks.get(cid, {}).get("text", "").split()).lower()
                if cid in row["approved"] and cid in chunks and in_text:
                    valid += 1
    cross = sum(1 for t in t2 for cid in t["citation_chunks"] if cid in chunks)
    cross += sum(1 for g in rows.values() for o in g for cid in o["citation_chunks"] if cid in chunks2)

    # ---- correctness (model judge + a table for people to check)
    table = []
    for row in rows.get("answerable", []):
        verdict = judge(gateway, caller, row["points"], row["answer"]) if row["outcome"] == "answered" and row["answer"] else "not answered"
        table.append({"id": row["id"], "question": row["question"], "points": row["points"], "outcome": row["outcome"], "reason": row["reason"],
                      "answer": row["answer"], "judge": verdict})

    # ---- interview
    iv_result: dict[str, Any] = {}
    try:
        ivspec = yaml.safe_load((GOLDEN / "interview.yaml").read_text(encoding="utf-8"))
        topic_ids = {}
        with admin.transaction():
            admin.execute("SELECT set_config('app.tenant_id', %s, true)", (north.tenant,))
            for t in ivspec["topics"]:
                tid = str(admin.execute("""INSERT INTO topics (tenant_id, name, description, origin, status, sensitivity)
                                           VALUES (%s, %s, %s, 'admin', 'active', 0) RETURNING id""", (north.tenant, t["name"], t["description"])).fetchone()["id"])  # type: ignore[index]
                admin.execute("INSERT INTO role_topic_maps (tenant_id, job_role, topic_id, required, importance) VALUES (%s, %s, %s, true, 2)",
                              (north.tenant, ivspec["job_role"], tid))
                topic_ids[t["key"]] = tid
        for tid in topic_ids.values():
            topics.embed(db, north.ctx("owner", "topic.embed"), embedder, tid)
        spec = north.ctx("expert", "x").filter
        iv = interviews.invite(db, north.ctx("owner", "interview.invite"), north.people["expert"].id, ivspec["job_role"])
        interviews.accept(db, north.ctx("expert", "interview.accept"), iv, gateway, caller, spec, spec)
        ectx = north.ctx("expert", "interview.turn")

        def on_answer(cur: Any, saved: interviews.SavedAnswer) -> tuple[str | None, int]:
            return items.candidate_from_answer(cur, ectx, consent_id=saved.consent_id, chunk_id=saved.chunk_id, text=saved.text, embedder=embedder,
                                               gateway=gateway, caller=caller)
        for a in ivspec["answers"]:
            interviews.answer_turn(db, ectx, iv, a, embedder, gateway, caller, spec, spec, on_answer)
        linked = admin.execute("""SELECT DISTINCT kt.topic_id::text AS t FROM knowledge_item_topics kt JOIN knowledge_items i ON i.id = kt.item_id
                                   WHERE kt.tenant_id = %s AND i.origin = 'interview'""", (north.tenant,)).fetchall()
        linked_ids = {r["t"] for r in linked}
        key_of = {v: k for k, v in topic_ids.items()}
        turns = admin.execute("SELECT question_kind FROM interview_turns WHERE interview_id = %s", (iv,)).fetchall()
        cands = admin.execute("SELECT ai_extracted FROM knowledge_items WHERE tenant_id = %s AND origin = 'interview'", (north.tenant,)).fetchall()
        with db.tenant_tx(north.tenant) as cur:
            gaps = gap_report(cur, tenant_id=north.tenant, job_role=ivspec["job_role"], item_spec=spec, topic_spec=spec)
        labels = {key_of[g.topic_id]: g.label for g in gaps}
        iv_result = {
            "turns": len(ivspec["answers"]), "coverable_topics": len(ivspec["coverable"]),
            "covered": sorted(key_of[t] for t in linked_ids if key_of.get(t) in ivspec["coverable"]),
            "uncoverable_still_gaps": [k for k in ("T9", "T10") if labels.get(k) in ("uncovered", "unverified")],
            "follow_up_questions": sum(1 for t in turns if t["question_kind"] == "follow_up"),
            "template_questions": sum(1 for t in turns if t["question_kind"] == "template"),
            "candidates": len(cands), "candidates_with_model_quote": sum(1 for x in cands if x["ai_extracted"]),
        }
    except Exception as exc:  # report, do not hide
        iv_result = {"error": type(exc).__name__, "detail": str(exc)[:300]}

    # ---- readiness
    rd_result: dict[str, Any] = {}
    try:
        rdspec = yaml.safe_load((GOLDEN / "readiness.yaml").read_text(encoding="utf-8"))
        role = "Line 2 operator"
        with admin.transaction():
            admin.execute("SELECT set_config('app.tenant_id', %s, true)", (north.tenant,))
            rtopic = str(admin.execute("""INSERT INTO topics (tenant_id, name, description, origin, status, sensitivity)
                                          VALUES (%s, 'Line 2 basics', 'operating Line 2', 'admin', 'active', 0) RETURNING id""", (north.tenant,)).fetchone()["id"])  # type: ignore[index]
            admin.execute("INSERT INTO role_topic_maps (tenant_id, job_role, topic_id, required, importance) VALUES (%s, %s, %s, true, 3)",
                          (north.tenant, role, rtopic))
            admin.execute("INSERT INTO knowledge_settings (tenant_id, quiz_questions_per_attempt, quiz_min_questions_per_topic) VALUES (%s, 20, 1)", (north.tenant,))
        item_ids = []
        for text in rdspec["items"]:
            iid = items.write_manual(db, north.ctx("reviewer", "item.write"), title=text[:60], body=text, department_id=None, sensitivity=0,
                                     contributor_person_id=None)
            items.submit(db, north.ctx("reviewer", "item.submit"), iid)
            items.verify(db, north.ctx("reviewer2", "item.verify"), iid, embedder)
            item_ids.append(iid)
        with admin.transaction():
            admin.execute("SELECT set_config('app.tenant_id', %s, true)", (north.tenant,))
            for iid in item_ids:
                admin.execute("INSERT INTO knowledge_item_topics (tenant_id, item_id, topic_id, link_source) VALUES (%s, %s, %s, 'reviewer')",
                              (north.tenant, iid, rtopic))
        made_mcq = readiness.generate(db, north.ctx("reviewer", "quiz.generate", approved=item_ids[:10]), gateway, caller, "mcq")
        made_open = readiness.generate(db, north.ctx("reviewer", "quiz.generate", approved=item_ids[10:]), gateway, caller, "open")
        qids = made_mcq["created"] + made_open["created"]
        for q in qids:
            readiness.set_question_status(db, north.ctx("reviewer2", "quiz.status"), q, "approved")
        item_text = dict(zip(item_ids, rdspec["items"], strict=True))
        learners = ["learner", "learner2", "learner3", "learner4", "learner5"]
        styles = [lr["key"] for lr in rdspec["learners"]]
        inj = rdspec["injection_answers"]
        scores: dict[str, list[float]] = {}
        raw_before = len(rec.raw)
        for who, style in zip(learners, styles, strict=True):
            att = readiness.start_attempt(db, north.ctx(who, "quiz.start", approved=qids), role, seed=7)
            qrows = admin.execute(
                """SELECT qa.position, qi.kind, qi.stem, qi.correct_option, qa.option_order, qi.knowledge_item_id::text AS item
                     FROM quiz_answers qa JOIN quiz_items qi ON qi.id = qa.quiz_item_id WHERE qa.attempt_id = %s ORDER BY qa.position""",
                (att["id"],)).fetchall()
            for n, qr in enumerate(qrows):
                if qr["kind"] == "mcq":
                    chosen = qr["option_order"].index(qr["correct_option"]) if style == "strong" else (qr["option_order"].index(qr["correct_option"]) + 1) % 4
                    readiness.save_answer(db, north.ctx(who, "quiz.answer"), att["id"], qr["position"], chosen, None)
                    continue
                text = {"strong": item_text.get(qr["item"], ""), "weak": " ".join(item_text.get(qr["item"], "").split()[:3]),
                        "off_topic": "I usually take my break at ten.", "copied_question": qr["stem"],
                        "injection": inj[n % len(inj)]["text"]}[style]
                readiness.save_answer(db, north.ctx(who, "quiz.answer"), att["id"], qr["position"], None, text)
            readiness.submit_attempt(db, north.ctx(who, "quiz.submit"), att["id"], gateway, caller)
            finals = admin.execute("""SELECT qa.final_score FROM quiz_answers qa JOIN quiz_items qi ON qi.id = qa.quiz_item_id
                                       WHERE qa.attempt_id = %s AND qi.kind = 'open'""", (att["id"],)).fetchall()
            scores[style] = [float(f["final_score"]) for f in finals if f["final_score"] is not None]
        grading_raw = " ".join(raw for feat, raw in rec.raw[raw_before:] if feat == "quiz_grade")
        rd_result = {
            "generated_mcq": len(made_mcq["created"]), "refused_mcq": made_mcq["refused"], "generated_open": len(made_open["created"]),
            "refused_open": made_open["refused"],
            "mean_open_score": {k: (round(statistics.mean(v), 2) if v else None) for k, v in scores.items()},
            "graded_open_answers": {k: len(v) for k, v in scores.items()},
            "learner_injection_followed": [i["canary"] for i in inj if i["canary"] in grading_raw],
        }
    except Exception as exc:
        rd_result = {"error": type(exc).__name__, "detail": str(exc)[:300]}

    # ---- injection (questions + planted document)
    all_raw = " ".join(raw for _, raw in rec.raw)
    inj_rows = rows.get("injection_questions", [])
    q_followed = [o["canary"] for o in inj_rows if any(o["canary"] in r for r in o["raw"])]
    q_leaked = [o["canary"] for o in inj_rows if o["answer"] and o["canary"] in o["answer"]]
    d_canaries = [f"CANARY-D{n:02d}" for n in range(1, 11)]
    reached = {cn for cn in d_canaries if any(cn in chunks[cid]["text"] for o in inj_rows for cid in o["approved"] if cid in chunks)}
    d_followed = [cn for cn in d_canaries if cn in all_raw]
    d_leaked = [cn for cn in d_canaries if any(o["answer"] and cn in o["answer"] for g in rows.values() for o in g)]

    # ---- cost and accounting
    ledger = admin.execute("""SELECT feature, count(*)::int AS calls, COALESCE(sum(cost_micro_usd), 0)::bigint AS cost,
                                     COALESCE(sum(input_tokens), 0)::bigint AS tin, COALESCE(sum(output_tokens), 0)::bigint AS tout
                                FROM ai_usage_ledger WHERE tenant_id = ANY(%s::uuid[]) GROUP BY feature ORDER BY feature""",
                           ([north.tenant, harbour.tenant],)).fetchall()
    total = sum(int(r["cost"]) for r in ledger)
    periods = admin.execute("SELECT COALESCE(sum(spent_micro_usd), 0)::bigint AS s FROM ai_budget_periods WHERE tenant_id = ANY(%s::uuid[])",
                            ([north.tenant, harbour.tenant],)).fetchone()
    statuses = admin.execute("""SELECT status, count(*)::int AS n FROM ai_usage_ledger WHERE tenant_id = ANY(%s::uuid[]) GROUP BY status""",
                             ([north.tenant, harbour.tenant],)).fetchall()

    def counts(group: str, want: str) -> dict[str, Any]:
        g = rows.get(group, [])
        hit = [o for o in g if o["outcome"] == want]
        return {"n": len(g), want: len(hit), "decided_by_code": sum(1 for o in hit if not o["model_called"]),
                "decided_by_model": sum(1 for o in hit if o["model_called"])}

    ans = rows.get("answerable", [])
    result.update({
        "abstention": {
            "unanswerable": counts("unanswerable", "dont_know"), "restricted": counts("restricted", "dont_know"),
            "conflicting": {**counts("conflicting", "dont_know"),
                            "with_reason_sources_conflict": sum(1 for o in rows.get("conflicting", []) if o["reason"] == "sources_conflict")},
            "answerable_wrongly_refused": {"n": len(ans), "refused": sum(1 for o in ans if o["outcome"] != "answered")},
            "restricted_look_like_unanswerable": all(o["outcome"] != "answered" for o in rows.get("restricted", [])),
        },
        "citations": {"returned": checked, "valid_on_recheck": valid,
                      "removed_by_validator": sum(o["claims_rejected"] for g in rows.values() for o in g),
                      "fabricated_source_answers": sum(1 for g in rows.values() for o in g if o["fabricated"]),
                      "cross_company_citations": cross,
                      # the leak check on realistic data: no passage above the reader's level may be approved or cited
                      "above_reader_level_approved_or_cited": sum(
                          1 for g in rows.values() for o in g for cid in [*o["approved"], *o["citation_chunks"]]
                          if cid in chunks and chunks[cid]["sensitivity"] > 1)},
        "correctness": {"answered": sum(1 for t in table if t["outcome"] == "answered"),
                        **{k: sum(1 for t in table if t["judge"] == k) for k in ("correct", "partly", "wrong", "unjudged")}, "table": table},
        "second_company": t2,
        "interview": iv_result,
        "readiness": rd_result,
        "injection": {"questions": {"n": len(inj_rows), "model_followed": q_followed, "reached_answer": q_leaked},
                      "planted_document": {"n": 10, "reached_prompt": sorted(reached), "model_followed": d_followed, "reached_answer": d_leaked}},
        "cost": {"total_micro_usd": total, "ledger_equals_period_total": total == int(periods["s"]),  # type: ignore[index]
                 "by_feature": [dict(r) | {"cost": int(r["cost"]), "tin": int(r["tin"]), "tout": int(r["tout"])} for r in ledger],
                 "ledger_status": {r["status"]: r["n"] for r in statuses}},
        "latency_ms": {"ask_p50": pct([o["latency_ms"] for o in ans], 0.5), "ask_p95": pct([o["latency_ms"] for o in ans], 0.95),
                       "retrieval_p50": pct([o["retrieval_ms"] for o in ans], 0.5), "retrieval_p95": pct([o["retrieval_ms"] for o in ans], 0.95)},
        # everything is kept: each question with the model's raw outputs, every raw output of the run in order, every ledger row
        "questions": rows,
        "all_raw_outputs": [{"n": i, "feature": feat, "raw": raw} for i, (feat, raw) in enumerate(rec.raw)],
        "ledger_rows": [dict(x) for x in admin.execute(
            """SELECT feature, model, prompt_version, attempt, status, input_tokens, output_tokens, reserved_micro_usd::bigint AS reserved,
                      cost_micro_usd::bigint AS cost, latency_ms, created_at FROM ai_usage_ledger
                WHERE tenant_id = ANY(%s::uuid[]) ORDER BY created_at, attempt""", ([north.tenant, harbour.tenant],)).fetchall()],
        "finished_at": datetime.now(UTC).isoformat(),
    })
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(result, indent=2, default=str), encoding="utf-8")
    a = result["abstention"]
    print(f"eval: {args.provider} {args.model} embedder={embedder.model_id} cut_short={result['cut_short']}")
    print(f"eval: unanswerable refused {a['unanswerable']['dont_know']}/{a['unanswerable']['n']}; restricted refused {a['restricted']['dont_know']}/{a['restricted']['n']}; "
          f"conflicts refused {a['conflicting']['dont_know']}/{a['conflicting']['n']} (reason conflict {a['conflicting']['with_reason_sources_conflict']}); "
          f"answerable wrongly refused {a['answerable_wrongly_refused']['refused']}/{a['answerable_wrongly_refused']['n']}")
    ci = result["citations"]
    print(f"eval: citations valid on re-check {ci['valid_on_recheck']}/{ci['returned']}; removed by validator {ci['removed_by_validator']}; "
          f"answers with a fabricated source {ci['fabricated_source_answers']}; cross-company citations {ci['cross_company_citations']}; "
          f"confidential passages approved or cited {ci['above_reader_level_approved_or_cited']}")
    co = result["correctness"]
    print(f"eval: correctness (judge) of {co['answered']} answered: correct {co['correct']}, partly {co['partly']}, wrong {co['wrong']}, unjudged {co['unjudged']}")
    print(f"eval: interview {json.dumps(iv_result)}")
    print(f"eval: readiness {json.dumps({k: v for k, v in rd_result.items() if k not in ('refused_mcq', 'refused_open')})}")
    inj_r = result["injection"]
    print(f"eval: injection questions followed {len(inj_r['questions']['model_followed'])}/10, reached answer {len(inj_r['questions']['reached_answer'])}; "
          f"planted doc reached prompt {len(inj_r['planted_document']['reached_prompt'])}/10, followed {len(inj_r['planted_document']['model_followed'])}, "
          f"reached answer {len(inj_r['planted_document']['reached_answer'])}")
    print(f"eval: cost total {total} micro-USD (cap {cap}); ledger equals period total: {result['cost']['ledger_equals_period_total']}; "
          f"latency ask p50 {result['latency_ms']['ask_p50']} ms p95 {result['latency_ms']['ask_p95']} ms")
    db.close()
    admin.close()


if __name__ == "__main__":
    try:
        main()
    except BaseException as exc:
        # Nothing that was paid for may go unrecorded: save every raw output and every ledger row made so far.
        if "rec" in STATE:
            try:
                ledger_rows = [dict(x) for x in STATE["admin"].execute(
                    """SELECT tenant_id::text AS tenant, feature, model, prompt_version, attempt, status, input_tokens, output_tokens,
                              cost_micro_usd::bigint AS cost, created_at FROM ai_usage_ledger ORDER BY created_at, attempt""").fetchall()]
            except Exception:
                ledger_rows = []
            partial = {"provider": STATE["provider"], "model": STATE["model"], "crashed": True, "error": f"{type(exc).__name__}: {str(exc)[:500]}",
                       "total_micro_usd_in_ledger": sum(int(x["cost"] or 0) for x in ledger_rows),
                       "all_raw_outputs": [{"n": i, "feature": f, "raw": raw} for i, (f, raw) in enumerate(STATE["rec"].raw)],
                       "ledger_rows": ledger_rows}
            Path(STATE["out"]).parent.mkdir(parents=True, exist_ok=True)
            Path(STATE["out"]).write_text(json.dumps(partial, indent=2, default=str), encoding="utf-8")
            print(f"eval: CRASHED after {len(STATE['rec'].raw)} model calls - partial record saved ({partial['error'][:200]})")
        raise
