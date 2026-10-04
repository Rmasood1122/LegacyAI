"""The knowledge map (feature 30, docs/phase4/03): what is linked to what.

Nodes: topics, knowledge items, documents (sources), job roles. Edges come ONLY from links that already exist:
item -> topic, item -> document (the passages an item cites), job role -> topic, item - item (a stored conflict;
it has no direction). Nothing is inferred. People are not nodes: who contributed what is personal data that the
existing screens show only in a few places, and a map would make it easy to list everything one person wrote.

Every node and every edge passes the caller's own filters: items and documents through the `knowledge:read`
filter in the token, topics through the `topic:read` filter. Documents are read exactly as an item's provenance
is read elsewhere (reads.py: ready, and readable by the caller). A node the caller may not read is not returned
and not counted, and asking for it answers "not found" - the same answer as for a node that does not exist. So a
neighbour that is hidden from the caller and a neighbour that does not exist cannot be told apart, on purpose.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any, TypedDict

from app.capture import condition, topic_condition
from app.knowledge.reads import CITED_PASSAGE_AND_DOCUMENT, CITES_ITEM_VERSION, readable_document
from app.platform import Database, ServiceContext, write_audit

KINDS = ("topic", "item", "source", "job_role")
NEIGHBOURS = 50            # per group, in one neighbourhood
EXPORT_NODES = 2000        # per kind, in the export
EXPORT_EDGES = 10000       # all kinds together
SCHEMA = "legacyai-knowledge-graph/1"
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


class Node(TypedDict):
    kind: str            # one of KINDS
    id: str              # unique within its kind only (a job role's id is its name)
    label: str
    status: str | None   # an item's status; None for the other kinds


class Ref(TypedDict):
    kind: str
    id: str


# "from" is a Python keyword, hence this form. Direction: see EDGE_KINDS.
Edge = TypedDict("Edge", {"kind": str, "from": Ref, "to": Ref, "origin": str | None})


class Neighbour(TypedDict):
    node: Node
    origin: str | None   # how the link to the centre was made (item-topic links only), else None


class Group(TypedDict):
    group: str
    edge_kind: str
    truncated: bool      # more than NEIGHBOURS exist; the rest is not reachable through this call
    nodes: list[Neighbour]


# edge kind -> (kind of its "from" end, kind of its "to" end). item_conflict has no direction: by convention the
# item with the smaller id is "from".
EDGE_KINDS: dict[str, tuple[str, str]] = {
    "item_topic": ("item", "topic"),
    "item_source": ("item", "source"),
    "job_role_topic": ("job_role", "topic"),
    "item_conflict": ("item", "item"),
}


class GraphRefused(Exception):
    def __init__(self, code: str, status: int = 400) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


def node(kind: str, node_id: str, label: str, status: str | None = None) -> Node:
    return {"kind": kind, "id": node_id, "label": label, "status": status}


def edge(kind: str, from_id: str, to_id: str, origin: str | None = None) -> Edge:
    from_kind, to_kind = EDGE_KINDS[kind]
    return {"kind": kind, "from": {"kind": from_kind, "id": from_id}, "to": {"kind": to_kind, "id": to_id}, "origin": origin}


class _Reader:
    """One call's cursor and the caller's conditions, built once (aliases: i = knowledge_items, s = sources, tp = topics)."""

    def __init__(self, cur: Any, ctx: ServiceContext) -> None:
        self.cur = cur
        self.tenant = ctx.tenant_id
        item, self.item_params = condition(ctx.filter, "knowledge_items", ctx.tenant_id)
        # THE definition of an item the caller may see in the map: readable, and not withdrawn. Every item query uses it.
        self.visible_item = f"({item} AND i.status <> 'withdrawn')"
        source, self.source_params = condition(ctx.filter, "sources", ctx.tenant_id)
        self.readable_document = readable_document(source)
        topic, self.topic_params = topic_condition(ctx.topic_filter, ctx.tenant_id)
        self.readable_topic = f"({topic} AND tp.status <> 'retired')"

    def capped(self, sql: str, params: tuple[Any, ...], limit: int) -> tuple[list[dict[str, Any]], bool]:
        """At most `limit` rows, and whether there were more."""
        self.cur.execute(sql + " LIMIT %s", (*params, limit + 1))
        rows = [dict(r) for r in self.cur.fetchall()]
        return rows[:limit], len(rows) > limit

    def one(self, sql: str, params: tuple[Any, ...]) -> dict[str, Any] | None:
        self.cur.execute(sql, params)
        row = self.cur.fetchone()
        return dict(row) if row is not None else None

    def group(self, name: str, edge_kind: str, sql: str, params: tuple[Any, ...], make: Callable[[dict[str, Any]], Neighbour]) -> Group:
        rows, more = self.capped(sql, params, NEIGHBOURS)
        return {"group": name, "edge_kind": edge_kind, "truncated": more, "nodes": [make(r) for r in rows]}


def _item_neighbour(r: dict[str, Any]) -> Neighbour:
    return {"node": node("item", r["id"], r["title"], r["status"]), "origin": None}


def _around_item(q: _Reader, node_id: str) -> tuple[Node, list[Group]] | None:
    me = q.one(f"SELECT i.id::text AS id, i.title, i.status FROM knowledge_items i WHERE {q.visible_item} AND i.id = %s", (*q.item_params, node_id))
    if me is None:
        return None
    t = q.tenant
    return node("item", me["id"], me["title"], me["status"]), [
        q.group("topics", "item_topic",
                f"""SELECT tp.id::text AS id, tp.name, kt.link_source FROM knowledge_item_topics kt
                      JOIN topics tp ON tp.tenant_id = kt.tenant_id AND tp.id = kt.topic_id
                     WHERE kt.tenant_id = %s AND kt.item_id = %s AND {q.readable_topic} ORDER BY tp.name, tp.id""",
                (t, node_id, *q.topic_params), lambda r: {"node": node("topic", r["id"], r["name"]), "origin": r["link_source"]}),
        q.group("sources", "item_source",
                f"""SELECT DISTINCT s.id::text AS id, s.title FROM knowledge_items i
                      JOIN citations ci ON ci.tenant_id = i.tenant_id AND {CITES_ITEM_VERSION} AND ci.subject_id = i.current_version_id
                      {CITED_PASSAGE_AND_DOCUMENT}
                     WHERE i.tenant_id = %s AND i.id = %s AND {q.readable_document} ORDER BY s.title, id""",
                (t, node_id, *q.source_params), lambda r: {"node": node("source", r["id"], r["title"]), "origin": None}),
        q.group("conflicting_items", "item_conflict",
                f"""SELECT i.id::text AS id, i.title, i.status FROM knowledge_item_conflicts k
                      JOIN knowledge_items i ON i.tenant_id = k.tenant_id AND i.id = CASE WHEN k.item_id = %s THEN k.other_item_id ELSE k.item_id END
                     WHERE k.tenant_id = %s AND (k.item_id = %s OR k.other_item_id = %s) AND {q.visible_item} ORDER BY i.title, i.id""",
                (node_id, t, node_id, node_id, *q.item_params), _item_neighbour),
    ]


def _around_topic(q: _Reader, node_id: str) -> tuple[Node, list[Group]] | None:
    me = q.one(f"SELECT tp.id::text AS id, tp.name FROM topics tp WHERE {q.readable_topic} AND tp.id = %s", (*q.topic_params, node_id))
    if me is None:
        return None
    t = q.tenant
    return node("topic", me["id"], me["name"]), [
        q.group("items", "item_topic",
                f"""SELECT i.id::text AS id, i.title, i.status, kt.link_source FROM knowledge_item_topics kt
                      JOIN knowledge_items i ON i.tenant_id = kt.tenant_id AND i.id = kt.item_id
                     WHERE kt.tenant_id = %s AND kt.topic_id = %s AND {q.visible_item} ORDER BY i.title, i.id""",
                (t, node_id, *q.item_params), lambda r: {"node": node("item", r["id"], r["title"], r["status"]), "origin": r["link_source"]}),
        q.group("job_roles", "job_role_topic",
                "SELECT m.job_role FROM role_topic_maps m WHERE m.tenant_id = %s AND m.topic_id = %s ORDER BY m.job_role",
                (t, node_id), lambda r: {"node": node("job_role", r["job_role"], r["job_role"]), "origin": None}),
    ]


def _around_source(q: _Reader, node_id: str) -> tuple[Node, list[Group]] | None:
    me = q.one(f"SELECT s.id::text AS id, s.title FROM sources s WHERE s.tenant_id = %s AND s.id = %s AND {q.readable_document}",
               (q.tenant, node_id, *q.source_params))
    if me is None:
        return None
    return node("source", me["id"], me["title"]), [
        q.group("items", "item_source",
                f"""SELECT DISTINCT i.id::text AS id, i.title, i.status FROM sources s
                      JOIN chunks c ON c.tenant_id = s.tenant_id AND c.source_id = s.id
                      JOIN citations ci ON ci.tenant_id = c.tenant_id AND ci.chunk_id = c.id AND {CITES_ITEM_VERSION}
                      JOIN knowledge_items i ON i.tenant_id = ci.tenant_id AND i.current_version_id = ci.subject_id
                     WHERE s.tenant_id = %s AND s.id = %s AND {q.readable_document} AND {q.visible_item} ORDER BY i.title, id""",
                (q.tenant, node_id, *q.source_params, *q.item_params), _item_neighbour),
    ]


def _around_job_role(q: _Reader, node_id: str) -> tuple[Node, list[Group]] | None:
    """The id of a job role is its name. It exists for a caller only through topics that caller may read."""
    topics = q.group("topics", "job_role_topic",
                     f"""SELECT tp.id::text AS id, tp.name FROM role_topic_maps m
                           JOIN topics tp ON tp.tenant_id = m.tenant_id AND tp.id = m.topic_id
                          WHERE m.tenant_id = %s AND m.job_role = %s AND {q.readable_topic} ORDER BY tp.name, tp.id""",
                     (q.tenant, node_id, *q.topic_params), lambda r: {"node": node("topic", r["id"], r["name"]), "origin": None})
    if not topics["nodes"]:
        return None
    return node("job_role", node_id, node_id), [topics]


# One small function per kind of node. A new kind is one more function and one more line here.
_AROUND: dict[str, Callable[[_Reader, str], tuple[Node, list[Group]] | None]] = {
    "item": _around_item, "topic": _around_topic, "source": _around_source, "job_role": _around_job_role,
}


def neighbourhood(db: Database, ctx: ServiceContext, kind: str, node_id: str) -> dict[str, Any]:
    """One node and what it is directly linked to, in groups. At most NEIGHBOURS per group; each group says if it was cut short."""
    around = _AROUND.get(kind)
    if around is None:
        raise GraphRefused("bad_kind", 400)
    if kind != "job_role" and _UUID.fullmatch(node_id) is None:
        raise GraphRefused("not_found", 404)      # an id of the wrong shape names nothing
    with db.tenant_tx(ctx.tenant_id) as cur:
        found = around(_Reader(cur, ctx), node_id)
    if found is None:
        raise GraphRefused("not_found", 404)
    centre, groups = found
    return {"node": centre, "neighbours": groups, "limit_per_group": NEIGHBOURS}


def export(db: Database, ctx: ServiceContext) -> dict[str, Any]:
    """Every node and edge the caller may read, in one documented JSON shape (docs/phase4/03).

    Caps: EXPORT_NODES per kind of node, EXPORT_EDGES edges in all; `truncated` says a cap was reached. An edge is
    included only when both its ends are in the file. The export is recorded in the audit log (counts only).
    """
    truncated = False
    with db.tenant_tx(ctx.tenant_id) as cur:
        q = _Reader(cur, ctx)
        t = q.tenant

        def take(sql: str, params: tuple[Any, ...], limit: int) -> list[dict[str, Any]]:
            nonlocal truncated
            rows, more = q.capped(sql, params, limit)
            truncated = truncated or more
            return rows

        items = take(f"SELECT i.id::text AS id, i.title, i.status FROM knowledge_items i WHERE {q.visible_item} ORDER BY i.id",
                     tuple(q.item_params), EXPORT_NODES)
        topics = take(f"SELECT tp.id::text AS id, tp.name FROM topics tp WHERE {q.readable_topic} ORDER BY tp.id", tuple(q.topic_params), EXPORT_NODES)
        item_ids = [r["id"] for r in items]
        topic_ids = [r["id"] for r in topics]
        sources = take(
            f"""SELECT DISTINCT s.id::text AS id, s.title FROM knowledge_items i
                  JOIN citations ci ON ci.tenant_id = i.tenant_id AND {CITES_ITEM_VERSION} AND ci.subject_id = i.current_version_id
                  {CITED_PASSAGE_AND_DOCUMENT}
                 WHERE i.tenant_id = %s AND i.id = ANY(%s::uuid[]) AND {q.readable_document} ORDER BY 1""",
            (t, item_ids, *q.source_params), EXPORT_NODES)
        source_ids = [r["id"] for r in sources]
        role_names = [r["job_role"] for r in take(
            "SELECT DISTINCT m.job_role FROM role_topic_maps m WHERE m.tenant_id = %s AND m.topic_id = ANY(%s::uuid[]) ORDER BY 1",
            (t, topic_ids), EXPORT_NODES)]
        nodes: list[Node] = [node("item", r["id"], r["title"], r["status"]) for r in items]
        nodes += [node("topic", r["id"], r["name"]) for r in topics]
        nodes += [node("source", r["id"], r["title"]) for r in sources]
        nodes += [node("job_role", name, name) for name in role_names]

        edges: list[Edge] = []

        def add(kind: str, sql: str, params: tuple[Any, ...]) -> None:
            for r in take(sql, params, max(0, EXPORT_EDGES - len(edges))):
                edges.append(edge(kind, r["a"], r["b"], r.get("origin")))

        add("item_topic",
            """SELECT kt.item_id::text AS a, kt.topic_id::text AS b, kt.link_source AS origin FROM knowledge_item_topics kt
                WHERE kt.tenant_id = %s AND kt.item_id = ANY(%s::uuid[]) AND kt.topic_id = ANY(%s::uuid[]) ORDER BY 1, 2""",
            (t, item_ids, topic_ids))
        add("item_source",
            f"""SELECT DISTINCT i.id::text AS a, s.id::text AS b FROM knowledge_items i
                  JOIN citations ci ON ci.tenant_id = i.tenant_id AND {CITES_ITEM_VERSION} AND ci.subject_id = i.current_version_id
                  {CITED_PASSAGE_AND_DOCUMENT}
                 WHERE i.tenant_id = %s AND i.id = ANY(%s::uuid[]) AND s.id = ANY(%s::uuid[]) ORDER BY 1, 2""",
            (t, item_ids, source_ids))
        add("job_role_topic",
            """SELECT m.job_role AS a, m.topic_id::text AS b FROM role_topic_maps m
                WHERE m.tenant_id = %s AND m.topic_id = ANY(%s::uuid[]) AND m.job_role = ANY(%s::text[]) ORDER BY 1, 2""",
            (t, topic_ids, role_names))
        add("item_conflict",
            """SELECT k.item_id::text AS a, k.other_item_id::text AS b FROM knowledge_item_conflicts k
                WHERE k.tenant_id = %s AND k.item_id = ANY(%s::uuid[]) AND k.other_item_id = ANY(%s::uuid[]) AND k.item_id < k.other_item_id
                ORDER BY 1, 2""", (t, item_ids, item_ids))
        # taking the whole map out is recorded: who, when, and how much - never what
        write_audit(cur, tenant_id=t, card_id=ctx.card_id, action="knowledge:graph_export", reason_code="GRAPH_EXPORTED",
                    resource_type="knowledge_graph", request_id=ctx.request_id, details={"count": len(nodes), "rows": len(edges)})
    return {"schema": SCHEMA, "nodes": nodes, "edges": edges, "truncated": truncated,
            "limits": {"nodes_per_kind": EXPORT_NODES, "edges": EXPORT_EDGES}}
