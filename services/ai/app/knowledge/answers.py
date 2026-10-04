"""Cited answers that can say "I don't know" (feature 14) and ask-the-expert answers (feature 15).
Pipeline and rules: docs/phase2/06 §3-4.

Step 1 (retrieve) returns candidate ids only. The API approves them with the policy decision
point. Step 2 (answer) loads ONLY the approved chunks, again under the filter, and is the only
place stored text enters an answer prompt. Everything after the model call is checked in code.
"""

from __future__ import annotations

import hashlib
import re
import time
from dataclasses import dataclass, field
from typing import Any

from app.ai_gateway import AnswerOutput, Caller, DataBlock, Embedder, Gateway
from app.capture import condition, load_approved, redact, retrieve
from app.knowledge.conflicts import check as check_conflicts
from app.platform import Database, ServiceContext, one, write_audit

PROMPT_SOURCES = 6
MAX_CONFLICTS_SHOWN = 5
HIGH_SIMILARITY_MARGIN = 0.15
SNIPPET_CHARS = 300

_WS = re.compile(r"\s+")


def _norm(text: str) -> str:
    return _WS.sub(" ", text).strip().lower()


@dataclass
class Citation:
    ref: str
    kind: str
    id: str
    title: str
    snippet: str
    verification_status: str
    chunk_id: str
    quote_start: int
    quote_end: int
    derived_from: list[dict[str, str]] = field(default_factory=list)
    expert_display_name: None = None    # added by the API, which may read names

    def public(self) -> dict[str, Any]:
        return {"ref": self.ref, "kind": self.kind, "id": self.id, "title": self.title, "snippet": self.snippet,
                "verification_status": self.verification_status, "expert_display_name": None, "derived_from": self.derived_from}


@dataclass
class AnswerResult:
    outcome: str                      # answered | dont_know | search_only
    reason: str | None
    answer: str | None = None
    confidence: str | None = None
    citations: list[Citation] = field(default_factory=list)
    candidates: int = 0
    approved: int = 0
    claims_valid: int = 0
    claims_rejected: int = 0
    fabricated: bool = False
    cost_micro_usd: int = 0
    ledger_id: str | None = None
    log_id: str | None = None
    conflict_found_by: str | None = None         # "value_check" | "ai_model" when the reason is sources_conflict
    conflicts: list[dict[str, Any]] = field(default_factory=list)   # what disagrees, in the sources' own words
    conflict_check_partial: bool = False         # the check in code reached one of its limits and did not read everything

    def public(self) -> dict[str, Any]:
        return {
            "outcome": self.outcome, "answer": self.answer, "reason": self.reason, "confidence": self.confidence,
            "contains_unverified_sources": any(c.verification_status not in ("verified", "corrected") for c in self.citations),
            "citations": [c.public() for c in self.citations],
            "can_ask_expert": self.outcome == "dont_know",
            "answer_id": self.log_id,
            "conflict_found_by": self.conflict_found_by,
            "conflicts": self.conflicts,
            "conflict_check_partial": self.conflict_check_partial,
        }


def candidate_ids(db: Database, ctx: ServiceContext, embedder: Embedder, question: str, expert_person_id: str | None) -> list[dict[str, str]]:
    """Step 1. Ids and kinds only - no text leaves this function."""
    question = redact(question).text
    with db.tenant_tx(ctx.tenant_id) as cur:
        found = retrieve(cur, tenant_id=ctx.tenant_id, spec=ctx.filter, question=question, embedder=embedder,
                         contributor_person_id=expert_person_id, items_only=expert_person_id is not None)
    return [{"id": c.id, "kind": c.kind} for c in found]


Named = tuple[str, str, str, list[dict[str, str]]]


