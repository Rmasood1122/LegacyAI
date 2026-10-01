from fastapi.testclient import TestClient

from app.main import SERVICE_VERSION, app

client = TestClient(app)


def test_health_returns_ok() -> None:
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "service": "legacyai-ai", "version": SERVICE_VERSION}


def test_only_health_exists() -> None:
    """The stub must expose nothing else - no docs, no schema, no AI endpoints."""
    paths = sorted(route.path for route in app.routes)
    assert paths == ["/health"]
    for path in ["/", "/docs", "/redoc", "/openapi.json", "/v1/ask"]:
        assert client.get(path).status_code == 404
