"""LegacyAI AI service (Phase 2): capture, knowledge and the AI gateway, behind internal routes.

Only the TypeScript API calls this service (docs/phase2/01). Every route except /health needs a
service token minted by the API for THAT operation (and, where a route names a record, for THAT
record); a token is accepted once. The token carries the caller's identity, the structured access
filter and - for answers - the list of passages the API approved. Nothing here decides who may do
what: that is the API's policy decision point. This service applies the filter in its queries and
the database applies row-level security underneath.

The routes are plain `def` functions: FastAPI runs them in a thread pool, so slow work (parsing,
redaction, embedding) never blocks the event loop and /health keeps answering.
"""

# No `from __future__ import annotations` here: FastAPI must evaluate the route signatures, which
# refer to names local to create_app().
import time
import uuid
from collections.abc import Callable
from typing import Annotated, Any, Literal

from fastapi import Depends, FastAPI, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from app.ai_gateway import Caller, ChatProvider, Embedder, FakeProvider, Gateway, load_prices, load_prompts, make_embedder
from app.capture import ingest, interviews, topics, withdrawal
from app.capture.gaps import gap_report
from app.knowledge import answers, expert, items, readiness, reads
from app.platform import (
    ConfigError,
    Database,
    Logger,
    ReplayGuard,
    ServiceContext,
    Settings,
    TokenError,
    load_settings,
    token_id,
    verify_service_token,
    write_audit,
)
from app.platform import housekeeping as housekeeping_mod

SERVICE_VERSION = "0.2.0"
MAX_UPLOAD_BYTES = 10 * 1024 * 1024        # hard ceiling; the company setting is lower
REQUEST_DEADLINE_SECONDS = 50.0             # embedding stops here and continues on the next status request


class Body(BaseModel):
    model_config = ConfigDict(extra="forbid")


Uuid = Annotated[str, Field(pattern=r"^[0-9a-fA-F-]{36}$")]
Sensitivity = Annotated[int, Field(ge=0, le=3)]


class SourceCreate(Body):
    title: str = Field(max_length=500)
    department_id: Uuid | None = None
    sensitivity: Sensitivity = 1
    contributor_person_id: Uuid | None = None
    company_document: bool = False


class Question(Body):
    question: str = Field(min_length=1, max_length=2000)
    expert_person_id: Uuid | None = None


class ItemWrite(Body):
    title: str = Field(max_length=200)
    body: str = Field(min_length=1, max_length=2000)
    department_id: Uuid | None = None
    sensitivity: Sensitivity = 1
    contributor_person_id: Uuid | None = None


class VersionBody(Body):
    body: str = Field(min_length=1, max_length=2000)


class Reopen(Body):
    rollback_to_version: int | None = Field(default=None, ge=1)


class Labels(Body):
    department_id: Uuid | None = None
    sensitivity: Sensitivity


class Revert(Body):
    verifier_card_id: Uuid
    since: str = Field(max_length=40)
    until: str = Field(max_length=40)


class Invite(Body):
    expert_person_id: Uuid
    job_role: str = Field(min_length=1, max_length=120)


class Turn(Body):
    answer: str = Field(min_length=1, max_length=8000)


class InterviewStatus(Body):
    status: Literal["paused", "active", "completed"]
    by_expert: bool


class GapQuery(Body):
    job_role: str = Field(min_length=1, max_length=120)




class ExpertQuestion(Body):
    expert_person_id: Uuid
    question: str = Field(min_length=1, max_length=2000)
    department_id: Uuid | None = None
    sensitivity: Sensitivity = 1


class ExpertReply(Body):
    answer: str = Field(min_length=1, max_length=2000)
    title: str = Field(default="", max_length=200)


class Decline(Body):
    reason: Literal["not_my_area", "not_allowed_to_share", "unclear", "other"]


class QuizGenerate(Body):
    kind: Literal["mcq", "open"]


class QuizEdit(Body):
    stem: str = Field(min_length=1, max_length=2000)
    options: list[str] | None = Field(default=None, max_length=4)
    correct_option: int | None = Field(default=None, ge=0, le=3)
    rubric: list[str] | None = Field(default=None, max_length=6)