def _titles(cur: Any, tenant_id: str, rows: list[dict[str, Any]], spec: Any) -> dict[str, Named]:
    """For each chunk: (kind, id, title) of what the citation names, and readable provenance for items."""
    out: dict[str, Named] = {}
    source_ids = [r["source_id"] for r in rows if r["source_id"]]
    item_ids = [r["knowledge_item_id"] for r in rows if r["knowledge_item_id"]]
    source_titles: dict[str, str] = {}
    if source_ids:
        cur.execute("SELECT id::text AS id, title FROM sources WHERE tenant_id = %s AND id = ANY(%s::uuid[])", (tenant_id, source_ids))
        source_titles = {r["id"]: r["title"] for r in cur.fetchall()}
    item_titles: dict[str, str] = {}
    provenance: dict[str, list[dict[str, str]]] = {i: [] for i in item_ids}
    if item_ids:
        cur.execute("SELECT id::text AS id, title FROM knowledge_items WHERE tenant_id = %s AND id = ANY(%s::uuid[])", (tenant_id, item_ids))
        item_titles = {r["id"]: r["title"] for r in cur.fetchall()}
        # Sources behind an item are named only if THIS reader may read them (docs/phase2/03).
        where, params = condition(spec, "sources", tenant_id)
        cur.execute(
            f"""SELECT DISTINCT i.id::text AS item_id, s.id::text AS source_id, s.title
                  FROM knowledge_items i
                  JOIN knowledge_versions v ON v.tenant_id = i.tenant_id AND v.id = i.current_version_id
                  JOIN citations ci ON ci.tenant_id = i.tenant_id AND ci.subject_type = 'knowledge_version' AND ci.subject_id = v.id
                  JOIN chunks c ON c.tenant_id = i.tenant_id AND c.id = ci.chunk_id
                  JOIN sources s ON s.tenant_id = c.tenant_id AND s.id = c.source_id
                 WHERE i.tenant_id = %s AND i.id = ANY(%s::uuid[]) AND s.status = 'ready' AND {where}""",
            [tenant_id, item_ids, *params])
        for r in cur.fetchall():
            provenance[r["item_id"]].append({"source_id": r["source_id"], "title": r["title"]})
    for r in rows:
        if r["kind"] == "item":
            out[r["id"]] = ("item", r["knowledge_item_id"], item_titles.get(r["knowledge_item_id"], ""), provenance.get(r["knowledge_item_id"], []))
        else:
            out[r["id"]] = ("source", r["source_id"], source_titles.get(r["source_id"], ""), [])
    return out


def _citation(ref: str, row: dict[str, Any], named: Named, quote_at: tuple[int, int] | None) -> Citation:
    kind, target_id, title, derived = named
    start, end = quote_at if quote_at else (0, min(len(row["text"]), SNIPPET_CHARS))
    snippet = row["text"][start:end] if quote_at else row["text"][:SNIPPET_CHARS]
    return Citation(ref=ref, kind=kind, id=target_id, title=title, snippet=snippet, verification_status=row["verification_status"],
                    chunk_id=row["id"], quote_start=start, quote_end=end, derived_from=derived)


def _find(quote: str, text: str) -> tuple[int, int] | None:
    """Where the quote appears in the source, ignoring differences in whitespace and letter case."""
    q = _norm(quote)
    if len(q) < 8:
        return None
    pattern = r"\s+".join(re.escape(part) for part in q.split(" "))
    m = re.search(pattern, text, flags=re.IGNORECASE)
    return (m.start(), m.end()) if m else None


