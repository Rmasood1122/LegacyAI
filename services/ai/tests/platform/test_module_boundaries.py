"""Module boundaries inside the Python service (docs/phase2/01). Checked from the source code:

- platform imports nothing from the other modules;
- ai_gateway imports only platform;
- capture imports platform and ai_gateway, never knowledge;
- knowledge imports platform, ai_gateway and capture;
- between modules, only the package itself is imported (`from app.capture import x`), never a file inside it;
- only ai_gateway may load a provider SDK, an HTTP client or the embedding library.

The last test breaks the rules on purpose to prove the checker notices.
"""

from __future__ import annotations

import ast
from pathlib import Path

APP = Path(__file__).resolve().parents[2] / "app"
ALLOWED = {
    "platform": {"platform"},
    "ai_gateway": {"platform", "ai_gateway"},
    "capture": {"platform", "ai_gateway", "capture"},
    "knowledge": {"platform", "ai_gateway", "capture", "knowledge"},
}
GATEWAY_ONLY = {"anthropic", "openai", "httpx", "requests", "urllib3", "aiohttp", "fastembed", "onnxruntime"}


def violations(module: str, filename: str, source: str) -> list[str]:
    found = []
    for node in ast.walk(ast.parse(source)):
        names: list[str] = []
        if isinstance(node, ast.Import):
            names = [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            names = [node.module]
        for name in names:
            top = name.split(".")[0]
            if top in GATEWAY_ONLY and module != "ai_gateway":
                found.append(f"{filename}: {name} may be used only in app/ai_gateway")
            if top != "app":
                continue
            parts = name.split(".")
            if len(parts) < 2:
                continue
            target = parts[1]
            if target not in ALLOWED.get(module, set()):
                found.append(f"{filename}: {module} must not import {target}")
            elif target != module and len(parts) > 2:
                found.append(f"{filename}: import {name} reaches inside {target}; import from app.{target}")
    return found


def test_the_service_keeps_its_module_boundaries() -> None:
    problems: list[str] = []
    checked = 0
    for module in ALLOWED:
        for path in (APP / module).rglob("*.py"):
            checked += 1
            problems += violations(module, str(path.relative_to(APP)), path.read_text(encoding="utf-8"))
    assert checked >= 20, "the checker found too few files - it is looking in the wrong place"
    assert problems == []


def test_the_checker_catches_broken_rules() -> None:
    assert violations("capture", "x.py", "from app.knowledge import answers") != []
    assert violations("knowledge", "x.py", "from app.capture.filters import condition") != []
    assert violations("platform", "x.py", "import app.ai_gateway") != []
    assert violations("capture", "x.py", "import httpx") != []
    assert violations("knowledge", "x.py", "from anthropic import Anthropic") != []
    assert violations("knowledge", "x.py", "from app.capture import redact") == []
