# 02 — Data model (Phase 2)

> Phase 2 design. **Nothing in this document is built yet.** It is a proposal for Gate 1.

## In plain language

Phase 2 adds 29 tables (26 that hold company data, 3 global). Every one that holds a company's data follows the Phase 1 pattern without exception: it carries the company's id, the database refuses to show or change rows of any other company, and links between tables include the company id so a row can never point across the wall.

Three things are new and worth knowing:

- **A fourth database login, for the Python service.** It can touch only the Phase 2 tables. It cannot read card secrets, sessions or sign-in factors at all, and — like every login — cannot edit or delete audit rows.
- **Text is stored redacted.** What the database holds is the text *after* personal data has been replaced by placeholders. The original upload is deleted as soon as it has been processed.
- **Storage is tight** (about half a gigabyte for everything), so the model is built to be small: short vectors, no stored originals, quotas per company, and old logs pruned. Sizes are in `08`.

## Conventions

As Phase 1 (`docs/phase1/02-data-model.md`): `id uuid DEFAULT uuidv7()`, `timestamptz`, text enums with `CHECK`, composite foreign keys `(tenant_id, x_id)`, `ENABLE` + `FORCE ROW LEVEL SECURITY` with the single policy `tenant_id = app_current_tenant()`. Migrations stay SQL-first with working rollbacks and the dbmate/built-in parity check.

**Access labels.** Every row that can be retrieved or cited carries the same four labels the policy decision point already understands:

| Column | Meaning |
|---|---|
| `tenant_id` | the company |
| `department_id` | nullable; the department the content belongs to |
| `sensitivity` | 0 = released to learners · 1 = internal (default) · 2 = confidential · 3 = restricted |
| `owner_person_id` | nullable; the contributing expert ("own" scope). A person, not a card, so it survives a card replacement. |

**Owner module** = the only module that changes the table. T = tenant-scoped with forced row-level security; G = global.

## Database roles

| Role | Used by | Change from Phase 1 |
|---|---|---|
| `legacyai_migrator` | migrations | — |
| `legacyai_app` | the TypeScript API | gains grants on the tables its new module owns, plus `SELECT` on the labels of Python-owned tables (needed to build policy decisions) |
| `legacyai_backup` | nightly dump | — |
| **`legacyai_ai`** (new) | the Python service | `LOGIN`, **no** `SUPERUSER`, **no** `BYPASSRLS`, no `CREATEROLE`/`CREATEDB`. Per-table grants below. The Python service checks its own role at start-up and refuses to run with a superuser or `BYPASSRLS` role (same as the API). |

What `legacyai_ai` can **never** touch (no grant at all): `cards`, `card_secrets`, `card_auth_state`, `credentials`, `enrollment_tokens`, `sessions`, `card_directory`, `login_attempts`, `auth_transactions`, `idempotency_keys`, `rate_limit_buckets`, `tenants` (write), `tenant_settings` (write), `export_jobs`, `audit_log` (it may only `EXECUTE audit_write()`; no `SELECT`, `UPDATE`, `DELETE`), `audit_chain_heads`, `audit_anchors`.

What it may read from Phase 1: `people (id, department_id, status)` and `departments (id)` — column-level `SELECT`, for foreign keys and labels. Display names are **not** readable by Python; where a response needs an expert's name, the API adds it.

