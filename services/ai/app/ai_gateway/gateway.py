"""The gateway: the only way any part of the service uses an AI model (docs/phase2/04).

Order of checks for every attempt: kill switch -> charge stale reservations -> hourly limit ->
input size -> reserve worst case (company, then global) -> call -> settle. One ledger row per
attempt, including refused ones. At most one retry, and the retry must reserve again.
"""

from __future__ import annotations

import json
import math
import re
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, ValidationError

from app.ai_gateway import budget
from app.ai_gateway.outputs import OUTPUT_MODELS
from app.ai_gateway.prompts import Prompt, latest
from app.ai_gateway.providers import ChatProvider
from app.ai_gateway.types import (
    Caller,
    DataBlock,
    Feature,
    GenerateOutcome,
    GenerateRequest,
    ProviderError,
    ProviderTimeout,
    RefusalReason,
)
from app.platform import Database, Logger, one

PRICES_FILE = Path(__file__).resolve().parent / "prices.yaml"

# Output caps per feature (docs/phase2/04); the caller's plan cap applies if lower.
FEATURE_OUTPUT_TOKENS: dict[str, int] = {
    "answer": 600, "interview_question": 200, "item_extract": 400, "topic_extract": 400, "quiz_generate": 500,
    "quiz_grade": 300, "eval_judge": 300,
}
FEATURE_INPUT_TOKENS: dict[str, int] = {
    "answer": 4000, "interview_question": 1500, "item_extract": 1500, "topic_extract": 4000, "quiz_generate": 1500,
    "quiz_grade": 1500, "eval_judge": 2000,
}
MAX_ATTEMPTS = 2

_URL = re.compile(r"(?i)\b(?:https?://|www\.)\S+|!\[[^\]]*\]\([^)]*\)|\[([^\]]*)\]\([^)]*\)")


def load_prices(path: Path = PRICES_FILE) -> dict[str, budget.Prices]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    out: dict[str, budget.Prices] = {}
    for model, entry in data["models"].items():
        if not entry.get("source") or not entry.get("read"):
            raise ValueError(f"price for {model} has no source or date")
        out[model] = budget.Prices(int(entry["input_micro_per_mtok"]), int(entry["output_micro_per_mtok"]))
    return out


def estimate_input_tokens(prompt: Prompt, blocks: tuple[DataBlock, ...]) -> int:
    """Deliberately high: characters / 2.5 (English averages about 4 characters per token)."""
    chars = len(prompt.text) + sum(len(b.label) + len(b.text) + 24 for b in blocks)
    return math.ceil(chars / 2.5)


def strip_links(value: Any) -> Any:
    """No URLs, links or images in anything a model returns (a browser must not fetch them)."""
    if isinstance(value, str):
        return _URL.sub(lambda m: m.group(1) or "", value)
    if isinstance(value, list):
        return [strip_links(v) for v in value]
    if isinstance(value, dict):
        return {k: strip_links(v) for k, v in value.items()}
    return value


