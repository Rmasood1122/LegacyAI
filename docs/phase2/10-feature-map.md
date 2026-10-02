# 10 — Feature map (Phase 2)

> Phase 2 design. **Nothing in this document is built yet.** Module, table, endpoint and test names are the planned ones; the final report will list what actually exists.
> Feature numbers are those of `docs/feature-list-35.md`. Permissions and who holds them: `03`. Tables: `02`.
> Revised after an independent review of the first draft (see `11`, "What the review changed").

## In plain language

For each Phase 2 feature: what will be delivered, what is deliberately left out, and where it will live — which module, which tables, which addresses in the API, and which tests will check it. If a feature's row has no test, it is not done.

"API" = the TypeScript service (`services/api`, module `knowledge-gateway`). "capture" / "knowledge" / "ai_gateway" = modules of the Python service (`services/ai`). Every endpoint below is a public route on the API; the Python service has matching internal routes that only the API can call. Python test files are under `services/ai/tests/`, API test files under `services/api/test/`.

## Summary

| # | Feature | Delivered in Phase 2 | Left out (and where it goes) |
|---|---|---|---|
| 7 | Adaptive AI interviewer | **Text** interview: adaptive, resumable, guided by topic gaps; each answer becomes a candidate item | Voice (LATER) |
| 10 | Gap detector | Simple, rule-based: uncovered, unverified, single-source, stale, thin — per job role, as visible to the viewer | Detecting topics nobody listed; contradictions (23, LATER) |
| 12 | Expert verification loop | State machine, versions, provenance, second-reviewer rule, poisoning defences, rollback | — |
| 13 | Readiness test | Question bank from released verified items, reviewer approval, code + rubric grading with override, per-topic score, report (JSON) | PDF rendering of the report; screens (P3) |
| 14 | Source-cited answers that say "I don't know" | Pipeline with code-validated citations and abstention | Streaming; conversation memory |
| 15 | Ask-the-expert | Answers from a named expert's verified items; routing unanswered questions to the expert; replies feed the loop | Email delivery of the notification (log only) |
| 17 | Permission-aware answers | Retrieval wiring: filter in the query, approval before the prompt, leak-free citations | — |
| 18 | Sensitive-data redaction | Basic: Presidio + custom secret patterns, before storage / embedding / AI; measured | Street addresses (partial), non-English, context-based identification |
| 19 | Consent and ownership | Consent records and gate (three layers), contributor confirmation, see / correct / restrict / withdraw, legal hold | **Legal review — not code** |
| 22 | Answer quality monitor | **Logging only**: one structured row per answer | Any monitor, dashboard or alert (LATER) |
| 24 | Human review queue | Prioritised tasks, assignment, SLA timestamps, bulk actions | Automatic escalation; screens (P3) |
| 25 | Multi-language and multi-format | **Plain text and text-layer PDF, English** | OCR, voice, drawings, other languages (LATER) |
| — | AI cost metering | Ledger, caps, kill switch | Billing customers for it (P4) |

## Detail