A test (extension of Phase 1's `integration/rls`) connects as `legacyai_ai` and asserts every one of these refusals, and that every new T table returns nothing without a tenant set and nothing of another tenant.

---

## A. Consent and settings (owner: API `knowledge-gateway`)

### `consents` — T — F19
One row per person per scope.

| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | FK |
| person_id | uuid | FK `(tenant_id, person_id)` → `people`. The expert the consent is from. |
| scope | text | `interview` (my interview answers may be captured) · `documents` (documents I authored may be ingested as my contribution) · `named_expert` (answers may be attributed to me by name) |
| purpose | text | 1–500 chars; the purpose shown to the person when they agreed |
| policy_version | text | which wording they agreed to |
| granted_at | timestamptz | |
| granted_by_card_id | uuid | must be a card of **that person** (checked by a trigger): nobody can consent for someone else |
| expires_at | timestamptz | nullable |
| withdrawn_at, withdrawn_by_card_id | | nullable; again only the person's own card |
| withdrawal_status | text | `none` · `pending` · `completed` · `held` (legal hold) |
| legal_hold, legal_hold_reason, legal_hold_by_card_id, legal_hold_at | | set by an Owner; see `05` |

Indexes: partial unique `(tenant_id, person_id, scope) WHERE withdrawn_at IS NULL` — at most one live consent per scope. A function `consent_is_valid(tenant, person, scope, at)` is the single definition of "valid" (granted, not withdrawn, not expired) used by triggers and by both services.

Grants: `legacyai_app` SELECT, INSERT, UPDATE (no DELETE). `legacyai_ai` SELECT, and UPDATE of `withdrawal_status` only.

### `knowledge_settings` — T — F12, F13, F18, F19
One row per tenant (PK `tenant_id`).

| Column | Default | Notes |
|---|---|---|
| chunk_quota | 5000 | hard ceiling per tenant (`08`) |
| max_upload_bytes | 5 MB | CHECK ≤ 10 MB |
| max_pdf_pages | 50 | CHECK ≤ 200 |
| store_originals | false | CHECK = false while the plan is `pilot` (free database): originals are never kept |
| second_reviewer_for_own_items | true | F12 |
| second_reviewer_for_admin_items | true | F12 |
| verifications_per_hour / per_day | 30 / 100 | poisoning rate limit |
| learner_sources | `verified_only` | or `all_marked` (open decision 4) |
| stale_after_days | 365 | |
| review_sla_days | 5 | |
| answer_log_retention_days | 90 | |
| quiz_answer_retention_days | 365 | |
| interview_max_turns | 30 | |
| expert_question_expiry_days | 30 | |

Grants: `legacyai_app` SELECT, INSERT, UPDATE. `legacyai_ai` SELECT.

### `redaction_allowlist` — T — F18
Terms a reviewer has confirmed are **not** personal data in this company (a machine called "Baker", a product called "Jordan").

`id`, `tenant_id`, `term` (1–80 chars), `entity_type`, `added_by_card_id`, `created_at`. Unique `(tenant_id, lower(term), entity_type)`.
Grants: `legacyai_app` SELECT, INSERT, DELETE. `legacyai_ai` SELECT.

---

## B. Capture (owner: Python `capture`)

### `sources` — T — F25, F7
One row per document or interview: the thing a citation points back to.

| Column | Type | Notes |
|---|---|---|
| id, tenant_id | | |
| kind | text | `document` · `interview` |
| title | text | 1–200 chars, **redacted** like any other text |
| department_id, sensitivity, owner_person_id | | access labels; every chunk inherits them |
| consent_id | uuid | nullable; required when `owner_person_id` is set (trigger) |
| company_owned_attested_by_card_id | uuid | nullable; for documents with no personal contributor the uploader attests "this is the company's document" (`05`). Exactly one of consent / attestation must be present (CHECK). |
| uploaded_by_card_id | uuid | |
| status | text | `pending` · `processing` · `ready` · `failed` · `withdrawn` |
| failure_code | text | nullable; a code, never a message with content |
| mime | text | `application/pdf` · `text/plain` |
| byte_size, page_count, char_count, chunk_count | int | |
| content_sha256 | bytea | of the uploaded bytes |
| language | text | `en` in Phase 2 |
| created_at, ready_at | | |

Indexes: `(tenant_id, content_sha256)` (not unique — a duplicate is reported only to an uploader who may read the existing source; otherwise a unique rule would reveal that a hidden file exists, see `03`); `(tenant_id, status)`; `(tenant_id, owner_person_id)`.
**Consent trigger:** an INSERT, or a move to `processing`/`ready`, is refused unless `consent_is_valid(...)` for `owner_person_id` with scope `documents` (or `interview`), or the attestation is present. This is the database-level proof that capture without consent fails even if application code is bypassed.
Grants: `legacyai_app` SELECT, INSERT (the upload route creates the row). `legacyai_ai` SELECT, UPDATE.

### `source_blobs` — T — F25 (transient)
The uploaded bytes, held only until parsing has committed.

`source_id` PK, `tenant_id`, `bytes bytea`, `created_at`. CHECK `octet_length(bytes) <= 10485760`.
Deleted in the same transaction that writes the chunks. A purge function removes any blob older than 24 hours (a job that never ran). Not included in exports or in the size a tenant is "charged" for.
Grants: `legacyai_app` INSERT. `legacyai_ai` SELECT, DELETE.

### `chunks` — T — F14, F17
The unit of retrieval. **This is the table the permission filter is about.**

| Column | Type | Notes |
|---|---|---|
| id, tenant_id | | |
| kind | text | `source` (a piece of a document or interview) · `item` (the current text of a knowledge item, kept here so that search has one table) |
| source_id | uuid | FK `(tenant_id, source_id)`; set when `kind = source` |
| knowledge_item_id | uuid | set when `kind = item` (CHECK: exactly one of the two) |
| verification_status | text | `unverified` (default) · `verified` · `corrected` · `stale`. For `item` rows it mirrors the item's status; the knowledge module updates it through the capture module's public function in the same transaction as the status change. |
| ordinal | int | position in the source |
| text | text | **redacted**; 1–4000 chars |
| token_estimate | int | |
| embedding | `halfvec(384)` | nullable until embedded. Half-precision: 2 bytes per dimension. |
| embedding_model | text | e.g. `bge-small-en-v1.5@fastembed-0.8.1`; rows with a different model id are never compared with each other, which is what makes re-embedding possible |
| department_id, sensitivity, owner_person_id | | access labels (copied from the source; changed only through a labelled, audited action) |
| page_from, page_to | int | nullable |
| redaction_count | int | |
| low_confidence_redactions | boolean | true → a review task exists; the chunk stays retrievable because the doubtful spans are already redacted |
| status | text | `active` · `withdrawn` |
| interview_turn_id | uuid | nullable; set for interview answers |
| created_at | | |

Indexes: unique `(tenant_id, source_id, ordinal)`; unique `(tenant_id, knowledge_item_id)`; btree `(tenant_id, status, sensitivity)`; btree `(tenant_id, owner_person_id)`; GIN on `to_tsvector('english', text)` (keyword search) — kept only if a test shows PostgreSQL uses it under row-level security (`03`). **No vector index** — see `03` and `08`: at pilot sizes an exact scan inside one tenant is fast, gives perfect recall, and costs no index storage.
Constraint: `embedding IS NULL OR embedding_model IS NOT NULL`.
Grants: `legacyai_ai` SELECT, INSERT, UPDATE, DELETE. `legacyai_app` SELECT on `(id, tenant_id, source_id, department_id, sensitivity, owner_person_id, status)` only — the labels, never the text.

### `redaction_findings` — T — F18
What was redacted where. **Never the value itself.**

`id`, `tenant_id`, `source_id`, `chunk_id` (nullable), `entity_type` (`EMAIL`, `PHONE`, `PERSON`, `CREDIT_CARD`, `IBAN`, `GOV_ID`, `SECRET`, `LOCATION`, …), `detector` (`pattern` · `checksum` · `ner` · `secret_pattern`), `confidence real`, `placeholder` (e.g. `[PERSON_3]`), `char_length int`, `low_confidence boolean`, `created_at`.
Index `(tenant_id, source_id)`.
Grants: `legacyai_ai` SELECT, INSERT, DELETE. `legacyai_app` SELECT.

### `interviews` — T — F7

| Column | Notes |
|---|---|
| id, tenant_id | |
| expert_person_id | the interviewee |
| source_id | the `sources` row (kind `interview`) that holds this interview's chunks |
| consent_id | must be a valid `interview` consent of that person (trigger, as for sources) |
| job_role | text; which role's topic map drives the interview |
| status | `active` · `paused` · `completed` · `abandoned` · `stopped_budget` |
| turn_count, max_turns | |
| cost_micro_usd | running total, from the ledger |
| started_by_card_id, created_at, last_turn_at, completed_at | |

### `interview_turns` — T — F7

`id`, `tenant_id`, `interview_id`, `ordinal`, `topic_id` (nullable), `question_text`, `question_kind` (`topic` · `follow_up`), `answer_text` (**redacted**, nullable until answered), `answered_at`, `prompt_version`, `created_at`. Unique `(tenant_id, interview_id, ordinal)`.
Grants (both): `legacyai_ai` SELECT, INSERT, UPDATE. `legacyai_app` SELECT on labels (`id`, `tenant_id`, `expert_person_id`, `status`).

### `topics` — T — F10

`id`, `tenant_id`, `name` (1–120), `description` (0–500), `department_id`, `origin` (`admin` · `extracted`), `status` (`active` · `proposed` · `retired`), `embedding halfvec(384)`, `embedding_model`, `created_by_card_id`, `created_at`. Unique `(tenant_id, lower(name))`.
AI-proposed topics arrive as `proposed` and count for nothing until an Admin accepts them.

### `role_topic_maps` — T — F10
Which topics a job role must cover. ("Job role" is a label such as *Boiler operator* — not an access role.)

`id`, `tenant_id`, `job_role` (1–120), `topic_id`, `required boolean`, `importance smallint 1–3`, `created_by_card_id`. Unique `(tenant_id, job_role, topic_id)`.

### `person_job_roles` — T — F10, F13
Who holds, or is training for, which job role.

`tenant_id`, `person_id`, `job_role`, `relation` (`holder` · `successor`). PK `(tenant_id, person_id, job_role, relation)`.
Grants (three tables): `legacyai_ai` SELECT, INSERT, UPDATE. `legacyai_app` SELECT, INSERT, UPDATE, DELETE (admin-managed lists).

### `jobs` — T — queue
The Postgres-backed queue (no Redis).

`id`, `tenant_id`, `kind` (`ingest` · `withdraw_consent` · `reembed` · `prune`), `subject_id uuid`, `stage text`, `status` (`queued` · `running` · `done` · `failed`), `attempts int`, `max_attempts int DEFAULT 5`, `locked_until timestamptz`, `last_error_code text`, `created_at`, `updated_at`.
Index `(tenant_id, status, created_at)`. Unique `(tenant_id, kind, subject_id) WHERE status IN ('queued','running')` — a job cannot be queued twice.
A worker claims a job with `SELECT … FOR UPDATE SKIP LOCKED` and a lease (`locked_until`); a crashed slice is picked up again when the lease expires.
Grants: `legacyai_app` SELECT, INSERT. `legacyai_ai` SELECT, INSERT, UPDATE.

---

## C. Knowledge (owner: Python `knowledge`)

### `knowledge_items` — T — F12

| Column | Notes |
|---|---|
| id, tenant_id | |
| title | redacted, 1–200 |
| current_version_id | FK to `knowledge_versions` |
| status | `candidate` · `in_review` · `verified` · `corrected` · `rejected` · `stale` · `withdrawn` (state machine in `06`; a trigger refuses illegal moves) |
| origin | `interview` · `document` · `expert_reply` · `manual` |
| ai_extracted | boolean |
| department_id, sensitivity, owner_person_id | access labels (`owner_person_id` = contributor) |
| created_by_card_id | |
| verified_by_card_id, verified_at | set together (CHECK) |
| stale_after | timestamptz |
| usage_count | int; how often answers cited it — drives review priority |
| created_at, updated_at | |

Indexes: `(tenant_id, status)`, `(tenant_id, owner_person_id)`, `(tenant_id, status, usage_count DESC)`.

### `knowledge_versions` — T — F12
Immutable. `legacyai_ai` gets INSERT and SELECT only — **no UPDATE** — except through the withdrawal function, which blanks `body` (see `05`).

`id`, `tenant_id`, `item_id`, `version_no`, `body` (redacted, 1–8000), `change_kind` (`extracted` · `written` · `corrected` · `expert_reply` · `rollback`), `author_card_id` (nullable for AI extraction), `prompt_version` (nullable), `created_at`. Unique `(tenant_id, item_id, version_no)`.

### `knowledge_item_topics` — T — F10
`tenant_id`, `item_id`, `topic_id`, `link_source` (`similarity` · `reviewer`), `score real`. PK `(tenant_id, item_id, topic_id)`.

### `citations` — T — F14, F12
One table for every "this came from there" link.

| Column | Notes |
|---|---|
| id, tenant_id | |
| subject_type | `knowledge_version` (provenance) · `answer` · `quiz_item` |
| subject_id | uuid |
| chunk_id | FK `(tenant_id, chunk_id)`; `ON DELETE CASCADE` — when a chunk is withdrawn, its citations go with it |
| quote_start, quote_end | int offsets into the chunk text |
| quote_sha256 | bytea; lets the validator's result be re-checked later |
| created_at | |

Index `(tenant_id, subject_type, subject_id)`, `(tenant_id, chunk_id)`.

### `answer_logs` — T — F22 (basic logging), F14
`id`, `tenant_id`, `card_id`, `question_redacted` (≤ 500 chars), `expert_person_id` (nullable; ask-the-expert), `outcome` (`answered` · `dont_know` · `budget_exhausted`), `reason`, `confidence`, `candidates int`, `approved int`, `policy_disagreements int`, `claims_valid int`, `claims_rejected int`, `fabricated_citation boolean`, `prompt_version`, `ledger_id`, `latency_ms`, `created_at`. Index `(tenant_id, created_at)`. Pruned after `answer_log_retention_days`.

### `expert_questions` — T — F15
`id`, `tenant_id`, `asked_by_card_id`, `expert_person_id`, `question_redacted` (≤ 1000), `department_id`, `sensitivity`, `status` (`open` · `answered` · `declined` · `expired`), `decline_reason`, `answer_item_id` (nullable), `created_at`, `answered_at`, `expires_at`. Index `(tenant_id, expert_person_id, status)`.

### `quiz_items` — T — F13
`id`, `tenant_id`, `topic_id`, `knowledge_item_id`, `knowledge_version_id`, `kind` (`mcq` · `open`), `stem`, `options jsonb` (mcq), `correct_option smallint` (mcq), `rubric jsonb` (open), `status` (`draft` · `approved` · `retired`), `department_id`, `sensitivity`, `owner_person_id` (copied from the item, so the same filter applies), `approved_by_card_id`, `approved_at`, `prompt_version`, `created_at`.
The API role gets `SELECT` on everything **except** `correct_option` and `rubric` — the gateway physically cannot return the answers.

### `quiz_attempts` — T — F13
`id`, `tenant_id`, `learner_card_id`, `learner_person_id`, `job_role`, `status` (`in_progress` · `submitted` · `graded` · `expired`), `started_at`, `expires_at`, `submitted_at`, `graded_at`, `scores jsonb` (per topic), `bank_size int`. Trigger: `submitted_at` can be set once; an attempt past `expires_at` cannot be submitted.

### `quiz_answers` — T — F13
`id`, `tenant_id`, `attempt_id`, `quiz_item_id`, `position smallint`, `option_order smallint[]` (the shuffle used for this attempt), `chosen_option smallint`, `answer_text` (redacted, ≤ 4000), `auto_score real`, `ai_score real`, `ai_rubric_result jsonb`, `ai_confidence real`, `final_score real`, `decided_by` (`auto` · `ai` · `reviewer`), `overridden_by_card_id`, `graded_at`. Unique `(tenant_id, attempt_id, quiz_item_id)`. `answer_text` and `ai_rubric_result` are blanked after `quiz_answer_retention_days`; scores stay.

Grants for section C: `legacyai_ai` SELECT, INSERT, UPDATE (no DELETE except `citations`). `legacyai_app` SELECT on label columns of `knowledge_items`, `quiz_items` (minus answers), `quiz_attempts`, `expert_questions` — enough to build a policy decision, not to read content.

---

## D. Review queue (owner: API `knowledge-gateway`; Python may add and resolve)

### `review_tasks` — T — F24
`id`, `tenant_id`, `kind` (`verify_item` · `redaction_review` · `expert_question` · `quiz_item_approval` · `grading_override` · `stale_item`), `subject_type`, `subject_id`, `department_id`, `sensitivity`, `owner_person_id` (labels of the subject, so the queue is filtered like everything else), `priority int`, `status` (`open` · `assigned` · `resolved` · `dismissed`; trigger refuses illegal moves), `assigned_to_card_id`, `created_at`, `due_at`, `first_response_at`, `resolved_at`, `resolved_by_card_id`, `resolution text`.
Indexes: `(tenant_id, status, priority DESC, created_at)`; unique `(tenant_id, kind, subject_id) WHERE status IN ('open','assigned')`.
Grants: `legacyai_app` SELECT, UPDATE. `legacyai_ai` SELECT, INSERT, UPDATE.

---

## E. AI cost control (owner: Python `ai_gateway`; budgets set through the API)

### `ai_budgets` — T
One row per tenant (PK `tenant_id`): `monthly_cap_micro_usd bigint` (CHECK ≥ 0), `max_output_tokens int`, `max_input_tokens int`, `updated_by_card_id`, `updated_at`. No row = the plan default from `ai_plan_defaults`.
Grants: `legacyai_app` SELECT, INSERT, UPDATE. `legacyai_ai` SELECT.

### `ai_budget_periods` — T
`tenant_id`, `period char(7)` (`2026-10`), `spent_micro_usd bigint`, `reserved_micro_usd bigint`. PK `(tenant_id, period)`. This row is what makes the cap **hard**: a call first reserves its worst-case cost with a single conditional `UPDATE … WHERE spent + reserved + $x <= cap`; if no row is updated, the call is refused (`04`).
Grants: `legacyai_ai` SELECT, INSERT, UPDATE. `legacyai_app` SELECT.

### `ai_usage_ledger` — T
One row per AI call, including refused ones.

`id`, `tenant_id`, `card_id` (nullable for system work), `feature` (`answer` · `interview_question` · `item_extract` · `topic_extract` · `quiz_generate` · `quiz_grade` · `embed`), `provider`, `model`, `prompt_version`, `status` (`reserved` · `settled` · `failed` · `refused_budget` · `refused_global` · `refused_kill_switch` · `refused_limits`), `input_tokens`, `output_tokens`, `reserved_micro_usd`, `cost_micro_usd`, `price_input_micro_per_mtok`, `price_output_micro_per_mtok` (the prices used, so old rows stay explainable after a price change), `request_id`, `latency_ms`, `created_at`, `settled_at`.
Index `(tenant_id, created_at)`, `(tenant_id, feature, created_at)`.
Grants: `legacyai_ai` SELECT, INSERT, UPDATE (the trigger allows only `reserved → settled/failed`). `legacyai_app` SELECT.

### `ai_global` — G
One row. `kill_switch boolean`, `kill_switch_reason`, `monthly_cap_micro_usd`, `period`, `spent_micro_usd`, `reserved_micro_usd`, `updated_at`.
Grants: `legacyai_ai` SELECT, UPDATE of the usage columns only. `legacyai_app` SELECT, UPDATE of `kill_switch*` and the cap (operator-only route, platform permission).

### `ai_plan_defaults` — G
`plan_code` PK, `monthly_cap_micro_usd`, `max_output_tokens`, `max_input_tokens`, `chunk_quota`. Seeded: `pilot`, `free`. Read-only for both services.

---

## F. Audit: one writer path

- New function **`audit_write(tenant, actor_card, actor_kind, action, resource_type, resource_id, decision, reason_code, request_id, ip, details jsonb)`**. It rejects any detail key not in the new G table **`audit_detail_keys`** and any string value over 200 characters or containing 16 digits in a row (the two rules the TypeScript code enforces today), then inserts into `audit_log`. The Phase 1 trigger still assigns `seq`, `prev_hash`, `row_hash`.
- `legacyai_app`: its direct `INSERT` grant on `audit_log` is replaced by `EXECUTE` on the function. `legacyai_ai`: `EXECUTE` only.
- `actor_kind` gains the value `ai_service` (Python acting on a card's behalf is recorded with the card as actor and this kind).
- New detail keys for Phase 2 (`source_id`, `chunk_count`, `redactions`, `item_id`, `version_no`, `feature`, `model`, `cost_micro_usd`, `task_id`, `consent_id`, `scope`, `attempt_id`, `candidates`, `approved`) are rows in `audit_detail_keys`, added by migration.

---

## Tenant export

Phase 1's export gains: `consents`, `sources` (no blobs), `chunks` (redacted text, **no vectors**), `knowledge_items`, `knowledge_versions`, `knowledge_item_topics`, `topics`, `role_topic_maps`, `interviews`, `interview_turns`, `expert_questions`, `quiz_items`, `quiz_attempts`, `quiz_answers`, `review_tasks`, `ai_usage_ledger`. The no-secrets scan of Phase 1 is extended to these tables.

## Table list

**Tenant-scoped (26):** `consents`, `knowledge_settings`, `redaction_allowlist`, `sources`, `source_blobs`, `chunks`, `redaction_findings`, `interviews`, `interview_turns`, `topics`, `role_topic_maps`, `person_job_roles`, `jobs`, `knowledge_items`, `knowledge_versions`, `knowledge_item_topics`, `citations`, `answer_logs`, `expert_questions`, `quiz_items`, `quiz_attempts`, `quiz_answers`, `review_tasks`, `ai_budgets`, `ai_budget_periods`, `ai_usage_ledger`.
**Global (3):** `ai_global`, `ai_plan_defaults`, `audit_detail_keys`.

29 new tables; with Phase 1's 33 the database has **62**. The row-level-security test asserts the exact list of tenant tables, so a table added without the policy fails CI.

## Migrations (planned)

| # | Contents |
|---|---|
| 8 | `legacyai_ai` grants scaffold, `audit_write()`, `audit_detail_keys`, `ai_service` actor kind |
| 9 | consent, settings, allow-list |
| 10 | capture tables, consent triggers, pgvector `halfvec` columns |
| 11 | knowledge, citations, logs, expert questions, state-machine triggers |
| 12 | readiness test tables, review queue |
| 13 | AI cost tables and seeds |
| 14 | new permissions and matrix rows (`03`) |

Each has a tested rollback. The `legacyai_ai` role itself is created by `db/roles/create-roles.sql` (as the other three are), not by a migration.