class QuizStatus(Body):
    status: Literal["approved", "retired"]


class AttemptStart(Body):
    job_role: str = Field(min_length=1, max_length=120)


class AnswerSave(Body):
    position: int = Field(ge=1, le=50)
    chosen_option: int | None = Field(default=None, ge=0, le=3)
    answer_text: str | None = Field(default=None, max_length=4000)


class Override(Body):
    score: float = Field(ge=0, le=1)


class ItemList(Body):
    status: Literal["candidate", "in_review", "verified", "corrected", "rejected", "stale"] | None = None
    owner_me: bool = False
    limit: int = Field(default=50, ge=1, le=50)
    after: Uuid | None = None


class Restrict(Body):
    sensitivity: Sensitivity


class QuizList(Body):
    status: Literal["draft", "approved", "retired"] | None = None
    limit: int = Field(default=50, ge=1, le=50)
    after: Uuid | None = None


class QuestionBox(Body):
    box: Literal["asked", "addressed", "all"]
    limit: int = Field(default=50, ge=1, le=50)


class Services:
    """What the routes need. Built once at start-up (or by a test)."""

    def __init__(self, settings: Settings, db: Database, provider: ChatProvider, embedder: Embedder, logger: Logger) -> None:
        self.settings = settings
        self.db = db
        self.embedder = embedder
        self.log = logger
        self.gateway = Gateway(db, provider, load_prompts(), load_prices(), logger, env_kill_switch=settings.ai_kill_switch)
        self.replay = ReplayGuard()


def build_provider(settings: Settings) -> ChatProvider:
    if settings.ai_provider == "fake":
        return FakeProvider()
    # The real providers are added at Gate 2, after the owner supplies a key with a hard spending limit.
    raise ConfigError(f"AI provider '{settings.ai_provider}' is not available in this build")


def caller_of(ctx: ServiceContext) -> Caller | None:
    """The token's limits make a caller; without them this request may not use AI at all."""
    need = ("max_input_tokens", "max_output_tokens", "calls_per_hour", "monthly_cap_micro_usd")
    if not all(k in ctx.limits for k in need):
        return None
    return Caller(tenant_id=ctx.tenant_id, card_id=ctx.card_id, request_id=ctx.request_id or str(uuid.uuid4()),
                  max_input_tokens=ctx.limits["max_input_tokens"], max_output_tokens=ctx.limits["max_output_tokens"],
                  calls_per_hour=ctx.limits["calls_per_hour"], monthly_cap_micro_usd=ctx.limits["monthly_cap_micro_usd"])


class Refused(Exception):
    def __init__(self, code: str, status: int) -> None:
        super().__init__(code)
        self.code = code
        self.status = status


