"""Sealing scenario texts (decision D41, step 6 part 3b). Every place that writes or reads a scenario's title and
situation, a step's question and expected points, or a learner's answer and its grading goes through here.

- scenarios: title and situation, each sealed, bound to "scenario:<id>", one key per row (erasure empties the
  situation and keeps the title, so they are separate values).
- scenario_steps: the question ("prompt") and the expected points ("rubric", a JSON list), each sealed, bound to
  "scenario_step:<id>", one key per row. Separate values: what a learner is shown never needs the points opened.
- scenario_answers: the learner's words ("answer") and the grading result ("rubric_result"), bound to
  "scenario_answer:<id>", one key per row.
Without content keys everything is written readable, as before; reading accepts both forms.
"""

from __future__ import annotations

import json
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from app.capture import Fields


def scenario_columns(alias: str) -> str:
    """Title and situation of scenarios (alias `alias`), for open_scenario()."""
    return (f"{alias}.title, {alias}.situation, {alias}.title_sealed, {alias}.situation_sealed, "
            f"{alias}.sealed_key AS scenario_key")


def scenario_title_columns(alias: str) -> str:
    """The title only, for open_scenario()."""
    return f"{alias}.title, {alias}.title_sealed, {alias}.sealed_key AS scenario_key"


def seal_scenario(cur: psycopg.Cursor[Any], tenant_id: str, scenario_id: str, title: str, situation: str) -> dict[str, Any]:
    """The values for title, situation, title_sealed, situation_sealed and sealed_key."""
    fields = Fields(cur, tenant_id, "scenarios")
    key = f"scenario:{scenario_id}"
    title_readable, title_sealed, key_id = fields.seal(key, "title", title)
    situation_readable, situation_sealed, _ = fields.seal(key, "situation", situation, key_id=key_id)
    return {"title": title_readable, "situation": situation_readable, "title_sealed": title_sealed, "situation_sealed": situation_sealed,
            "sealed_key": key_id}


def open_scenario(fields: Fields, row: dict[str, Any], id_column: str = "id") -> dict[str, Any]:
    """Replaces the sealed columns of `row` (as selected above) by the opened title and situation. `fields`: scenarios."""
    key, key_id = f"scenario:{row[id_column]}", row.pop("scenario_key")
    row["title"] = fields.open(key, "title", row.get("title"), row.pop("title_sealed"), key_id)
    if "situation_sealed" in row:
        row["situation"] = fields.open(key, "situation", row.get("situation"), row.pop("situation_sealed"), key_id)
    return row


def step_columns(alias: str, *, with_rubric: bool = True) -> str:
    """A step's question (and, unless `with_rubric` is False, its expected points) for open_step(); the step id must be
    selected as step_id. A learner's projection selects the question only."""
    rubric = f", {alias}.rubric, {alias}.rubric_sealed" if with_rubric else ""
    return f"{alias}.prompt, {alias}.prompt_sealed{rubric}, {alias}.sealed_key AS step_key"


def seal_step(cur: psycopg.Cursor[Any], tenant_id: str, step_id: str, prompt: str, rubric: list[str]) -> dict[str, Any]:
    """The values for prompt, rubric, prompt_sealed, rubric_sealed and sealed_key."""
    fields = Fields(cur, tenant_id, "scenario_steps")
    key = f"scenario_step:{step_id}"
    prompt_readable, prompt_sealed, key_id = fields.seal(key, "prompt", prompt)
    _, rubric_sealed, _ = fields.seal(key, "rubric", json.dumps(rubric), key_id=key_id)
    if prompt_sealed is None:
        return {"prompt": prompt_readable, "rubric": Jsonb(rubric), "prompt_sealed": None, "rubric_sealed": None, "sealed_key": None}
    return {"prompt": None, "rubric": None, "prompt_sealed": prompt_sealed, "rubric_sealed": rubric_sealed, "sealed_key": key_id}


def open_step(fields: Fields, row: dict[str, Any], id_column: str = "step_id") -> dict[str, Any]:
    """Replaces the sealed columns of `row` by the opened prompt (and rubric, when selected). `fields`: scenario_steps."""
    key, key_id = f"scenario_step:{row[id_column]}", row.pop("step_key")
    row["prompt"] = fields.open(key, "prompt", row.get("prompt"), row.pop("prompt_sealed"), key_id)
    if "rubric_sealed" in row:
        sealed = row.pop("rubric_sealed")
        if sealed is not None:
            row["rubric"] = json.loads(fields.open(key, "rubric", None, sealed, key_id) or "[]")
    return row


def answer_columns(alias: str) -> str:
    """A learner's answer and its grading (alias `alias`), for open_answer()."""
    return (f"{alias}.answer_text, {alias}.answer_sealed, {alias}.ai_rubric_result, {alias}.rubric_result_sealed, "
            f"{alias}.sealed_key AS answer_key")


def seal_answer_text(cur: psycopg.Cursor[Any], tenant_id: str, answer_id: str, text: str | None) -> dict[str, Any]:
    """The values for answer_text, answer_sealed and sealed_key (an empty answer stores nothing)."""
    if not text:
        return {"answer_text": None, "answer_sealed": None, "sealed_key": None}
    readable, sealed, key_id = Fields(cur, tenant_id, "scenario_answers").seal(f"scenario_answer:{answer_id}", "answer", text)
    return {"answer_text": readable, "answer_sealed": sealed, "sealed_key": key_id}


def seal_rubric_result(cur: psycopg.Cursor[Any], tenant_id: str, answer_id: str, points: list[dict[str, Any]],
                       key_id: str | None) -> dict[str, Any]:
    """The values for ai_rubric_result, rubric_result_sealed and the key (the answer's own key when it has one)."""
    _, sealed, used = Fields(cur, tenant_id, "scenario_answers").seal(f"scenario_answer:{answer_id}", "rubric_result", json.dumps(points),
                                                                      key_id=key_id)
    if sealed is None:
        return {"ai_rubric_result": Jsonb(points), "rubric_result_sealed": None, "sealed_key": key_id}
    return {"ai_rubric_result": None, "rubric_result_sealed": sealed, "sealed_key": used}


def open_answer(fields: Fields, row: dict[str, Any], id_column: str) -> dict[str, Any]:
    """Replaces the sealed columns of `row` by the opened answer_text and ai_rubric_result. `fields`: scenario_answers."""
    key, key_id = f"scenario_answer:{row[id_column]}", row.pop("answer_key")
    row["answer_text"] = fields.open(key, "answer", row.get("answer_text"), row.pop("answer_sealed"), key_id)
    rubric_sealed = row.pop("rubric_result_sealed")
    if rubric_sealed is not None:
        row["ai_rubric_result"] = json.loads(fields.open(key, "rubric_result", None, rubric_sealed, key_id) or "null")
    return row
