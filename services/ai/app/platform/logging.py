"""Structured JSON logs. Log lines carry ids, counts and codes - never document text,
questions, answers or secrets. `log()` refuses keys that suggest content.
"""

from __future__ import annotations

import json
import sys
import time
from typing import Any, TextIO

_FORBIDDEN_KEYS = {"text", "body", "question", "answer", "prompt", "content", "title", "sc", "token", "key", "password"}
_LEVELS = {"debug": 10, "info": 20, "warn": 30, "error": 40}


class Logger:
    def __init__(self, level: str = "info", stream: TextIO | None = None) -> None:
        self._min = _LEVELS.get(level, 20)
        self._stream = stream or sys.stdout

    def log(self, level: str, msg: str, **fields: Any) -> None:
        if _LEVELS.get(level, 20) < self._min:
            return
        bad = _FORBIDDEN_KEYS.intersection(fields)
        if bad:
            raise ValueError(f"log fields must not carry content: {sorted(bad)}")
        record = {"level": level, "time": round(time.time(), 3), "msg": msg, **fields}
        self._stream.write(json.dumps(record, default=str, separators=(",", ":")) + "\n")
        self._stream.flush()

    def info(self, msg: str, **fields: Any) -> None:
        self.log("info", msg, **fields)

    def warn(self, msg: str, **fields: Any) -> None:
        self.log("warn", msg, **fields)

    def error(self, msg: str, **fields: Any) -> None:
        self.log("error", msg, **fields)