class Gateway:
    def __init__(self, db: Database, provider: ChatProvider, prompts: dict[tuple[str, int], Prompt],
                 prices: dict[str, budget.Prices], logger: Logger, env_kill_switch: bool = False,
                 clock: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        if provider.model not in prices:
            raise ValueError(f"no price for model {provider.model}: it cannot be called")
        self.db = db
        self.provider = provider
        self.prompts = prompts
        self.prices = prices[provider.model]
        self.log = logger
        self.env_kill_switch = env_kill_switch
        self.clock = clock

    def generate(self, caller: Caller, feature: Feature, prompt_id: str, blocks: list[DataBlock]) -> GenerateOutcome:
        prompt = latest(self.prompts, prompt_id)
        output_model = OUTPUT_MODELS[prompt.schema]
        max_out = min(caller.max_output_tokens, FEATURE_OUTPUT_TOKENS[feature])
        max_in = min(caller.max_input_tokens, FEATURE_INPUT_TOKENS[feature])
        req = GenerateRequest(feature=feature, prompt_id=prompt.id, prompt_version=prompt.version, system=prompt.text,
                              data_blocks=tuple(blocks), output_model=output_model, max_output_tokens=max_out)
        worst = budget.cost_micro(max_in, self.prices.input_micro_per_mtok) + budget.cost_micro(max_out, self.prices.output_micro_per_mtok)
        outcome = GenerateOutcome(model=self.provider.model)
        for attempt in range(1, MAX_ATTEMPTS + 1):
            refused, ledger_id, reserved_at = self._reserve(caller, req, attempt, worst, max_in)
            if refused is not None:
                outcome.refused = refused
                if ledger_id:
                    outcome.ledger_ids.append(ledger_id)
                return outcome
            if ledger_id is None or reserved_at is None:   # cannot happen: a reservation that was not refused has both
                raise RuntimeError("reservation returned no ledger row")
            outcome.ledger_ids.append(ledger_id)
            parsed, charged, status, retry, used = self._call(req, output_model, worst)
            self._settle(caller, ledger_id, worst, charged, status, used, reserved_at)
            outcome.cost_micro_usd += charged
            if parsed is not None:
                outcome.parsed = parsed
                return outcome
            if not retry:
                break
        outcome.failed = True
        return outcome

    # --------------------------------------------------------------- internals
    def _ledger_row(self, cur: Any, caller: Caller, req: GenerateRequest, attempt: int, status: str, reserved: int) -> str:
        cur.execute(
            """INSERT INTO ai_usage_ledger (tenant_id, card_id, feature, provider, model, prompt_version, attempt, status,
                   reserved_micro_usd, price_input_micro_per_mtok, price_output_micro_per_mtok, request_id, settled_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, CASE WHEN %s = 'reserved' THEN NULL ELSE now() END)
               RETURNING id""",
            (caller.tenant_id, caller.card_id, req.feature, self.provider.name, self.provider.model, f"{req.prompt_id}@v{req.prompt_version}",
             attempt, status, reserved, self.prices.input_micro_per_mtok, self.prices.output_micro_per_mtok, caller.request_id, status))
        row = cur.fetchone()
        return str(row["id"])

    def _reserve(self, caller: Caller, req: GenerateRequest, attempt: int, worst: int, max_in: int
                 ) -> tuple[RefusalReason | None, str | None, datetime | None]:
        now = self.clock()
        with self.db.tenant_tx(caller.tenant_id) as cur:
            if self.env_kill_switch or budget.kill_switch_on(cur):
                return "kill_switch", self._ledger_row(cur, caller, req, attempt, "refused_kill_switch", 0), None
            budget.expire_stale(cur, caller.tenant_id, now)
            if budget.calls_last_hour(cur, caller.tenant_id, now) >= caller.calls_per_hour:
                return "rate", self._ledger_row(cur, caller, req, attempt, "refused_rate", 0), None
            if estimate_input_tokens(latest(self.prompts, req.prompt_id), req.data_blocks) > max_in:
                return "limits", self._ledger_row(cur, caller, req, attempt, "refused_limits", 0), None
            no_room = budget.reserve(cur, caller.tenant_id, worst, caller.monthly_cap_micro_usd, now)
            if no_room == "budget":
                return "budget", self._ledger_row(cur, caller, req, attempt, "refused_budget", 0), None
            if no_room == "global":
                return "global", self._ledger_row(cur, caller, req, attempt, "refused_global", 0), None
            ledger_id = self._ledger_row(cur, caller, req, attempt, "reserved", worst)
            cur.execute("SELECT created_at FROM ai_usage_ledger WHERE id = %s", (ledger_id,))
            created = one(cur)["created_at"]
        return None, ledger_id, created

    def _call(self, req: GenerateRequest, output_model: type[BaseModel], worst: int
              ) -> tuple[BaseModel | None, int, str, bool, tuple[int, int]]:
        """Returns (parsed or None, amount to charge, ledger status, may retry, (input, output) tokens)."""
        started = time.monotonic()
        try:
            result = self.provider.generate(req)
        except ProviderTimeout:
            return None, worst, "failed_charged", True, (0, 0)
        except ProviderError as exc:
            if exc.usage_reported:
                charged = self._price(exc.input_tokens, exc.output_tokens)
                return None, charged, "failed_charged", exc.retryable, (exc.input_tokens, exc.output_tokens)
            if exc.before_processing:
                return None, 0, "failed_free", exc.retryable, (0, 0)
            return None, worst, "failed_charged", exc.retryable, (0, 0)
        finally:
            self._last_latency_ms = int((time.monotonic() - started) * 1000)
        charged = self._price(result.input_tokens, result.output_tokens)
        try:
            data = json.loads(result.raw_json)
            parsed = output_model.model_validate(strip_links(data))
        except (json.JSONDecodeError, ValidationError):
            # The provider produced something and billed it; it is not passed on.
            return None, charged, "failed_charged", True, (result.input_tokens, result.output_tokens)
        return parsed, charged, "settled", False, (result.input_tokens, result.output_tokens)

    def _price(self, input_tokens: int, output_tokens: int) -> int:
        return budget.cost_micro(input_tokens, self.prices.input_micro_per_mtok) + budget.cost_micro(
            output_tokens, self.prices.output_micro_per_mtok)

    def _settle(self, caller: Caller, ledger_id: str, reserved: int, charged: int, status: str, used: tuple[int, int],
                reserved_at: datetime) -> None:
        if charged > reserved:
            self.log.warn("ai_over_reservation", tenant_id=caller.tenant_id, ledger_id=ledger_id, reserved=reserved, charged=charged)
        with self.db.tenant_tx(caller.tenant_id) as cur:
            cur.execute(
                """UPDATE ai_usage_ledger SET status = %s, cost_micro_usd = %s, input_tokens = %s, output_tokens = %s,
                          latency_ms = %s, settled_at = now()
                    WHERE id = %s AND status = 'reserved' RETURNING 1""",
                (status, charged, used[0], used[1], getattr(self, "_last_latency_ms", None), ledger_id))
            if cur.fetchone() is None:
                return  # already expired (and charged in full) by a later request
            budget.settle(cur, caller.tenant_id, reserved, charged, reserved_at)