### Feature 7 — Text interviewer
| | |
|---|---|
| Modules | capture (flow, turns), ai_gateway (question wording, item extraction), API (routes) |
| Tables | `interviews`, `interview_turns`, `sources` (kind `interview`), `chunks`, `knowledge_items` (candidates), `consents` |
| Endpoints | `POST /v1/interviews`, `GET /v1/interviews`, `GET /v1/interviews/{id}`, `POST /v1/interviews/{id}/accept`, `…/turns`, `…/pause`, `…/resume`, `…/complete` |
| Permissions | `capture:interview` (own), `interview:read`, `interview:manage` |
| Tests | `capture/test_interview_flow` (order follows the gap ranking; follow-up cap; resume; the prompt contains only the expert's own answers), `capture/test_interview_states` (all 36 pairs + trigger), `capture/test_interview_limits` (turns, cost ceiling, fallback to templates), `capture/test_consent_gate`, `security/test_injection_corpus`, contract tests API ↔ Python |
| Design | `05` §4 |

### Feature 10 — Gap detector
| | |
|---|---|
| Modules | capture (calculation), ai_gateway (topic suggestions only), API (topic lists) |
| Tables | `topics`, `role_topic_maps`, `person_job_roles`, `knowledge_item_topics`, `knowledge_items` |
| Endpoints | `GET /v1/gaps?job_role=…`, `GET/POST /v1/topics`, `PATCH /v1/topics/{id}`, `PUT /v1/job-roles/{role}/topics`, `PUT /v1/job-roles/{role}/people`, `POST /v1/topics/suggest` |
| Permissions | `gap:read`, `topic:read`, `topic:manage` |
| Tests | `capture/test_gap_detector` (table-driven: each label from a seeded situation; same input, same report; computed for the viewer), `capture/test_topic_linking`, `security/test_permission_leakage` (#12) |
| Design | `05` §5 |

### Feature 12 — Verification loop
| | |
|---|---|
| Modules | knowledge; API `identity-access` (policy: second-reviewer guard, rate limit); API `knowledge-gateway` |
| Tables | `knowledge_items`, `knowledge_versions`, `citations` (provenance), `review_tasks`, `chunks` (the verified item's search copy) |
| Endpoints | `GET/POST /v1/knowledge/items`, `GET /v1/knowledge/items/{id}`, `…/versions` (GET, POST), `POST …/submit`, `…/verify`, `…/reject`, `…/reopen`, `…/retire`, `PATCH …/labels`, `POST /v1/me/contributions/{id}/restrict`, `POST /v1/knowledge/verifications/revert` |
| Permissions | `knowledge:read`, `knowledge:contribute`, `knowledge:verify`, `knowledge:label`, `contribution:restrict`, `knowledge:revert` |
| Tests | `knowledge/test_item_states` (all 49 pairs, code and trigger), `knowledge/test_verification_rules` (second reviewer for every origin; corrector cannot confirm own correction; self-release refused; rate limits; setting off), `knowledge/test_versions`, `knowledge/test_search_copy` (created on verify, removed on reopen/reject/withdraw), `knowledge/test_revert`, API `unit/policy` (new guard rows) |
| Design | `06` §1 |

### Feature 13 — Readiness test
| | |
|---|---|
| Modules | knowledge; ai_gateway (generation, open-answer grading) |
| Tables | `quiz_items`, `quiz_attempts`, `quiz_answers`, `review_tasks`, `role_topic_maps` |
| Endpoints | `POST /v1/readiness/questions/generate`, `GET /v1/readiness/questions`, `PATCH /v1/readiness/questions/{id}`, `POST …/approve`, `…/retire`; `POST /v1/readiness/attempts`, `GET /v1/readiness/attempts/{id}`, `POST …/answers`, `POST …/submit`, `POST /v1/readiness/answers/{id}/override`, `GET /v1/readiness/reports/{attempt_id}` |
| Permissions | `quiz:read`, `quiz:manage`, `quiz:take`, `quiz:grade`, `quiz:read_results` |
| Tests | `knowledge/test_readiness` (only released verified items; unapproved not served; answer-leak guard; answers unreadable by the API's database login; one submit; expiry; rotation), `knowledge/test_grading`, `knowledge/test_proof_report` (gaps listed; counts only released material; fixed statement present), `knowledge/test_attempt_states` (16 pairs), `knowledge/test_quiz_item_states` (9 pairs) |
| Design | `06` §5 |

### Feature 14 — Cited answers
| | |
|---|---|
| Modules | knowledge (pipeline, validator, abstention), capture (retrieval), ai_gateway, API (approval) |
| Tables | `chunks`, `citations`, `answer_logs`, `knowledge_items` (usage count), `ai_usage_ledger` |
| Endpoints | `POST /v1/knowledge/ask` |
| Permissions | `knowledge:ask`; results filtered by `knowledge:read` |
| Tests | `knowledge/test_citation_validator`, `knowledge/test_abstention` (weak retrieval → no model call; ungrounded; conflict; low confidence withheld), `knowledge/test_answer_markers` (unverified marker; confidence rules; item vs source citation), `knowledge/test_answer_search_only` (each reason; through both locks), `security/test_permission_leakage`, evaluation run (`09`) |
| Design | `06` §3, `03` |

### Feature 15 — Ask-the-expert
| | |
|---|---|
| Modules | knowledge; API (notification through the Phase 1 interface; adds the display name) |
| Tables | `expert_questions`, `review_tasks`, `knowledge_items`, `consents` (scope `named_expert`) |
| Endpoints | `POST /v1/knowledge/ask` with `expert_person_id`; `POST /v1/expert-questions`, `GET /v1/expert-questions`, `POST /v1/expert-questions/{id}/reply`, `…/decline` |
| Permissions | `knowledge:ask`, `expert_question:create`, `expert_question:read`, `expert_question:answer` |
| Tests | `knowledge/test_ask_expert` (only that expert's verified items; fixed label wording; no first person; needs the consent scope; reply becomes a candidate needing a second person; decline; expiry), `knowledge/test_expert_question_states` (16 pairs) |
| Design | `06` §4 |

### Feature 17 — Permission check at retrieval time (wiring)
| | |
|---|---|
| Modules | API `identity-access` (`buildResourceFilterSpec`, `decide` with the new attributes), API `knowledge-gateway` (approval flow), capture (spec → query condition) |
| Tables | `chunks` and every labelled table |
| Endpoints | every list and search above |
| Tests | `security/test_permission_leakage` (21 attack groups, **0 leaks**), the cross-service property test (filter ⇔ `decide()` row by row), `capture/test_filter_translation` (unknown input → nothing), `security/test_prompt_contents` (what each prompt may contain), `integration/test_rls_phase2`, `knowledge/test_relabel` (every copy moves), API `integration/resource-filter` extended |
| Design | `03` |

### Feature 18 — Redaction (basic)
| | |
|---|---|
| Modules | capture (the one `redact` function) |
| Tables | `redaction_findings`, `redaction_allowlist`, `review_tasks`, `chunks` |
| Endpoints | `GET /v1/sources/{id}` shows counts by type; `GET/POST/DELETE /v1/redaction/allowlist` |
| Permissions | `source:read`, `review:read`, `redaction:manage` |
| Tests | `capture/test_redaction_golden` (recall and precision per category, printed with sample size; floors), `capture/test_redaction_order` (before storage, before embedding, before the provider — with a provider spy and planted markers), `security/test_single_writer`, `capture/test_redaction_allowlist` |
| Design | `05` §3 |

### Feature 19 — Consent and ownership
| | |
|---|---|
| Modules | API `knowledge-gateway` (consent endpoints), capture (gate, withdrawal) |
| Tables | `consents`, `sources`, `interviews`, `knowledge_items`, `jobs` |
| Endpoints | `GET /v1/consents`, `POST /v1/consents`, `POST /v1/consents/{id}/withdraw`, `POST /v1/people/{id}/consent-withdrawals` (Owner, for someone who has left), `POST /v1/consents/{id}/hold`, `…/release-hold`, `GET /v1/me/contributions`, `POST /v1/sources/{id}/confirm`, `POST /v1/sources/{id}/withdraw` |
| Permissions | `consent:give`, `consent:withdraw`, `consent:read`, `consent:hold`, `source:confirm`, `source:withdraw` |
| Tests | `capture/test_consent_gate` (API, Python and direct SQL; expired; superseded; withdrawn; someone else's card; unconfirmed contributor), `capture/test_withdrawal` (nothing found right after the request; marker scan of every table; mixed provenance → stale; verified items erased; in grace; recorded by an Owner; legal hold hides but keeps), API `integration/consents` |
| Design | `05` §1. **Legal review required — recorded as a risk, not solved here.** |

### Feature 22 — Answer quality: logging only
| | |
|---|---|
| Modules | knowledge |
| Tables | `answer_logs` |
| Endpoints | none in Phase 2 |
| Tests | `knowledge/test_answer_logging` (one row per question; fields; question stored redacted and cut to 500 characters; pruned by retention with its citations), `security/test_no_content_in_logs` |

### Feature 24 — Review queue
| | |
|---|---|
| Modules | API `knowledge-gateway` (queue endpoints); capture and knowledge create and resolve tasks |
| Tables | `review_tasks` |
| Endpoints | `GET /v1/review/tasks`, `GET /v1/review/tasks/{id}`, `POST …/assign`, `…/unassign`, `…/dismiss`, `POST /v1/review/tasks/bulk` |
| Permissions | `review:read`, `review:resolve` |
| Tests | API `integration/review-queue` (priority order; filter; `expert_question` tasks only for the addressed expert and Owners; assignment; SLA timestamps; bulk with a mixed result; each bulk item audited; `verify_item` cannot be dismissed), `knowledge/test_task_states` (16 pairs + trigger), `knowledge/test_task_creation` |
| Design | `06` §2 |

### Feature 25 — Text and text-layer PDF
| | |
|---|---|
| Modules | capture (ingestion), API (two-step upload, limits) |
| Tables | `sources`, `chunks`, `jobs`, `tenant_usage_counters` |
| Endpoints | `POST /v1/sources`, `PUT /v1/sources/{id}/content`, `GET /v1/sources`, `GET /v1/sources/{id}`, `PATCH /v1/sources/{id}/labels`, `POST /v1/sources/{id}/withdraw` |
| Permissions | `capture:upload`, `source:read`, `source:withdraw`, `knowledge:label` |
| Tests | `capture/test_ingestion_limits` (size, type agreement, pages, quota, system ceiling, storage gate), `capture/test_malicious_files`, `capture/test_ingestion_resume` (embedding interrupted and continued; no duplicates; not searchable before ready; nothing stored when parsing fails), `capture/test_source_states`, `capture/test_event_loop` (health answers during a large upload), `capture/test_chunking`, `capture/test_dedupe`, `capture/test_no_file_at_rest` (the upload's bytes appear in no table) |
| Design | `05` §2 |

### AI cost metering and settings
| | |
|---|---|
| Modules | ai_gateway; API (budget, settings, operator endpoints) |
| Tables | `ai_usage_ledger`, `ai_budgets`, `ai_budget_periods`, `ai_global`, `ai_plan_defaults`, `knowledge_settings` |
| Endpoints | `GET /v1/ai/budget`; `GET/PATCH /v1/knowledge/settings`; operator only: `PUT /v1/tenants/{id}/ai-budget`, `PUT /v1/platform/ai/kill-switch`, `GET /v1/platform/storage` |
| Permissions | `ai_budget:read`, `knowledge_settings:read`, `knowledge_settings:update`; platform: `ai_budget:manage`, `ai_kill_switch:manage`, `platform_storage:read` |
| Tests | `ai_gateway/test_budget`, `ai_gateway/test_provider_failures`, `ai_gateway/test_prices`, `ai_gateway/test_output_sanitising`, `ai_gateway/test_prompts`, `ai_gateway/test_no_real_provider_in_ci`, API `integration/knowledge-settings` |
| Design | `04`, `08` |

## Cross-cutting tests

| Area | Tests |
|---|---|
| API ↔ Python contract | each side validates against one shared internal OpenAPI file; a contract test runs both services together in CI and walks every internal operation |
| Gateway route kind (commit, call, finish) | API `integration/gateway-routes`: rows written before the call are visible to Python; no database connection is held during the call; a failed call leaves the "allowed but failed" audit row; idempotent replay |
| Service token | `security/test_service_token` (expired, wrong audience, wrong action, tampered filter or approved list, wrong algorithm, missing) |
| Row-level security on every new table | `integration/test_rls_phase2` (exact table list; as the Python login; what that login has no access to) |
| "Every route declares a policy" | Phase 1's `security/route-policy-coverage`, extended to gateway routes |
| Audit chain after Python events | `integration/test_audit_from_python` + the Phase 1 verifier; Python cannot write decision rows or card-kind rows |
| Housekeeping | `platform/test_housekeeping` (stale, expiry, pruning, bounded time, overdue items treated as stale before housekeeping runs) |
| No secrets or content in logs, on both services | `security/no-secrets` (API), `security/test_no_content_in_logs` (Python) |
| Module boundaries in Python | lint rule + a self-test that breaks it on purpose |
| Migrations | Phase 1's check (apply → roll back → re-apply, two runners, identical schemas) over all 14 migrations |
| Sizes | `platform/test_sizes`: bytes per chunk and retrieval time at 5,000 chunks, MEASURED and printed |

## Not in Phase 2

6 (passive capture), 8, 9, 11, 16, 21, 23, 26, 27, 28, voice, OCR, knowledge graph, any screen, any billing — as your prompt says. Where the design leaves a hook for one of them, it is only a column or a status value, listed in `02`.