def answer(db: Database, ctx: ServiceContext, gateway: Gateway, embedder: Embedder, caller: Caller, question: str,
           expert_person_id: str | None, unavailable_reason: str | None) -> AnswerResult:
    """Step 2. `unavailable_reason` is set by the API when AI must not be used (grace period)."""
    started = time.monotonic()
    # The question is untrusted text like any other: redacted before it is embedded, logged or sent to a model.
    question = redact(question).text
    vector = embedder.embed([question], "query")[0]
    with db.tenant_tx(ctx.tenant_id) as cur:
        rows = load_approved(cur, tenant_id=ctx.tenant_id, spec=ctx.filter, approved_ids=list(ctx.approved), question_vector=vector)
        if expert_person_id is not None:   # ask-the-expert: only that expert's verified items, whatever was approved
            rows = [r for r in rows if r["kind"] == "item" and r["owner_person_id"] == expert_person_id
                    and r["verification_status"] in ("verified", "corrected")]
        relevant = [r for r in rows if r["similarity"] is not None and r["similarity"] >= embedder.relevance_threshold]
        relevant.sort(key=lambda r: (-float(r["similarity"]), r["verification_status"] not in ("verified", "corrected"), r["id"]))
        top = relevant[:PROMPT_SOURCES]
        named = _titles(cur, ctx.tenant_id, top, ctx.filter)
    result = AnswerResult(outcome="dont_know", reason="no_relevant_sources", candidates=len(ctx.approved), approved=len(rows))

    if not top:
        return _finish(db, ctx, question, expert_person_id, result, started)

    if unavailable_reason is not None:
        return _finish(db, ctx, question, expert_person_id, _search_only(result, top, named, unavailable_reason), started)

    labels = {f"S{i + 1}": r for i, r in enumerate(top)}
    blocks = [DataBlock(label="QUESTION", text=question)] + [DataBlock(label=label, text=r["text"]) for label, r in labels.items()]
    outcome = gateway.generate(caller, "answer", "answer", blocks)
    result.cost_micro_usd = outcome.cost_micro_usd
    result.ledger_id = outcome.ledger_ids[-1] if outcome.ledger_ids else None
    if outcome.parsed is None:
        reason = {"kill_switch": "ai_disabled", "budget": "budget_exhausted", "global": "budget_exhausted", "rate": "budget_exhausted",
                  "limits": "budget_exhausted"}.get(outcome.refused or "", "ai_unavailable")
        return _finish(db, ctx, question, expert_person_id, _search_only(result, top, named, reason), started)

    parsed = outcome.parsed
    if not isinstance(parsed, AnswerOutput):   # the gateway validated against the answer prompt's model; anything else is a bug
        raise RuntimeError("answer prompt returned another output type")
    valid: list[Citation] = []
    for claim in parsed.claims:
        row = labels.get(claim.source)
        if row is None:
            result.fabricated = True
            result.claims_rejected += 1
            continue
        at = _find(claim.quote, row["text"])
        if at is None:
            result.claims_rejected += 1
            continue
        result.claims_valid += 1
        valid.append(_citation(claim.source, row, named[row["id"]], at))

    total = result.claims_valid + result.claims_rejected
    # The check in code (feature 23): does another approved source state a different value for something the answer
    # says? It runs whatever the model reported, on the same passages the model saw.
    code_conflicts, result.conflict_check_partial = _conflicts_in_code(labels, named, valid, parsed.answer) if parsed.answerable and valid else ([], False)
    if not parsed.answerable:
        result.reason = "no_relevant_sources"
    elif parsed.conflict:
        result.reason, result.conflict_found_by, result.conflicts = "sources_conflict", "ai_model", code_conflicts
    elif code_conflicts:
        result.reason, result.conflict_found_by, result.conflicts = "sources_conflict", "value_check", code_conflicts
    elif result.claims_valid == 0 or result.claims_rejected * 2 > total:
        result.reason = "not_grounded"
    else:
        all_verified = all(c.verification_status in ("verified", "corrected") for c in valid)
        best = max(float(labels[c.ref]["similarity"]) for c in valid)
        if result.claims_rejected == 0 and all_verified and best >= embedder.relevance_threshold + HIGH_SIMILARITY_MARGIN:
            confidence = "high"
        elif result.claims_valid * 2 >= total:
            confidence = "medium"
        else:
            confidence = "low"
        if confidence == "low":
            result.reason = "low_confidence"
        else:
            result.outcome, result.reason, result.confidence = "answered", None, confidence
            result.answer = parsed.answer
            seen: set[str] = set()
            result.citations = [c for c in valid if not (c.chunk_id in seen or seen.add(c.chunk_id))]  # type: ignore[func-returns-value]
    return _finish(db, ctx, question, expert_person_id, result, started)


