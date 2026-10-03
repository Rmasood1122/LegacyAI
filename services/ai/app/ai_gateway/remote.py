"""The real chat providers (used only after Gate 2, with a key the owner created with a hard spending limit).

Plain HTTPS with the standard library - no provider SDK, so no extra dependency. Facts used here were
read from the providers' documentation on 2026-10-03 (docs/DEPENDENCIES.md §9.3-9.4):

- Anthropic Messages API: POST https://api.anthropic.com/v1/messages, headers x-api-key and
  anthropic-version: 2023-06-01; structured output via output_config.format = {type: json_schema, schema};
  the schema may not use length or number limits, and objects need additionalProperties: false.
  Response text in content[].text, usage in usage.input_tokens / usage.output_tokens.
- OpenAI Chat Completions: POST https://api.openai.com/v1/chat/completions, Bearer key; strict structured
  output via response_format = {type: json_schema, json_schema: {name, schema, strict: true}} (every
  property required, additionalProperties false, no length or number limits); max_completion_tokens bounds
  visible AND reasoning tokens; usage in usage.prompt_tokens / usage.completion_tokens.

The limits removed from the schema are still enforced: the gateway validates every answer against the
full pydantic model before anything uses it.
"""

from __future__ import annotations

import json
import socket
import urllib.error
import urllib.request
from typing import Any

from app.ai_gateway.types import DataBlock, GenerateRequest, ProviderError, ProviderResult, ProviderTimeout

REQUEST_TIMEOUT_SECONDS = 30
_UNSUPPORTED = {"minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "pattern", "maxItems",
                "default", "title", "multipleOf"}


def render_blocks(blocks: tuple[DataBlock, ...]) -> str:
    """Untrusted text, each piece in its own labelled block. A block cannot be closed from inside."""
    parts = []
    for b in blocks:
        text = b.text.replace("</data", "</ data")
        parts.append(f'<data label="{b.label}">\n{text}\n</data>')
    return "\n\n".join(parts)


def strict_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """A pydantic JSON schema made acceptable to both providers' structured-output modes."""
    def walk(node: Any) -> Any:
        if isinstance(node, list):
            return [walk(n) for n in node]
        if not isinstance(node, dict):
            return node
        out = {k: walk(v) for k, v in node.items() if k not in _UNSUPPORTED and not (k == "minItems" and v not in (0, 1))}
        if out.get("type") == "object" or "properties" in out:
            out["additionalProperties"] = False
            out["required"] = sorted(out.get("properties", {}).keys())
        return out
    result: dict[str, Any] = walk(schema)
    return result


def _post(url: str, headers: dict[str, str], body: dict[str, Any]) -> dict[str, Any]:
    if not url.startswith("https://"):
        raise ValueError("providers are called over https only")
    request = urllib.request.Request(  # noqa: S310 - https only (checked above), fixed provider URLs
        url, data=json.dumps(body).encode(), headers={**headers, "content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as res:  # noqa: S310 - fixed https URLs only
            parsed: dict[str, Any] = json.loads(res.read().decode())
            return parsed
    except urllib.error.HTTPError as exc:
        status = exc.code
        # 400/401/403/404/413/422: the request was refused before any work - not billed, not worth retrying.
        refused_early = status in (400, 401, 403, 404, 413, 422)
        raise ProviderError(f"provider answered {status}", retryable=status in (408, 409, 429) or status >= 500,
                            before_processing=refused_early) from None
    except TimeoutError as exc:
        raise ProviderTimeout("provider timed out") from exc
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, (TimeoutError, socket.timeout)):
            raise ProviderTimeout("provider timed out") from exc
        raise ProviderError("provider unreachable", retryable=True, before_processing=True) from None


class AnthropicProvider:
    name = "anthropic"
    URL = "https://api.anthropic.com/v1/messages"

    def __init__(self, key: str, model: str) -> None:
        self._key = key
        self.model = model

    def generate(self, req: GenerateRequest) -> ProviderResult:
        body = {
            "model": self.model, "max_tokens": req.max_output_tokens, "system": req.system,
            "messages": [{"role": "user", "content": render_blocks(req.data_blocks)}],
            "output_config": {"format": {"type": "json_schema", "schema": strict_schema(req.output_model.model_json_schema())}},
        }
        data = _post(self.URL, {"x-api-key": self._key, "anthropic-version": "2023-06-01"}, body)
        usage = data.get("usage") or {}
        text = "".join(c.get("text", "") for c in data.get("content", []) if c.get("type") == "text")
        return ProviderResult(raw_json=text, input_tokens=int(usage.get("input_tokens", 0)), output_tokens=int(usage.get("output_tokens", 0)),
                              usage_reported="input_tokens" in usage)


class OpenAIProvider:
    name = "openai"
    URL = "https://api.openai.com/v1/chat/completions"

    def __init__(self, key: str, model: str, reasoning_effort: str | None = "low") -> None:
        self._key = key
        self.model = model
        self.reasoning_effort = reasoning_effort

    def generate(self, req: GenerateRequest) -> ProviderResult:
        body: dict[str, Any] = {
            "model": self.model,
            # bounds visible AND hidden reasoning tokens, so the gateway's reserved worst case stays the worst case
            "max_completion_tokens": req.max_output_tokens,
            "messages": [{"role": "system", "content": req.system}, {"role": "user", "content": render_blocks(req.data_blocks)}],
            "response_format": {"type": "json_schema", "json_schema": {
                "name": req.output_model.__name__, "schema": strict_schema(req.output_model.model_json_schema()), "strict": True}},
        }
        if self.reasoning_effort:
            body["reasoning_effort"] = self.reasoning_effort
        data = _post(self.URL, {"authorization": f"Bearer {self._key}"}, body)
        usage = data.get("usage") or {}
        choices = data.get("choices") or [{}]
        text = (choices[0].get("message") or {}).get("content") or ""
        return ProviderResult(raw_json=text, input_tokens=int(usage.get("prompt_tokens", 0)),
                              output_tokens=int(usage.get("completion_tokens", 0)), usage_reported="prompt_tokens" in usage)