def create_app(services: Services | None = None) -> FastAPI:
    app = FastAPI(title="LegacyAI AI service (internal)", version=SERVICE_VERSION, docs_url=None, redoc_url=None, openapi_url=None)
    state: dict[str, Services] = {}

    def svc() -> Services:
        if "s" not in state:
            if services is not None:
                state["s"] = services
            else:
                settings = load_settings()
                db = Database(settings.database_url.reveal(), settings.db_pool_max)
                db.assert_safe_role()
                state["s"] = Services(settings, db, build_provider(settings), make_embedder(settings.embedder),
                                      Logger(settings.log_level))
        return state["s"]

    def token(action: str, subject_param: str | None = None) -> Callable[..., ServiceContext]:
        def dep(request: Request, authorization: Annotated[str | None, Header()] = None) -> ServiceContext:
            s = svc()
            if not authorization or not authorization.startswith("Bearer "):
                raise TokenError("no bearer token")
            raw = authorization[7:]
            ctx = verify_service_token(raw, s.settings.service_token_key.reveal(), action)
            if subject_param is not None and (ctx.subject is None
                                              or ctx.subject != str(request.path_params.get(subject_param, "")).lower()):
                raise TokenError("token was issued for another record")
            jti, exp = token_id(raw)
            s.replay.check(jti, exp, time.time())
            return ctx
        # Read by app/contract.py: the internal contract names the token action (and record) of every route.
        dep.legacyai_action = action  # type: ignore[attr-defined]
        dep.legacyai_subject = subject_param  # type: ignore[attr-defined]
        return dep

    @app.exception_handler(TokenError)
    def _token_error(request: Request, exc: TokenError) -> JSONResponse:
        if "s" in state:
            state["s"].log.warn("service token refused", path=request.url.path, reason=str(exc))
        return JSONResponse({"error": "unauthorized"}, status_code=401)

    @app.exception_handler(ConfigError)
    def _config_error(request: Request, exc: ConfigError) -> JSONResponse:
        return JSONResponse({"error": "not_configured"}, status_code=503)   # fail closed; the reason is not echoed

    for cls in (ingest.CaptureRefused, items.ItemRefused, interviews.InterviewRefused, topics.TopicRefused, Refused):
        @app.exception_handler(cls)
        def _refused(request: Request, exc: Any) -> JSONResponse:
            return JSONResponse({"error": exc.code}, status_code=exc.status)

    @app.get("/health")
    def health() -> dict[str, str]:
        """Liveness probe. Touches nothing."""
        return {"status": "ok", "service": "legacyai-ai", "version": SERVICE_VERSION}

    def deadline() -> float:
        return time.monotonic() + REQUEST_DEADLINE_SECONDS

    # ------------------------------------------------------------------ documents (feature 25)
    @app.post("/internal/sources")
    def source_create(body: SourceCreate, ctx: Annotated[ServiceContext, Depends(token("source.create"))]) -> dict[str, Any]:
        s = svc()
        return ingest.create_source(s.db, ctx, title=body.title, department_id=body.department_id, sensitivity=body.sensitivity,
                                    contributor_person_id=body.contributor_person_id, company_document=body.company_document,
                                    storage_budget_bytes=s.settings.storage_budget_bytes)

    @app.post("/internal/sources/{source_id}/confirm")
    def source_confirm(source_id: str, ctx: Annotated[ServiceContext, Depends(token("source.confirm", "source_id"))]) -> dict[str, Any]:
        return ingest.confirm_source(svc().db, ctx, source_id)

    @app.put("/internal/sources/{source_id}/content")
    async def source_content(source_id: str, request: Request,
                             ctx: Annotated[ServiceContext, Depends(token("source.content", "source_id"))]) -> JSONResponse:
        length = int(request.headers.get("content-length", "0") or 0)
        if length > MAX_UPLOAD_BYTES:
            raise Refused("too_large", 413)
        data = bytearray()
        async for part in request.stream():
            data.extend(part)
            if len(data) > MAX_UPLOAD_BYTES:
                raise Refused("too_large", 413)
        mime = request.headers.get("content-type", "application/octet-stream").split(";")[0].strip()
        from starlette.concurrency import run_in_threadpool

        s = svc()
        result = await run_in_threadpool(ingest.process_upload, s.db, ctx, s.embedder, source_id, bytes(data), mime,
                                         s.settings.storage_budget_bytes, deadline())
        return JSONResponse(result)

    @app.post("/internal/sources/{source_id}/withdraw")
    def source_withdraw(source_id: str, ctx: Annotated[ServiceContext, Depends(token("source.withdraw", "source_id"))]) -> dict[str, Any]:
        with svc().db.tenant_tx(ctx.tenant_id) as cur:
            only, mixed = withdrawal.items_citing_source(cur, ctx.tenant_id, source_id)     # before the passages are deleted
            items.withdraw_items(cur, ctx.tenant_id, only, mixed)
            if not withdrawal.withdraw_source(cur, ctx.tenant_id, source_id):
                raise Refused("not_found", 404)
            write_audit(cur, tenant_id=ctx.tenant_id, card_id=ctx.card_id, action="capture:source_withdrawn", reason_code="SOURCE_WITHDRAWN",
                        resource_type="source", resource_id=source_id, request_id=ctx.request_id,
                        details={"source_id": source_id, "count": len(only), "rows": len(mixed)})
        return {"id": source_id, "status": "withdrawn", "items_withdrawn": len(only), "items_back_in_review": len(mixed)}

    @app.post("/internal/sources/{source_id}/continue")
    def source_continue(source_id: str, ctx: Annotated[ServiceContext, Depends(token("source.continue", "source_id"))]) -> dict[str, Any]:
        s = svc()
        return ingest.continue_embedding(s.db, ctx.tenant_id, ctx.card_id, source_id, s.embedder, deadline(), request_id=ctx.request_id)

    # ------------------------------------------------------------------ answers (features 14, 15, 17)
    @app.post("/internal/knowledge/candidates")
    def ask_candidates(body: Question, ctx: Annotated[ServiceContext, Depends(token("knowledge.candidates"))]) -> dict[str, Any]:
        s = svc()
        return {"candidates": answers.candidate_ids(s.db, ctx, s.embedder, body.question, body.expert_person_id)}

    @app.post("/internal/knowledge/answer")
    def ask_answer(body: Question, ctx: Annotated[ServiceContext, Depends(token("knowledge.answer"))]) -> dict[str, Any]:
        s = svc()
        caller = caller_of(ctx)
        unavailable = "grace" if ctx.card_phase == "grace" else None if caller is not None else "ai_unavailable"
        result = answers.answer(s.db, ctx, s.gateway, s.embedder, caller or _no_caller(ctx), body.question, body.expert_person_id,
                                unavailable)
        return result.public()

    # ------------------------------------------------------------------ knowledge items (feature 12)
    @app.post("/internal/items")
    def item_write(body: ItemWrite, ctx: Annotated[ServiceContext, Depends(token("item.write"))]) -> dict[str, Any]:
        item_id = items.write_manual(svc().db, ctx, title=body.title, body=body.body, department_id=body.department_id,
                                     sensitivity=body.sensitivity, contributor_person_id=body.contributor_person_id)
        return {"id": item_id, "status": "candidate"}

    @app.post("/internal/items/{item_id}/submit")
    def item_submit(item_id: str, ctx: Annotated[ServiceContext, Depends(token("item.submit", "item_id"))]) -> dict[str, Any]:
        items.submit(svc().db, ctx, item_id)
        return {"id": item_id, "status": "in_review"}

    @app.post("/internal/items/{item_id}/versions")
    def item_version(item_id: str, body: VersionBody, ctx: Annotated[ServiceContext, Depends(token("item.propose", "item_id"))]) -> dict[str, Any]:
        return {"id": item_id, "status": "in_review", "version_no": items.propose_version(svc().db, ctx, item_id, body.body)}

    @app.post("/internal/items/{item_id}/verify")
    def item_verify(item_id: str, ctx: Annotated[ServiceContext, Depends(token("item.verify", "item_id"))]) -> dict[str, Any]:
        s = svc()
        if not reads.verification_rate_ok(s.db, ctx):
            raise Refused("verification_limit", 429)    # poisoning defence: verifications per card per hour / day
        return {"id": item_id, "status": items.verify(s.db, ctx, item_id, s.embedder)}

    @app.post("/internal/items/list")
    def item_list(body: ItemList, ctx: Annotated[ServiceContext, Depends(token("item.list"))]) -> dict[str, Any]:
        return reads.list_items(svc().db, ctx, status=body.status, owner_me=body.owner_me, limit=body.limit, after=body.after)

    @app.post("/internal/items/{item_id}/read")
    def item_read(item_id: str, ctx: Annotated[ServiceContext, Depends(token("item.read", "item_id"))]) -> dict[str, Any]:
        return reads.get_item(svc().db, ctx, item_id)

    @app.post("/internal/items/{item_id}/restrict")
    def item_restrict(item_id: str, body: Restrict,
                      ctx: Annotated[ServiceContext, Depends(token("item.restrict", "item_id"))]) -> dict[str, Any]:
        return reads.restrict_contribution(svc().db, ctx, item_id, body.sensitivity)

    @app.post("/internal/items/{item_id}/reject")
    def item_reject(item_id: str, ctx: Annotated[ServiceContext, Depends(token("item.reject", "item_id"))]) -> dict[str, Any]:
        items.reject(svc().db, ctx, item_id)
        return {"id": item_id, "status": "rejected"}

    @app.post("/internal/items/{item_id}/reopen")
    def item_reopen(item_id: str, body: Reopen, ctx: Annotated[ServiceContext, Depends(token("item.reopen", "item_id"))]) -> dict[str, Any]:
        items.reopen(svc().db, ctx, item_id, body.rollback_to_version)
        return {"id": item_id, "status": "in_review"}

    @app.post("/internal/items/{item_id}/retire")
    def item_retire(item_id: str, ctx: Annotated[ServiceContext, Depends(token("item.retire", "item_id"))]) -> dict[str, Any]:
        items.retire(svc().db, ctx, item_id)
        return {"id": item_id, "status": "rejected"}

    @app.post("/internal/labels/{kind}/{target_id}")
    def labels(kind: Literal["source", "knowledge_item"], target_id: str, body: Labels,
               ctx: Annotated[ServiceContext, Depends(token("label.change", "target_id"))]) -> dict[str, Any]:
        return {"rows": items.relabel(svc().db, ctx, kind, target_id, body.department_id, body.sensitivity)}

    @app.post("/internal/verifications/revert")
    def revert(body: Revert, ctx: Annotated[ServiceContext, Depends(token("verification.revert"))]) -> dict[str, Any]:
        return {"count": items.revert_verifications(svc().db, ctx, body.verifier_card_id, body.since, body.until)}

    # ------------------------------------------------------------------ interviews (feature 7)
    def on_answer(ctx: ServiceContext) -> interviews.OnAnswer:
        s = svc()

        def make(cur: Any, saved: interviews.SavedAnswer) -> tuple[str | None, int]:
            caller = caller_of(ctx)
            return items.candidate_from_answer(cur, ctx, consent_id=saved.consent_id, chunk_id=saved.chunk_id, text=saved.text,
                                               embedder=s.embedder, gateway=s.gateway if caller else None, caller=caller)
        return make

    @app.post("/internal/interviews")
    def interview_invite(body: Invite, ctx: Annotated[ServiceContext, Depends(token("interview.invite"))]) -> dict[str, Any]:
        return {"id": interviews.invite(svc().db, ctx, body.expert_person_id, body.job_role), "status": "invited"}

    @app.post("/internal/interviews/{interview_id}/accept")
    def interview_accept(interview_id: str, ctx: Annotated[ServiceContext, Depends(token("interview.accept", "interview_id"))]) -> dict[str, Any]:
        s = svc()
        caller = caller_of(ctx)
        r = interviews.accept(s.db, ctx, interview_id, s.gateway if caller else None, caller, ctx.filter, ctx.filter)
        return r.__dict__

    @app.post("/internal/interviews/{interview_id}/turns")
    def interview_turn(interview_id: str, body: Turn,
                       ctx: Annotated[ServiceContext, Depends(token("interview.turn", "interview_id"))]) -> dict[str, Any]:
        s = svc()
        caller = caller_of(ctx)
        r = interviews.answer_turn(s.db, ctx, interview_id, body.answer, s.embedder, s.gateway if caller else None, caller,
                                   ctx.filter, ctx.filter, on_answer(ctx))
        return r.__dict__

    @app.post("/internal/interviews/{interview_id}/read")
    def interview_read(interview_id: str, ctx: Annotated[ServiceContext, Depends(token("interview.read", "interview_id"))]) -> dict[str, Any]:
        return interviews.read(svc().db, ctx, interview_id)

    @app.post("/internal/interviews/{interview_id}/status")
    def interview_status(interview_id: str, body: InterviewStatus,
                         ctx: Annotated[ServiceContext, Depends(token("interview.status", "interview_id"))]) -> dict[str, Any]:
        return {"id": interview_id, "status": interviews.set_status(svc().db, ctx, interview_id, body.status, body.by_expert)}

    # ------------------------------------------------------------------ gaps and topics (feature 10)
    @app.post("/internal/gaps")
    def gaps(body: GapQuery, ctx: Annotated[ServiceContext, Depends(token("gap.report"))]) -> dict[str, Any]:
        with svc().db.tenant_tx(ctx.tenant_id) as cur:
            report = gap_report(cur, tenant_id=ctx.tenant_id, job_role=body.job_role, item_spec=ctx.filter, topic_spec=ctx.filter)
        return {"job_role": body.job_role, "topics": [g.public() for g in report]}

    @app.post("/internal/topics/{topic_id}/embed")
    def topic_embed(topic_id: str, ctx: Annotated[ServiceContext, Depends(token("topic.embed", "topic_id"))]) -> dict[str, Any]:
        s = svc()
        topics.embed(s.db, ctx, s.embedder, topic_id)
        return {"id": topic_id}

    @app.post("/internal/topics/suggest/{source_id}")
    def topic_suggest(source_id: str, ctx: Annotated[ServiceContext, Depends(token("topic.suggest", "source_id"))]) -> dict[str, Any]:
        s = svc()
        caller = caller_of(ctx)
        if caller is None:
            raise Refused("ai_unavailable", 503)
        return {"proposed": topics.suggest(s.db, ctx, s.gateway, caller, source_id)}

    # ------------------------------------------------------------------ ask-the-expert (feature 15)
    @app.post("/internal/expert-questions")
    def eq_create(body: ExpertQuestion, ctx: Annotated[ServiceContext, Depends(token("expert_question.create"))]) -> dict[str, Any]:
        q = expert.create_question(svc().db, ctx, expert_person_id=body.expert_person_id, question=body.question,
                                   department_id=body.department_id, sensitivity=body.sensitivity)
        return {"id": q["id"], "status": q["status"], "expires_at": q["expires_at"].isoformat()}

    @app.post("/internal/expert-questions/list")
    def eq_list(body: QuestionBox, ctx: Annotated[ServiceContext, Depends(token("expert_question.list"))]) -> dict[str, Any]:
        return reads.list_expert_questions(svc().db, ctx, box=body.box, limit=body.limit)

    @app.post("/internal/expert-questions/{question_id}/reply")
    def eq_reply(question_id: str, body: ExpertReply,
                 ctx: Annotated[ServiceContext, Depends(token("expert_question.reply", "question_id"))]) -> dict[str, Any]:
        return expert.reply(svc().db, ctx, question_id, body.answer, body.title)

    @app.post("/internal/expert-questions/{question_id}/decline")
    def eq_decline(question_id: str, body: Decline,
                   ctx: Annotated[ServiceContext, Depends(token("expert_question.decline", "question_id"))]) -> dict[str, Any]:
        return expert.decline(svc().db, ctx, question_id, body.reason)

    # ------------------------------------------------------------------ readiness (feature 13)
    @app.post("/internal/readiness/generate")
    def quiz_generate(body: QuizGenerate, ctx: Annotated[ServiceContext, Depends(token("quiz.generate"))]) -> dict[str, Any]:
        s = svc()
        caller = caller_of(ctx)
        if caller is None:
            raise Refused("ai_unavailable", 503)
        return readiness.generate(s.db, ctx, s.gateway, caller, body.kind)

    @app.post("/internal/readiness/questions/list")
    def quiz_list(body: QuizList, ctx: Annotated[ServiceContext, Depends(token("quiz.list"))]) -> dict[str, Any]:
        return reads.list_quiz_items(svc().db, ctx, status=body.status, limit=body.limit, after=body.after)

    @app.post("/internal/readiness/attempts/{attempt_id}/read")
    def quiz_attempt_read(attempt_id: str, ctx: Annotated[ServiceContext, Depends(token("quiz.attempt_read", "attempt_id"))]) -> dict[str, Any]:
        return reads.get_attempt(svc().db, ctx, attempt_id)

    @app.post("/internal/readiness/questions/{question_id}/edit")
    def quiz_edit(question_id: str, body: QuizEdit, ctx: Annotated[ServiceContext, Depends(token("quiz.edit", "question_id"))]) -> dict[str, Any]:
        readiness.edit_question(svc().db, ctx, question_id, body.stem, body.options, body.correct_option, body.rubric)
        return {"id": question_id, "status": "draft"}

    @app.post("/internal/readiness/questions/{question_id}/status")
    def quiz_status(question_id: str, body: QuizStatus,
                    ctx: Annotated[ServiceContext, Depends(token("quiz.status", "question_id"))]) -> dict[str, Any]:
        readiness.set_question_status(svc().db, ctx, question_id, body.status)
        return {"id": question_id, "status": body.status}

    @app.post("/internal/readiness/attempts")
    def quiz_start(body: AttemptStart, ctx: Annotated[ServiceContext, Depends(token("quiz.start"))]) -> dict[str, Any]:
        return readiness.start_attempt(svc().db, ctx, body.job_role)

    @app.post("/internal/readiness/attempts/{attempt_id}/answers")
    def quiz_answer(attempt_id: str, body: AnswerSave,
                    ctx: Annotated[ServiceContext, Depends(token("quiz.answer", "attempt_id"))]) -> dict[str, Any]:
        readiness.save_answer(svc().db, ctx, attempt_id, body.position, body.chosen_option, body.answer_text)
        return {"id": attempt_id, "position": body.position}

    @app.post("/internal/readiness/attempts/{attempt_id}/submit")
    def quiz_submit(attempt_id: str, ctx: Annotated[ServiceContext, Depends(token("quiz.submit", "attempt_id"))]) -> dict[str, Any]:
        s = svc()
        caller = caller_of(ctx)
        return readiness.submit_attempt(s.db, ctx, attempt_id, s.gateway if caller else None, caller)

    @app.post("/internal/readiness/answers/{answer_id}/override")
    def quiz_override(answer_id: str, body: Override,
                      ctx: Annotated[ServiceContext, Depends(token("quiz.override", "answer_id"))]) -> dict[str, Any]:
        return readiness.override(svc().db, ctx, answer_id, body.score)

    @app.post("/internal/readiness/reports/{attempt_id}")
    def quiz_report(attempt_id: str, ctx: Annotated[ServiceContext, Depends(token("quiz.report", "attempt_id"))]) -> dict[str, Any]:
        return readiness.report(svc().db, ctx, attempt_id)

    # ------------------------------------------------------------------ consent withdrawal, step 2 (feature 19)
    @app.post("/internal/consents/{consent_id}/erase")
    def consent_erase(consent_id: str, ctx: Annotated[ServiceContext, Depends(token("consent.erase", "consent_id"))]) -> dict[str, Any]:
        s = svc()
        with s.db.tenant_tx(ctx.tenant_id) as cur:
            state_row = withdrawal.consent_state(cur, ctx.tenant_id, consent_id)
            if state_row is None:
                raise Refused("not_found", 404)
            if state_row["withdrawal_status"] in ("held", "completed"):
                return {"id": consent_id, "withdrawal_status": state_row["withdrawal_status"]}
            if state_row["withdrawal_status"] != "hidden":
                raise Refused("not_withdrawn", 409)
            mixed = withdrawal.items_citing_withdrawn(cur, ctx.tenant_id, consent_id)   # before the passages are deleted
            erased_items = items.erase_withdrawn_items(cur, ctx.tenant_id, consent_id, mixed)
            erased_sources = withdrawal.erase_sources(cur, ctx.tenant_id, consent_id)
        withdrawal.finish(s.db, ctx.tenant_id, ctx.card_id, ctx.request_id, consent_id, erased_sources, erased_items)
        return {"id": consent_id, "withdrawal_status": "completed", "sources_erased": erased_sources, "items_erased": erased_items,
                "items_back_in_review": len(mixed)}

    # ------------------------------------------------------------------ housekeeping
    @app.post("/internal/housekeeping")
    def housekeeping(ctx: Annotated[ServiceContext, Depends(token("housekeeping.run"))]) -> dict[str, Any]:
        return {"done": housekeeping_mod.run(svc().db, ctx.tenant_id)}

    return app


def _no_caller(ctx: ServiceContext) -> Caller:
    """Used only when `unavailable_reason` is set, so the gateway is never reached with it."""
    return Caller(tenant_id=ctx.tenant_id, card_id=ctx.card_id, request_id=ctx.request_id, max_input_tokens=0, max_output_tokens=0,
                  calls_per_hour=0, monthly_cap_micro_usd=0)


app = create_app()
