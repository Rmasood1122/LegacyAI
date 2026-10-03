"""The HTTP surface: /health is open; everything else needs a service token for that exact operation
and record; there are no docs or schema pages."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi.testclient import TestClient

from app.ai_gateway import FakeEmbedder, FakeProvider
from app.main import SERVICE_VERSION, Services, create_app
from app.platform import Logger
from tests.conftest import make_settings, mint


class NoDatabase:
    """Stands in for the database in tests that must be refused before any query."""

    def __getattr__(self, name: str) -> Any:
        raise AssertionError(f"the database was used ({name}) by a request that should have been refused")


def client() -> TestClient:
    services = Services(make_settings(), NoDatabase(), FakeProvider(), FakeEmbedder(), Logger("error"))  # type: ignore[arg-type]
    return TestClient(create_app(services))


def test_health_returns_ok() -> None:
    res = client().get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "service": "legacyai-ai", "version": SERVICE_VERSION}


def test_no_docs_or_schema_pages() -> None:
    c = client()
    for path in ["/", "/docs", "/redoc", "/openapi.json", "/v1/ask"]:
        assert c.get(path).status_code == 404


def test_every_internal_route_needs_a_token() -> None:
    c = client()
    app = c.app
    routes = [r for r in app.routes if getattr(r, "path", "").startswith("/internal/")]  # type: ignore[attr-defined]
    assert len(routes) >= 30
    some_id = str(uuid.uuid4())
    for r in routes:
        path = r.path.replace("{kind}", "source")
        for name in ("source_id", "item_id", "interview_id", "topic_id", "question_id", "attempt_id", "answer_id", "consent_id",
                     "target_id"):
            path = path.replace("{" + name + "}", some_id)
        method = sorted(r.methods)[0]
        res = c.request(method, path, json={})
        assert res.status_code == 401, (method, path, res.status_code)
        assert res.json() == {"error": "unauthorized"}


def test_a_token_for_another_operation_or_record_is_refused() -> None:
    c = client()
    t, card, person, item = (str(uuid.uuid4()) for _ in range(4))
    wrong_action = mint("item.reject", tenant_id=t, card_id=card, person_id=person, subject=item)
    assert c.post(f"/internal/items/{item}/verify", headers={"Authorization": f"Bearer {wrong_action}"}).status_code == 401
    other_record = mint("item.verify", tenant_id=t, card_id=card, person_id=person, subject=str(uuid.uuid4()))
    assert c.post(f"/internal/items/{item}/verify", headers={"Authorization": f"Bearer {other_record}"}).status_code == 401
    no_record = mint("item.verify", tenant_id=t, card_id=card, person_id=person)
    assert c.post(f"/internal/items/{item}/verify", headers={"Authorization": f"Bearer {no_record}"}).status_code == 401


def test_without_configuration_the_service_refuses_work_but_stays_alive(monkeypatch: Any) -> None:
    for name in ("DATABASE_URL", "SERVICE_TOKEN_KEY", "AI_SERVICE_CONFIG"):
        monkeypatch.delenv(name, raising=False)
    c = TestClient(create_app())
    assert c.get("/health").status_code == 200
    res = c.post("/internal/housekeeping", headers={"Authorization": "Bearer x"})
    assert res.status_code == 503 and res.json() == {"error": "not_configured"}
