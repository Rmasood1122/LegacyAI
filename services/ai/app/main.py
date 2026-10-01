"""LegacyAI AI service - Phase 1 STUB.

This service will hold backend Parts 2 and 3 (knowledge capture and AI retrieval) in a
later phase. Right now it contains NO AI logic, makes NO model calls and stores nothing.
It exists so the container, the deployment slot and the health check are in place.

When Phase 2 arrives, every retrieval must first ask the API's policy decision point
(POST /v1/internal/policy/check, and the resource filter) what the caller may see.
"""

from fastapi import FastAPI

SERVICE_VERSION = "0.1.0"

# Interactive docs are switched off: this service is internal-only.
app = FastAPI(title="LegacyAI AI service (stub)", version=SERVICE_VERSION, docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
def health() -> dict[str, str]:
    """Liveness probe. Touches nothing."""
    return {"status": "ok", "service": "legacyai-ai", "version": SERVICE_VERSION}
