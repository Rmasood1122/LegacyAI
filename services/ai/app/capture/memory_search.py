"""Search in memory, per company (decision D41, step 3; docs/phase4/10-content-under-company-key.md).

Once content is sealed, the database can no longer search it. This module does the same search in the AI service's
memory, from one company's chunks:
- meaning: cosine similarity over all vectors, held as one float32 matrix;
- words: BM25 with the Snowball English stemmer (the stemmer PostgreSQL's 'english' configuration uses);
- the two ranked lists merged exactly as the SQL search merges them (reciprocal-rank fusion, k = 60, top 20 of each).

The access filter is NOT applied here: the caller passes the ids the filter lets this person see (still decided in
SQL, on readable labels), and nothing outside them is ranked or returned.

Not wired into answering yet. Step 3 compares its rankings with the SQL search and measures it (eval/search_compare.py,
eval/search_measure.py); the switch happens only after the founder accepts the numbers.

Known differences from PostgreSQL's word search, on purpose or for simplicity:
- ranking is BM25 (word rarity across the company, document length), not ts_rank_cd (closeness of the words);
- a quoted phrase counts as its words in any order (PostgreSQL requires them next to each other);
- words are split on anything that is not a letter or digit ("PV-3" -> "pv", "3"; PostgreSQL keeps "-3"), and a decimal
  number such as "6.0" stays one word, as in PostgreSQL.
"""

from __future__ import annotations

import functools
import math
import re
from array import array
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np
import snowballstemmer
from numpy.typing import NDArray

FUSION_K = 60          # as in retrieval.py: 1 / (60 + rank)
PER_LIST = 20          # as in retrieval.py: the top 20 of each list take part
BM25_K1 = 1.2
BM25_B = 0.75

# PostgreSQL's english.stop (127 words), so that the same words are ignored in documents and questions.
_POSTGRES_ENGLISH_STOP = """
i me my myself we our ours ourselves you your yours yourself yourselves he him his himself she her hers herself it its
itself they them their theirs themselves what which who whom this that these those am is are was were be been being have
has had having do does did doing a an the and but if or because as until while of at by for with about against between
into through during before after above below to from up down in out on off over under again further then once here there
when where why how all any both each few more most other some such no nor not only own same so than too very s t can will
just don should now
"""
STOPWORDS = frozenset(_POSTGRES_ENGLISH_STOP.split())

_TOKEN = re.compile(r"[^\W_]+(?:\.\d+)?")
_STEMMER = snowballstemmer.stemmer("english")


@functools.lru_cache(maxsize=200_000)
def _stem(word: str) -> str:
    """Stemming is the slow part of indexing; a company uses a few thousand distinct words, so each is stemmed once."""
    return str(_STEMMER.stemWord(word))


def words(text: str) -> list[str]:
    """The indexed form of a text: lower case, stopwords removed, words stemmed (numbers and codes kept as written)."""
    return [_stem(raw) if raw.isalpha() else raw for raw in _TOKEN.findall(text.lower()) if raw not in STOPWORDS]


@dataclass(frozen=True)
class Query:
    """A question as PostgreSQL's websearch_to_tsquery reads it: words must all appear; "or" between words gives
    alternatives; a word written with a leading "-" must not appear. Each group is (required, excluded)."""

    groups: tuple[tuple[frozenset[str], frozenset[str]], ...]

    @property
    def terms(self) -> frozenset[str]:
        return frozenset(t for required, _ in self.groups for t in required)

    def matches(self, present: frozenset[str] | set[str]) -> bool:
        return any(required <= present and not (excluded & present) for required, excluded in self.groups)


def parse_query(question: str) -> Query:
    groups: list[tuple[frozenset[str], frozenset[str]]] = []
    required: set[str] = set()
    excluded: set[str] = set()
    for raw in question.replace('"', " ").split():
        if raw.lower() == "or":
            if required:
                groups.append((frozenset(required), frozenset(excluded)))
            required, excluded = set(), set()
            continue
        negated = raw.startswith("-") and len(raw) > 1
        for w in words(raw[1:] if negated else raw):
            (excluded if negated else required).add(w)
    if required:
        groups.append((frozenset(required), frozenset(excluded)))
    return Query(tuple(groups))


@dataclass(frozen=True)
class Entry:
    """One chunk as the index needs it. `vector` is the stored embedding (384 numbers): a list, or better an array
    (the database's half-precision vectors stay small until the index is built)."""

    id: str
    kind: str
    text: str
    vector: Sequence[float] | NDArray[np.floating[Any]]
    source_id: str | None
    knowledge_item_id: str | None
    verification_status: str


@dataclass(frozen=True)
class Hit:
    id: str
    kind: str
    source_id: str | None
    knowledge_item_id: str | None
    verification_status: str
    score: float
    similarity: float


def _rank_with_ties(values: Sequence[float]) -> list[int]:
    """SQL RANK() over values already sorted best first: equal values share a rank, the next rank skips."""
    ranks: list[int] = []
    for i, v in enumerate(values):
        ranks.append(ranks[-1] if i and v == values[i - 1] else i + 1)
    return ranks


