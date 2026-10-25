"""The in-memory search (decision D41, step 3) without a database: word splitting, the question's rules, the two
rankings, their fusion, and that nothing outside the visible ids ever comes back. Synthetic texts and vectors only."""

from __future__ import annotations

import math
import random
from collections import Counter
from pathlib import Path

import pytest

from app.capture.memory_search import FUSION_K, STOPWORDS, CompanyIndex, Entry, parse_query, words

PG_STOP = Path("/usr/share/postgresql/16/tsearch_data/english.stop")


def entry(n: int, text: str, vector: list[float], status: str = "unverified", kind: str = "source") -> Entry:
    return Entry(id=f"00000000-0000-4000-8000-{n:012d}", kind=kind, text=text, vector=vector, source_id=None, knowledge_item_id=None,
                 verification_status=status)


def axis(i: int, dims: int = 8) -> list[float]:
    v = [0.0] * dims
    v[i] = 1.0
    return v


# ------------------------------------------------------------------ words and questions

def test_words_are_split_lowered_stemmed_and_stopwords_dropped_like_postgresql() -> None:
    assert len(STOPWORDS) == 127
    if PG_STOP.exists():                      # where PostgreSQL is installed: the very same list
        assert set(PG_STOP.read_text().split()) == STOPWORDS
    assert words("The Pumps were RESTARTED after the power cuts") == ["pump", "restart", "power", "cut"]
    # numbers and codes stay as written; a decimal number is one word
    assert words("Set PV-3 to 6.0 bar, fault F12") == ["set", "pv", "3", "6.0", "bar", "fault", "f12"]
    assert words("") == [] and words("the and of") == []


def test_a_question_is_read_like_websearch_to_tsquery() -> None:
    q = parse_query('How do I recover from fault F21? "low bowl" or valve -tank')
    assert q.groups == ((frozenset({"recov", "fault", "f21", "low", "bowl"}), frozenset()), (frozenset({"valv"}), frozenset({"tank"})))
    assert q.matches({"recov", "fault", "f21", "low", "bowl", "other"})
    assert not q.matches({"recov", "fault", "f21", "low"})                     # every word of a group is needed
    assert q.matches({"valv"}) and not q.matches({"valv", "tank"})            # "-tank": must not appear
    assert parse_query("the of and").groups == ()                            # only stopwords: matches nothing
    assert parse_query("- or or").groups == ()


# ------------------------------------------------------------------ ranking

def test_meaning_ranks_by_cosine_and_words_need_every_word() -> None:
    index = CompanyIndex([
        entry(1, "cooling pump restart", axis(0)),
        entry(2, "cooling fan", axis(1)),
        entry(3, "pump seal", [0.9, 0.1] + [0.0] * 6),
    ])
    ids = [e.id for e in [entry(i, "", []) for i in (1, 2, 3)]]
    hits = index.search("cooling pump", axis(0), ids, 10)
    # entry 1: best on meaning (rank 1) and the only one with both words (rank 1)
    assert hits[0].id == ids[0]
    assert hits[0].score == pytest.approx(2 / (FUSION_K + 1))
    assert hits[0].similarity == pytest.approx(1.0)
    by_id = {h.id: h for h in hits}
    assert by_id[ids[2]].score == pytest.approx(1 / (FUSION_K + 2))    # meaning rank 2, no word match ("cooling" missing)
    assert by_id[ids[1]].score == pytest.approx(1 / (FUSION_K + 3))    # meaning rank 3 only


def test_nothing_outside_the_visible_ids_is_ranked_or_returned() -> None:
    entries = [entry(i, f"boiler relief valve unit {i}", axis(i % 8)) for i in range(1, 41)]
    index = CompanyIndex(entries)
    visible = [e.id for e in entries[::3]]
    for question in ("boiler relief valve", "unit", "nothing matches this"):
        hits = index.search(question, axis(0), [*visible, "not-in-the-index"], 200)
        assert {h.id for h in hits} <= set(visible)
    assert index.search("boiler", axis(0), [], 10) == []
    assert index.search("boiler", axis(0), ["unknown"], 10) == []


def test_each_list_keeps_twenty_and_the_order_breaks_ties_like_the_sql() -> None:
    entries = [entry(i, "valve", axis(0)) for i in range(1, 31)]
    hits = CompanyIndex(entries).search("valve", axis(0), [e.id for e in entries], 100)
    # 30 equal chunks: each list keeps 20, all at RANK() 1, so 20 hits with the same score
    assert len(hits) == 20 and all(h.score == pytest.approx(2 / (FUSION_K + 1)) for h in hits)
    # equal scores: verified or corrected first, then by id
    pair = [entry(1, "valve", axis(0)), entry(2, "valve", axis(0), status="verified", kind="item")]
    hits = CompanyIndex(pair).search("valve", axis(0), [e.id for e in pair], 10)
    assert [h.id for h in hits] == [pair[1].id, pair[0].id]


def test_bm25_from_the_compact_index_equals_the_textbook_formula() -> None:
    rnd = random.Random(7)
    vocab = ["pump", "valve", "seal", "boiler", "filler", "capper", "torque", "label", "glue", "chain", "grease", "bearing"]
    texts = [" ".join(rnd.choice(vocab) for _ in range(rnd.randint(3, 40))) for _ in range(60)]
    index = CompanyIndex(entry(i, t, axis(i % 8)) for i, t in enumerate(texts))
    query = parse_query("pump valve")
    docs = index._matching(query)
    got = index.bm25(docs, query)
    counts = [Counter(words(t)) for t in texts]
    avg = sum(sum(c.values()) for c in counts) / len(counts)
    for d, score in zip(docs.tolist(), got.tolist(), strict=True):
        assert counts[d]["pump"] and counts[d]["valv"]
        expected = 0.0
        for term in ("pump", "valv"):
            df = sum(1 for c in counts if c[term])
            idf = math.log(1 + (len(texts) - df + 0.5) / (df + 0.5))
            tf = counts[d][term]
            expected += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * sum(counts[d].values()) / avg))
        assert score == pytest.approx(expected, rel=1e-5)
    assert set(docs.tolist()) == {i for i, c in enumerate(counts) if c["pump"] and c["valv"]}


def test_the_index_keeps_word_stems_but_not_the_text() -> None:
    index = CompanyIndex([entry(1, "How the cooling pump is restarted after a power cut.", axis(0))])
    assert "restarted after" not in repr(vars(index)) and "cooling" not in repr(vars(index))
    assert index.nbytes() > 0 and len(index) == 1
