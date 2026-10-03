"""Prompts live in versioned files: app/prompts/<feature>/v<N>.md, each with a header.

    ---
    id: answer
    version: 1
    feature: answer
    schema: AnswerOutput
    ---
    <instructions>

A change is a new file; old versions stay so every ledger row can be traced to its wording.
Prompt files hold instructions only. Untrusted text is passed separately as data blocks, so a
prompt file must not contain a slot for it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from app.ai_gateway.outputs import OUTPUT_MODELS

PROMPTS_DIR = Path(__file__).resolve().parent.parent / "prompts"
_HEADER = re.compile(r"\A---\n(?P<head>.*?)\n---\n(?P<body>.*)\Z", re.S)
_FORBIDDEN_SLOT = re.compile(r"\{[a-z_]+\}|\{\{|\$\{")


class PromptError(Exception):
    pass


@dataclass(frozen=True)
class Prompt:
    id: str
    version: int
    feature: str
    schema: str
    text: str


def _parse(path: Path) -> Prompt:
    raw = path.read_text(encoding="utf-8").replace("\r\n", "\n")
    m = _HEADER.match(raw)
    if not m:
        raise PromptError(f"{path.name}: missing header")
    head: dict[str, str] = {}
    for line in m.group("head").splitlines():
        key, _, value = line.partition(":")
        head[key.strip()] = value.strip()
    missing = {"id", "version", "feature", "schema"} - head.keys()
    if missing:
        raise PromptError(f"{path}: header lacks {sorted(missing)}")
    if head["schema"] not in OUTPUT_MODELS:
        raise PromptError(f"{path}: unknown output schema {head['schema']}")
    if f"v{head['version']}.md" != path.name or head["feature"] != path.parent.name:
        raise PromptError(f"{path}: file name and header disagree")
    body = m.group("body").strip()
    if _FORBIDDEN_SLOT.search(body):
        raise PromptError(f"{path}: a prompt must not contain a template slot for untrusted text")
    return Prompt(id=head["id"], version=int(head["version"]), feature=head["feature"], schema=head["schema"], text=body)


def load_prompts(directory: Path = PROMPTS_DIR) -> dict[tuple[str, int], Prompt]:
    prompts: dict[tuple[str, int], Prompt] = {}
    for path in sorted(directory.glob("*/v*.md")):
        p = _parse(path)
        if (p.id, p.version) in prompts:
            raise PromptError(f"duplicate prompt {p.id} v{p.version}")
        prompts[(p.id, p.version)] = p
    return prompts


def latest(prompts: dict[tuple[str, int], Prompt], prompt_id: str) -> Prompt:
    versions = [p for (pid, _), p in prompts.items() if pid == prompt_id]
    if not versions:
        raise PromptError(f"no prompt named {prompt_id}")
    return max(versions, key=lambda p: p.version)