def _conflicts_in_code(labels: dict[str, dict[str, Any]], named: dict[str, Named], valid: list[Citation],
                       answer_text: str) -> tuple[list[dict[str, Any]], bool]:
    """(what disagrees, whether the check was cut short). Passages of one document or item are ONE source: a
    document is never set against itself. Only passages that passed the reader's filter and the re-check are here."""
    texts: dict[str, str] = {}
    offset: dict[str, int] = {}          # where each passage starts inside its source's joined text
    sides: dict[str, dict[str, str]] = {}
    for label, row in labels.items():
        kind, target_id, title, _ = named[row["id"]]
        key = f"{kind}:{target_id}"
        offset[label] = len(texts[key]) + 1 if key in texts else 0
        texts[key] = texts[key] + "\n" + row["text"] if key in texts else row["text"]
        sides[key] = {"kind": kind, "id": target_id, "title": title}
    cited = []
    for c in valid:
        kind, target_id, _, _ = named[labels[c.ref]["id"]]
        cited.append((f"{kind}:{target_id}", offset[c.ref] + c.quote_start, offset[c.ref] + c.quote_end))
    report = check_conflicts(texts, cited=cited, answer=answer_text)
    out = [{"measure": c.measure, "a": sides[c.a.source] | {"value": c.a.raw[:200]}, "b": sides[c.b.source] | {"value": c.b.raw[:200]}}
           for c in report.conflicts[:MAX_CONFLICTS_SHOWN]]
    return out, report.truncated


def _search_only(result: AnswerResult, top: list[dict[str, Any]], named: dict[str, Any], reason: str) -> AnswerResult:
    result.outcome, result.reason = "search_only", reason
    result.citations = [_citation(f"S{i + 1}", r, named[r["id"]], None) for i, r in enumerate(top)]
    return result


def _finish(db: Database, ctx: ServiceContext, question_redacted: str, expert_person_id: str | None, result: AnswerResult,
            started: float) -> AnswerResult:
    with db.tenant_tx(ctx.tenant_id) as cur:
        cur.execute(
            """INSERT INTO answer_logs (tenant_id, card_id, question_redacted, expert_person_id, outcome, reason, confidence, candidates,
                   approved, policy_disagreements, claims_valid, claims_rejected, fabricated_citation, prompt_version, ledger_id, latency_ms,
                   conflict_found_by, contains_unverified_sources)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 0, %s, %s, %s, 'answer@v1', %s, %s, %s, %s) RETURNING id::text AS id""",
            (ctx.tenant_id, ctx.card_id, question_redacted[:500] or "-", expert_person_id, result.outcome, result.reason, result.confidence,
             result.candidates, result.approved, result.claims_valid, result.claims_rejected, result.fabricated, result.ledger_id,
             int((time.monotonic() - started) * 1000), result.conflict_found_by if result.reason == "sources_conflict" else None,
             result.outcome == "answered" and any(c.verification_status not in ("verified", "corrected") for c in result.citations)))
        log_id = one(cur)["id"]
        result.log_id = log_id
        for c in result.citations:
            if result.outcome != "answered":
                break
            cur.execute(
                """INSERT INTO citations (tenant_id, subject_type, subject_id, chunk_id, quote_start, quote_end, quote_sha256)
                   VALUES (%s, 'answer', %s, %s, %s, %s, %s)""",
                (ctx.tenant_id, log_id, c.chunk_id, c.quote_start, max(c.quote_end, c.quote_start + 1),
                 hashlib.sha256(c.snippet.encode()).digest()))
            if c.kind == "item":
                cur.execute("UPDATE knowledge_items SET usage_count = usage_count + 1 WHERE tenant_id = %s AND id = %s", (ctx.tenant_id, c.id))
        write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="knowledge:answer", reason_code=f"ANSWER_{result.outcome.upper()}",
                    resource_type="answer", resource_id=log_id, request_id=ctx.request_id,
                    details={"candidates": result.candidates, "approved": result.approved, "outcome": result.outcome},
                    api_key_id=ctx.api_key_id)
    return result