class CompanyIndex:
    """One company's chunks, ready to search. Built once, read many times; never changed in place.

    The word index is an inverted index in three flat arrays: for each word, the chunks that contain it and how often
    (`starts[w]` to `starts[w + 1]` in `docs` and `counts`). The texts themselves are not kept: the answer step reads
    the approved chunks again under the access filter (retrieval.load_approved)."""

    def __init__(self, entries: Iterable[Entry]) -> None:
        self.meta: list[tuple[str, str, str | None, str | None, str]] = []
        vectors: list[NDArray[np.floating[Any]]] = []
        self.term_id: dict[str, int] = {}
        term_col, doc_col, count_col = array("i"), array("i"), array("i")
        lengths = array("f")
        for i, e in enumerate(entries):
            self.meta.append((e.id, e.kind, e.source_id, e.knowledge_item_id, e.verification_status))
            vectors.append(np.asarray(e.vector))
            counts = Counter(words(e.text))
            lengths.append(sum(counts.values()))
            for term, c in counts.items():
                term_col.append(self.term_id.setdefault(term, len(self.term_id)))
                doc_col.append(i)
                count_col.append(c)
        self.position = {m[0]: i for i, m in enumerate(self.meta)}
        n = len(self.meta)
        matrix = np.vstack(vectors).astype(np.float32) if vectors else np.empty((0, 0), dtype=np.float32)
        del vectors
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        norms[norms == 0] = 1
        matrix /= norms                                              # unit length: cosine is then a dot product
        self.matrix = matrix
        terms = np.frombuffer(term_col, dtype=np.int32)
        order = np.argsort(terms, kind="stable")
        self.docs = np.frombuffer(doc_col, dtype=np.int32)[order].copy()
        self.counts = np.frombuffer(count_col, dtype=np.int32)[order].astype(np.float32)
        self.starts = np.searchsorted(terms[order], np.arange(len(self.term_id) + 1)).astype(np.int64)
        self.lengths = np.frombuffer(lengths, dtype=np.float32).copy()
        self.average_length = float(self.lengths.mean()) if n else 0.0

    def __len__(self) -> int:
        return len(self.meta)

    def nbytes(self) -> int:
        """The arrays of the index, in bytes (the per-chunk ids and the word dictionary come on top)."""
        return int(self.matrix.nbytes + self.docs.nbytes + self.counts.nbytes + self.starts.nbytes + self.lengths.nbytes)

    def _postings(self, term: str) -> tuple[np.ndarray, np.ndarray]:
        t = self.term_id.get(term)
        if t is None:
            return np.empty(0, dtype=np.int32), np.empty(0, dtype=np.float32)
        a, b = self.starts[t], self.starts[t + 1]
        return self.docs[a:b], self.counts[a:b]

    def _matching(self, query: Query) -> np.ndarray:
        """The chunks the question's words select, as websearch_to_tsquery would."""
        found: list[np.ndarray] = []
        for required, excluded in query.groups:
            docs: np.ndarray | None = None
            for term in required:
                d = self._postings(term)[0]
                docs = d if docs is None else np.intersect1d(docs, d, assume_unique=True)
            if docs is None or docs.size == 0:
                continue
            for term in excluded:
                docs = np.setdiff1d(docs, self._postings(term)[0], assume_unique=True)
            found.append(docs)
        return np.unique(np.concatenate(found)) if found else np.empty(0, dtype=np.int32)

    def bm25(self, docs: np.ndarray, query: Query) -> np.ndarray:
        """BM25 of each chunk in `docs` (sorted) for the question's words."""
        scores = np.zeros(docs.size, dtype=np.float64)
        n = len(self.meta)
        norm = BM25_K1 * (1 - BM25_B + BM25_B * self.lengths[docs] / (self.average_length or 1))
        for term in query.terms:
            d, c = self._postings(term)
            if d.size == 0:
                continue
            idf = math.log(1 + (n - d.size + 0.5) / (d.size + 0.5))
            where = np.searchsorted(d, docs)
            present = (where < d.size) & (d[np.minimum(where, d.size - 1)] == docs)
            tf = np.where(present, c[np.minimum(where, d.size - 1)], 0)
            scores += idf * tf * (BM25_K1 + 1) / (tf + norm)
        return scores

    def search(self, question: str, question_vector: Sequence[float], visible_ids: Iterable[str], limit: int) -> list[Hit]:
        """The same result shape and order as retrieval.retrieve, over `visible_ids` only."""
        visible = np.zeros(len(self.meta), dtype=bool)
        for v in visible_ids:
            i = self.position.get(v)
            if i is not None:
                visible[i] = True
        if not visible.any():
            return []
        q = np.asarray(question_vector, dtype=np.float32)
        q = q / (np.linalg.norm(q) or 1)
        similarity = self.matrix @ q

        # meaning: the 20 most similar visible chunks (ties broken by position, as an unordered SQL LIMIT breaks them somehow)
        candidates = np.flatnonzero(visible)
        order = candidates[np.argsort(-similarity[candidates], kind="stable")[:PER_LIST]]
        semantic = dict(zip(order.tolist(), _rank_with_ties(similarity[order].tolist()), strict=True))

        # words: visible chunks that match the question, best BM25 first, top 20
        query = parse_query(question)
        matched = self._matching(query)
        matched = matched[visible[matched]]
        keyword: dict[int, int] = {}
        if matched.size:
            scores = self.bm25(matched, query)
            best = np.argsort(-scores, kind="stable")[:PER_LIST]
            keyword = dict(zip(matched[best].tolist(), _rank_with_ties(scores[best].tolist()), strict=True))

        hits = []
        for i in set(semantic) | set(keyword):
            cid, kind, source_id, item_id, status = self.meta[i]
            score = (1.0 / (FUSION_K + semantic[i]) if i in semantic else 0.0) + (1.0 / (FUSION_K + keyword[i]) if i in keyword else 0.0)
            hits.append(Hit(cid, kind, source_id, item_id, status, score, float(similarity[i])))
        hits.sort(key=lambda h: (-h.score, h.verification_status not in ("verified", "corrected"), h.id))
        return hits[:limit]
