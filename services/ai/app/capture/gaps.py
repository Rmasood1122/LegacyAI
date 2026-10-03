"""Gap detector (feature 10, simple; docs/phase2/05 §5). Deterministic: no AI in the calculation.

For each topic of a job role, count the linked items the VIEWER may read, by status and by
contributor, and label the topic. The report is computed for whoever looks at it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import psycopg

from app.capture.filters import condition

THIN_BELOW = 2


@dataclass(frozen=True)
class TopicGap:
    topic_id: str
    name: str
    required: bool
    importance: int
    label: str          # uncovered | unverified | single_source | stale | thin | covered
    verified_items: int
    contributors: int

    def public(self) -> dict[str, Any]:
        return self.__dict__.copy()


_ORDER = {"uncovered": 0, "unverified": 1, "single_source": 2, "stale": 3, "thin": 4, "covered": 5}


def gap_report(cur: psycopg.Cursor[Any], *, tenant_id: str, job_role: str, item_spec: Any, topic_spec: Any) -> list[TopicGap]:
    item_where, item_params = condition(item_spec, "knowledge_items", tenant_id)
    topic_where, topic_params = condition(topic_spec, "topics", tenant_id)
    cur.execute(
        f"""SELECT tp.id::text AS topic_id, tp.name, m.required, m.importance,
                   count(i.id) FILTER (WHERE i.status IN ('verified', 'corrected') AND (i.stale_after IS NULL OR i.stale_after > now())) AS fresh,
                   count(i.id) FILTER (WHERE i.status = 'stale' OR (i.status IN ('verified', 'corrected') AND i.stale_after <= now())) AS stale,
                   count(i.id) FILTER (WHERE i.status IN ('candidate', 'in_review')) AS unverified,
                   count(DISTINCT i.owner_person_id) FILTER (WHERE i.status IN ('verified', 'corrected')) AS contributors
              FROM role_topic_maps m
              JOIN topics tp ON tp.tenant_id = m.tenant_id AND tp.id = m.topic_id AND tp.status = 'active' AND {topic_where}
              LEFT JOIN knowledge_item_topics kt ON kt.tenant_id = m.tenant_id AND kt.topic_id = m.topic_id
              LEFT JOIN knowledge_items i ON i.tenant_id = kt.tenant_id AND i.id = kt.item_id AND {item_where}
             WHERE m.tenant_id = %s AND m.job_role = %s
             GROUP BY tp.id, tp.name, m.required, m.importance""",
        [*topic_params, *item_params, tenant_id, job_role])
    out = []
    for r in cur.fetchall():
        fresh, stale, unverified, contributors = int(r["fresh"]), int(r["stale"]), int(r["unverified"]), int(r["contributors"])
        if fresh == 0 and stale == 0:
            label = "unverified" if unverified else "uncovered"
        elif fresh == 0:
            label = "stale"
        elif contributors <= 1:
            label = "single_source"
        elif fresh < THIN_BELOW:
            label = "thin"
        else:
            label = "covered"
        out.append(TopicGap(r["topic_id"], r["name"], bool(r["required"]), int(r["importance"]), label, fresh, contributors))
    out.sort(key=lambda g: (_ORDER[g.label], not g.required, -g.importance, g.name))
    return out
