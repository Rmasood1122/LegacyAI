# 02 — Data model (Phase 2)

> Phase 2 design. **Nothing in this document is built yet.** It is a proposal for Gate 1.
> Revised after an independent review of the first draft (see `11`, "What the review changed").

## In plain language

Phase 2 adds 29 tables (25 that hold company data, 4 global). Every one that holds a company's data follows the Phase 1 pattern without exception: it carries the company's id, the database refuses to show or change rows of any other company, and links between tables include the company id so a row cannot point across the wall.

Three things are new and worth knowing:

- **A fourth database login, for the Python service.** It can touch only the Phase 2 tables. It has no access at all to card secrets, sessions or sign-in factors, and — like every login — cannot edit or delete audit rows. **Its limit, stated plainly:** the wall between companies depends on the service telling the database which company it is working for. A Python service that was taken over by an attacker could therefore read the Phase 2 content of *every* company (not cards or sign-in data). This is the same trust the API has had since Phase 1; it is listed as a risk in `07`.
- **Text is stored redacted, and the uploaded file is never stored.** The file travels from the API to the Python service inside one request, is turned into redacted text there, and is gone when the request ends.
- **Storage is tight** (about half a gigabyte for everything), so the model is built to be small: short vectors, no stored originals, quotas per company, and old logs pruned. Sizes are in `08`.

## Conventions

As Phase 1 (`docs/phase1/02-data-model.md`): `id uuid DEFAULT uuidv7()` primary key, `tenant_id uuid NOT NULL`, timestamps `timestamptz`, text enums as `text` with `CHECK`, references to cards/people as `uuid`, counters `integer`, money `bigint` micro-dollars, composite foreign keys `(tenant_id, x_id)`, `ENABLE` + `FORCE ROW LEVEL SECURITY` with the single policy `tenant_id = app_current_tenant()`. Where a column's type is not written below it follows these conventions; the migrations are the exact definition. Every tenant table has an index starting with `tenant_id`; additional indexes are listed.

**Access labels.** Every row that can be retrieved, listed or cited carries the four labels the policy decision point understands:

| Column | Meaning |
|---|---|
| `tenant_id` | the company |
| `department_id` | nullable; the department the content belongs to |
| `sensitivity` | 0 = released to learners · 1 = internal (default) · 2 = confidential · 3 = restricted |
| `owner_person_id` | nullable; the contributing expert ("own" scope). A person, not a card, so it survives a card replacement. |

**Labels are copied, and copies must move together.** A source's labels are copied to its chunks; an item's to its search chunk, its test questions and its review tasks. One database function, `relabel(kind, id, department, sensitivity)`, is the only way to change labels, and it updates every copy in one transaction (`03`). An item's sensitivity can never start lower than the highest sensitivity of the material it was derived from.

T = tenant-scoped with forced row-level security; G = global. **F#** = feature number in `docs/feature-list-35.md`.

## Who writes what

"Owner" = the module responsible for the table's rules. Several tables are written by both services; this table says exactly who does what.

| Table | Owner | API role `legacyai_app` | Python role `legacyai_ai` |
|---|---|---|---|
| `consents` | API | SELECT, INSERT, UPDATE | SELECT |
| `knowledge_settings` | API | SELECT, INSERT, UPDATE | SELECT |
| `redaction_allowlist` | API | SELECT, INSERT, DELETE | SELECT |
| `review_tasks` | API | SELECT, UPDATE (assign, dismiss) | SELECT, INSERT, UPDATE (create; resolve when the subject is acted on) |
| `ai_budgets` | API | SELECT, INSERT, UPDATE | SELECT |
| `topics`, `role_topic_maps`, `person_job_roles` | API | SELECT, INSERT, UPDATE, DELETE | SELECT; INSERT on `topics` (proposed topics only — trigger); UPDATE of `topics.embedding*` |
| `sources` | capture | SELECT; INSERT (a document's row, status `awaiting_content` or `awaiting_confirmation`); UPDATE of status for confirm / withdraw | SELECT, INSERT (interview sources), UPDATE |
| `chunks` | capture | SELECT on label columns only (below) | SELECT, INSERT, UPDATE, DELETE |
| `redaction_findings` | capture | SELECT | SELECT, INSERT, DELETE |
| `interviews`, `interview_turns` | capture | SELECT on non-text columns; INSERT of `interviews` (invitation) | SELECT, INSERT, UPDATE |
| `jobs` | capture | SELECT, INSERT | SELECT, INSERT, UPDATE, DELETE |
| `knowledge_items` | knowledge | SELECT on label and status columns | SELECT, INSERT, UPDATE |
| `knowledge_versions` | knowledge | — | SELECT, INSERT; change only through `erase_version()` |
| `knowledge_item_topics`, `citations` | knowledge | — | SELECT, INSERT, DELETE |
| `answer_logs` | knowledge | — | SELECT, INSERT, DELETE (pruning) |
| `expert_questions` | knowledge | SELECT on label and status columns | SELECT, INSERT, UPDATE |
| `quiz_items` | knowledge | SELECT on label and status columns (**not** `stem`, `options`, `correct_option`, `rubric`) | SELECT, INSERT, UPDATE |
| `quiz_attempts` | knowledge | SELECT on label and status columns | SELECT, INSERT, UPDATE |
| `quiz_answers` | knowledge | — | SELECT, INSERT, UPDATE |
| `ai_budget_periods` | ai_gateway | SELECT | SELECT, INSERT, UPDATE |
| `ai_usage_ledger` | ai_gateway | SELECT | SELECT, INSERT, UPDATE (state trigger), DELETE (roll-up after 12 months) |
| `ai_global` (G) | ai_gateway | SELECT; UPDATE of kill switch and cap | SELECT; UPDATE of usage columns |
| `ai_plan_defaults` (G), `audit_detail_keys` (G) | migrations | SELECT | SELECT |
| `tenant_usage_counters` (G) | triggers | SELECT | SELECT (maintained by a trigger, not by direct writes) |

The API never reads content text from Python-owned tables: its grants there are label and status columns, which is what it needs to ask the policy decision point about a row. Content reaches a user only through the Python service after a decision.

## Database roles

| Role | Used by | Change from Phase 1 |
|---|---|---|
| `legacyai_migrator` | migrations | — |
| `legacyai_app` | the TypeScript API | grants above |
| `legacyai_backup` | nightly dump (read-only) | — |
| **`legacyai_ai`** (new) | the Python service | `LOGIN`, **no** `SUPERUSER`, **no** `BYPASSRLS`, no `CREATEROLE` / `CREATEDB`. Grants above. The Python service checks its own role at start-up and refuses to run with a superuser or `BYPASSRLS` role (same as the API). |

`legacyai_ai` has **no grant at all** on: `cards`, `card_secrets`, `card_auth_state`, `credentials`, `enrollment_tokens`, `sessions`, `card_directory`, `login_attempts`, `auth_transactions`, `idempotency_keys`, `rate_limit_buckets`, `card_roles`, `card_events`, `card_restrictions`, `tenants`, `tenant_settings`, `export_jobs`, `audit_log`, `audit_chain_heads`, `audit_anchors`. It may `EXECUTE audit_write()` (below). From Phase 1 it may read only `people (id, tenant_id, department_id, status)` and `departments (id, tenant_id)` — for foreign keys and labels. Display names are not readable by Python; where a response needs an expert's name, the API adds it.

The `vector` extension must exist before migration 10. It is created by the setup step that creates the roles (`scripts/db-setup.mjs`, run by the superuser locally and by the Neon console role in the cloud), not by a migration, because the migration role cannot create extensions. *Whether Neon lets the console role create it without further steps is **UNVERIFIED** (Neon documents pgvector as available on every plan).*

A test (extension of Phase 1's `integration/rls`) connects as `legacyai_ai` and asserts every refusal above, and that every new T table returns nothing without a tenant set and nothing of another tenant.

---

## A. Consent and settings

### `consents` — T — F19

| Column | Notes |
|---|---|
| id, tenant_id | |
| person_id | FK → `people`. The expert the consent is from. |
| scope | `own_words` (what I type into the system: interview answers, items I write, replies to questions) · `documents` (documents I wrote may be ingested as my contribution) · `named_expert` (answers may be attributed to me by name) |
| purpose | 1–500 chars; the purpose shown to the person |
| policy_version | which wording they agreed to |
| granted_at, granted_by_card_id | the card must belong to **that person** (trigger) |
| expires_at | nullable |
| superseded_at | set when the person gives a newer consent for the same scope (a renewal does not erase anything) |
| withdrawn_at | nullable |
| withdrawn_by_card_id | the person's own card — **or** an Owner's card when `withdrawal_recorded_for_person` is true |
| withdrawal_recorded_for_person, withdrawal_reference | an Owner recorded the withdrawal on the person's written request (the person has left and has no card). The reference names the Owner's own record of that request; identifier characters only. |
| withdrawal_status | `none` · `hidden` (material no longer served; erasure pending) · `completed` · `held` (legal hold) |
| legal_hold, legal_hold_by_card_id, legal_hold_at, legal_hold_reason | set by an Owner. The written reason stays in this table and is **not** copied to the audit log. |

Indexes: partial unique `(tenant_id, person_id, scope) WHERE withdrawn_at IS NULL AND superseded_at IS NULL` — one live consent per scope. Function `consent_is_valid(tenant, person, scope, at)` — granted, not withdrawn, not superseded, not expired — is the single definition used by triggers and both services.

### `knowledge_settings` — T — F12, F13, F18, F19
One row per tenant (PK `tenant_id`).

| Column | Default | Notes |
|---|---|---|
| chunk_quota | 5000 | chunks of all kinds per tenant (`08`) |
| max_upload_bytes | 5 MB | CHECK ≤ 10 MB |
| max_pdf_pages | 50 | CHECK ≤ 200 |
| store_originals | false | CHECK (= false): keeping uploaded files is not offered in Phase 2 |
| second_reviewer_required | true | the verifier may not be the item's contributor or the author of its current version (`06`) |
| verifications_per_hour / per_day | 30 / 100 | |
| learner_sources | `verified_only` | or `all_marked` |
| stale_after_days | 365 | |
| review_sla_days | 5 | |
| answer_log_retention_days | 90 | |
| quiz_answer_retention_days | 365 | |
| interview_max_turns | 30 | |
| interview_max_cost_micro_usd | 250000 | $0.25 per session |
| expert_question_expiry_days | 30 | |
| quiz_questions_per_attempt | 10 | |
| quiz_time_limit_minutes | 45 | |
| quiz_min_questions_per_topic | 3 | below this a topic is "not enough questions to score" |
| quiz_show_answers_after_grading | false | |

### `redaction_allowlist` — T — F18
`id`, `tenant_id`, `term` (1–80 chars), `entity_type`, `added_by_card_id`, `created_at`. Unique `(tenant_id, lower(term), entity_type)`.

---

## B. Capture

### `sources` — T — F25, F7
One row per document or interview.

| Column | Notes |
|---|---|
| id, tenant_id | |
| kind | `document` · `interview` |
| title | 1–200 chars, **redacted** like any other text |
| department_id, sensitivity, owner_person_id | access labels |
| consent_id | required when `owner_person_id` is set (trigger) |
| company_owned_attested_by_card_id | for documents with no personal contributor: the uploader's declaration (`05`). CHECK: exactly one of `consent_id` / attestation. |
| contributor_confirmed_at | when someone else uploads a document naming a person as contributor, that person must confirm before anything is processed |
| uploaded_by_card_id | |
| status | `awaiting_confirmation` · `awaiting_content` · `processing` · `ready` · `failed` · `withdrawn` (trigger refuses illegal moves) |
| failure_code | a code, never content |
| mime | `application/pdf` · `text/plain` · `text/markdown` |
| byte_size, page_count, char_count, chunk_count | |
| content_sha256 | bytea, of the uploaded bytes |
| language | `en` |
| created_at, ready_at | |

Indexes: `(tenant_id, content_sha256)` (not unique — a duplicate is reported only to an uploader who may read the existing source, `03`); `(tenant_id, status)`; `(tenant_id, owner_person_id)`.
**Consent trigger:** a row may enter `processing` or `ready` only if `consent_is_valid(...)` holds for `owner_person_id` (scope `documents`, or `own_words` for interviews) **and**, when uploader ≠ contributor, `contributor_confirmed_at` is set — or the attestation is present. With the application bypassed, an insert or status change without one of these is refused; the test attacks this directly. *The attestation is a person's declaration, not something the database can check.*

### `chunks` — T — F14, F17
The unit of retrieval.

| Column | Notes |
|---|---|
| id, tenant_id | |
| kind | `source` (a piece of a document or interview) · `item` (the text of a **verified** knowledge item — created when the item is verified, removed when it leaves that status) |
| source_id | set when `kind = source` |
| knowledge_item_id | set when `kind = item` (CHECK: exactly one of the two) |
| ordinal | position in the source (0 for items) |
| text | **redacted**; 1–2000 chars |
| token_estimate | |
| embedding | `halfvec(384)`, nullable until embedded |
| embedding_model | e.g. `bge-small-en-v1.5@fastembed-0.8.1`; only rows with the same model id are compared — this is what makes re-embedding possible |
| department_id, sensitivity, owner_person_id | access labels (changed only through `relabel()`) |
| verification_status | `unverified` (every `source` chunk) · `verified` · `corrected` · `stale` (item chunks, mirroring the item) |
| page_from, page_to | nullable |
| redaction_count, low_confidence_redactions | |
| status | `pending` (source not ready yet — never searched) · `active` · `withdrawn` (hidden at once; deleted by the erasure step) |
| interview_turn_id | set for interview answers |

Indexes: unique `(tenant_id, source_id, ordinal)`; unique `(tenant_id, knowledge_item_id)`; `(tenant_id, status, sensitivity)`; `(tenant_id, owner_person_id)`. **No vector index and no keyword index** (`03`, `08`).
API column grant: `id, tenant_id, kind, source_id, knowledge_item_id, department_id, sensitivity, owner_person_id, verification_status, status` — labels, never text.

### `redaction_findings` — T — F18
`id`, `tenant_id`, `source_id`, `chunk_id` (nullable), `entity_type`, `detector` (`pattern` · `checksum` · `ner` · `secret_pattern`), `confidence real`, `placeholder`, `char_length`, `low_confidence`. Index `(tenant_id, source_id)`. **Never the value.**

### `interviews` — T — F7
`id`, `tenant_id`, `expert_person_id`, `source_id` (the `sources` row of kind `interview`; **the interview's access labels are that source's labels**), `consent_id` (valid `own_words` consent required to leave `invited` — trigger), `job_role`, `status` (`invited` · `active` · `paused` · `stopped_budget` · `completed` · `abandoned`), `turn_count`, `max_turns`, `cost_micro_usd`, `invited_by_card_id`, `created_at`, `last_turn_at`, `completed_at`. Index `(tenant_id, expert_person_id, status)`.

### `interview_turns` — T — F7
`id`, `tenant_id`, `interview_id`, `ordinal`, `topic_id` (nullable), `question_text`, `question_kind` (`topic` · `follow_up` · `template`), `answer_text` (redacted; nullable until answered; blanked on withdrawal — CHECK allows empty only when `erased_at` is set), `answered_at`, `erased_at`, `prompt_version`. Unique `(tenant_id, interview_id, ordinal)`.
API column grant on both: ids, `expert_person_id`, `source_id`, `status`, counts — no question or answer text.

### `topics` — T — F10
`id`, `tenant_id`, `name` (1–120), `description` (0–500), `department_id`, `sensitivity` (topics are labelled too: a topic extracted from a confidential document must not be visible to everyone), `origin` (`admin` · `extracted`), `extracted_from_source_id` (nullable), `status` (`active` · `proposed` · `retired`), `embedding halfvec(384)`, `embedding_model`, `created_by_card_id`. Unique `(tenant_id, lower(name))`. Extracted topics start `proposed`, inherit the source's labels, and count for nothing until an Admin accepts them.

### `role_topic_maps` — T — F10
`id`, `tenant_id`, `job_role` (1–120; a label such as *Boiler operator*, not an access role), `topic_id`, `required`, `importance` (1–3). Unique `(tenant_id, job_role, topic_id)`.

### `person_job_roles` — T — F10, F13
`tenant_id`, `person_id`, `job_role`, `relation` (`holder` · `successor`). PK on all four.

### `jobs` — T — queue (F25, F19)
`id`, `tenant_id`, `kind` (`embed` · `erase_withdrawn` · `reembed` · `expire` · `prune`), `subject_id`, `status` (`queued` · `running` · `done` · `failed`), `attempts`, `max_attempts` (default 5), `locked_until`, `last_error_code`, timestamps. Index `(tenant_id, status, created_at)`. Unique `(tenant_id, kind, subject_id) WHERE status IN ('queued','running')`. Claimed with `FOR UPDATE SKIP LOCKED` and a lease. `done` rows are deleted after 7 days by the housekeeping step (`05`).

---

## C. Knowledge

### `knowledge_items` — T — F12

| Column | Notes |
|---|---|
| id, tenant_id | |
| title | redacted, 1–200; blanked on withdrawal |
| current_version_id | |
| status | `candidate` · `in_review` · `verified` · `corrected` · `rejected` · `stale` · `withdrawn` (`06`; trigger) |
| origin | `interview` · `document` · `expert_reply` · `manual` |
| ai_extracted | boolean |
| department_id, sensitivity, owner_person_id | labels; `owner_person_id` = contributor. Starting sensitivity = the highest among its provenance (trigger). |
| consent_id | required when `owner_person_id` is set (trigger): hand-written items and replies need the person's `own_words` consent just as interview answers do |
| created_by_card_id | |
| verified_by_card_id, verified_at | set together |
| stale_after | |
| usage_count | how often answers cited it |

Indexes: `(tenant_id, status)`, `(tenant_id, owner_person_id)`, `(tenant_id, status, usage_count DESC)`.

### `knowledge_versions` — T — F12
Immutable. `id`, `tenant_id`, `item_id`, `version_no`, `body` (redacted, **1–2000 chars** — so a verified item always fits one search chunk and the embedding model's input), `change_kind` (`extracted` · `written` · `corrected` · `expert_reply` · `rollback`), `author_card_id`, `author_person_id` (null for AI extraction; used by the second-reviewer rule), `prompt_version`, `erased_at`. Unique `(tenant_id, item_id, version_no)`.
No `UPDATE` grant. The only change possible is `erase_version(id)` (a database function used by the withdrawal step) which blanks `body` and sets `erased_at`.

### `knowledge_item_topics` — T — F10
`tenant_id`, `item_id`, `topic_id`, `link_source` (`similarity` · `reviewer`), `score`. PK `(tenant_id, item_id, topic_id)`.

### `citations` — T — F14, F12
`id`, `tenant_id`, `subject_type` (`knowledge_version` · `answer` · `quiz_item`), `subject_id`, `chunk_id` (`ON DELETE CASCADE`), `quote_start`, `quote_end`, `quote_sha256`. Indexes `(tenant_id, subject_type, subject_id)`, `(tenant_id, chunk_id)`. Citations of an answer are deleted when its `answer_logs` row is pruned.

### `answer_logs` — T — F22 (logging only), F14
`id`, `tenant_id`, `card_id`, `question_redacted` (the first 500 characters of the redacted question), `expert_person_id` (nullable), `outcome` (`answered` · `dont_know` · `search_only`), `reason` (`no_relevant_sources` · `not_grounded` · `sources_conflict` · `low_confidence` · `budget_exhausted` · `ai_disabled` · `ai_unavailable` · `grace`), `confidence`, `candidates`, `approved`, `policy_disagreements`, `claims_valid`, `claims_rejected`, `fabricated_citation`, `prompt_version`, `ledger_id`, `latency_ms`, `created_at`. Index `(tenant_id, created_at)`.

### `expert_questions` — T — F15
`id`, `tenant_id`, `asked_by_card_id`, `expert_person_id`, `owner_person_id` (= the expert; the label used by the filter), `question_redacted` (≤ 1000), `department_id`, `sensitivity`, `status` (`open` · `answered` · `declined` · `expired`), `decline_reason`, `answer_item_id`, `created_at`, `answered_at`, `expires_at`. Index `(tenant_id, expert_person_id, status)`.

### `quiz_items` — T — F13
`id`, `tenant_id`, `topic_id`, `knowledge_item_id`, `knowledge_version_id`, `kind` (`mcq` · `open`), `stem`, `options jsonb`, `correct_option`, `rubric jsonb`, `status` (`draft` · `approved` · `retired`), labels (copied from the item), `approved_by_card_id`, `approved_at`, `prompt_version`. Index `(tenant_id, topic_id, status)`.
The API's database role has no `SELECT` on `stem`, `options`, `correct_option`, `rubric`: the gateway is designed to have no way of reading the answers; a test asserts the refusal.

### `quiz_attempts` — T — F13
`id`, `tenant_id`, `learner_card_id`, `learner_person_id`, `owner_person_id` (= the learner, for the "own" scope), `job_role`, `status` (`in_progress` · `submitted` · `graded` · `expired`), `started_at`, `expires_at`, `submitted_at`, `graded_at`, `scores jsonb`, `bank_size`. Index `(tenant_id, learner_person_id, started_at)`. Trigger: `submitted_at` can be set once; an attempt past `expires_at` cannot be submitted.

### `quiz_answers` — T — F13
`id`, `tenant_id`, `attempt_id`, `quiz_item_id`, `position`, `option_order smallint[]`, `chosen_option`, `answer_text` (redacted, ≤ 4000), `auto_score`, `ai_score`, `ai_rubric_result jsonb`, `ai_confidence`, `final_score`, `decided_by` (`auto` · `ai` · `reviewer`), `overridden_by_card_id`, `graded_at`. Unique `(tenant_id, attempt_id, quiz_item_id)`. Text and rubric result are blanked after the retention period; scores stay.

---

## D. Review queue

### `review_tasks` — T — F24
`id`, `tenant_id`, `kind` (`verify_item` · `redaction_review` · `expert_question` · `quiz_item_approval` · `grading_override` · `stale_item`), `subject_type`, `subject_id`, labels (copied from the subject), `visible_to_person_id` (set for `expert_question` tasks: only that expert and Owners see them), `priority`, `status` (`open` · `assigned` · `resolved` · `dismissed`; trigger), `assigned_to_card_id`, `created_at`, `due_at`, `first_response_at`, `resolved_at`, `resolved_by_card_id`, `resolution`.
Indexes: `(tenant_id, status, priority DESC, created_at)`; unique `(tenant_id, kind, subject_id) WHERE status IN ('open','assigned')`.

---

## E. AI cost control

### `ai_budgets` — T
PK `tenant_id`: `monthly_cap_micro_usd` (CHECK ≥ 0), `updated_by_card_id`, `updated_at`. No row = the plan default.

### `ai_budget_periods` — T
`tenant_id`, `period char(7)`, `spent_micro_usd`, `reserved_micro_usd`, `calls`. PK `(tenant_id, period)`. The row the cap is enforced on (`04`).

### `ai_usage_ledger` — T
One row per **attempt** of an AI call, including refused ones.
`id`, `tenant_id`, `card_id`, `feature` (`answer` · `interview_question` · `item_extract` · `topic_extract` · `quiz_generate` · `quiz_grade` · `eval_judge`), `provider`, `model`, `prompt_version`, `attempt`, `status` (`reserved` · `settled` · `failed_charged` · `failed_free` · `expired_charged` · `refused_budget` · `refused_global` · `refused_kill_switch` · `refused_limits` · `refused_rate`), `input_tokens`, `output_tokens`, `reserved_micro_usd`, `cost_micro_usd`, the two prices used, `request_id`, `latency_ms`, `created_at`, `settled_at`.
Indexes `(tenant_id, created_at)`, `(tenant_id, status) WHERE status = 'reserved'`. Rows older than 12 months are deleted once their totals are held in `ai_budget_periods`.
Local embeddings cost nothing and write **no** ledger rows.

### `ai_global` — G
One row: `kill_switch`, `kill_switch_reason`, `monthly_cap_micro_usd`, `period`, `spent_micro_usd`, `reserved_micro_usd`.

### `ai_plan_defaults` — G
`plan_code` PK (FK → `plan_limits`), `monthly_cap_micro_usd`, `max_input_tokens`, `max_output_tokens`, `calls_per_hour`. Seeded for `pilot` and `free`. **The `free` plan does not exist in Phase 1**; migration 13 adds it to `plan_limits`.

### `tenant_usage_counters` — G
`tenant_id` PK, `chunk_count`, `updated_at`. Maintained by a trigger on `chunks`. It exists because a tenant-scoped login cannot count other companies' rows: the system-wide chunk ceiling and the operator's storage view read this table (counts only, no content).

---

## F. Audit: one writer path

- New function **`audit_write(tenant, actor_card, actor_kind, action, resource_type, resource_id, decision, reason_code, request_id, ip, details jsonb)`**. It rejects any detail key not in the G table **`audit_detail_keys`**, any string value over 200 characters or containing 16 digits in a row (the rules the TypeScript code enforces today), then inserts into `audit_log`. The Phase 1 trigger still assigns `seq`, `prev_hash`, `row_hash`.
- `legacyai_app`: its direct `INSERT` on `audit_log` is replaced by `EXECUTE`. `legacyai_ai`: `EXECUTE` only.
- **When the caller is `legacyai_ai`, the function forces `actor_kind = 'service'`** (the kind Phase 1 already uses for "another service acted on a card's behalf") and allows only the decision `event`. The Python service therefore cannot write a row that looks like a card's own decision. It *can* name any card as the one it acted for — a compromised Python service could write misleading `service` rows; this is stated in `07`.
- New detail keys: `source_id`, `chunk_count`, `redactions`, `item_id`, `version_no`, `feature`, `model`, `cost_micro_usd`, `task_id`, `consent_id`, `attempt_id`, `candidates`, `approved`, `policy_disagreements`, `sensitivity_from`, `sensitivity_to`, `department_from`, `department_to`, `interview_id`, `topic_id`.

---

## Tenant export

The Phase 1 export runs as the API role, which by design cannot read Phase 2 content. The Phase 2 part of an export is therefore produced by the Python service (same file formats and manifest) and merged by the API: `consents`, `sources`, `chunks` (redacted text, **no vectors**), `knowledge_items`, `knowledge_versions`, `knowledge_item_topics`, `topics`, `role_topic_maps`, `interviews`, `interview_turns`, `expert_questions`, `quiz_items`, `quiz_attempts`, `quiz_answers`, `review_tasks`, `ai_usage_ledger`. The no-secrets scan of Phase 1 is extended to these files.

## Table list

**Tenant-scoped (25):** `consents`, `knowledge_settings`, `redaction_allowlist`, `sources`, `chunks`, `redaction_findings`, `interviews`, `interview_turns`, `topics`, `role_topic_maps`, `person_job_roles`, `jobs`, `knowledge_items`, `knowledge_versions`, `knowledge_item_topics`, `citations`, `answer_logs`, `expert_questions`, `quiz_items`, `quiz_attempts`, `quiz_answers`, `review_tasks`, `ai_budgets`, `ai_budget_periods`, `ai_usage_ledger`.
**Global (4):** `ai_global`, `ai_plan_defaults`, `audit_detail_keys`, `tenant_usage_counters`.

29 new tables; with Phase 1's 33 the database has **62**. The row-level-security test asserts the exact list of tenant tables, so a table added without the policy fails CI.

## Migrations (planned)

| # | Contents |
|---|---|
| 8 | `audit_write()`, `audit_detail_keys`; the API switched to the function |
| 9 | consent, settings, allow-list |
| 10 | capture tables, consent triggers, `halfvec` columns, `relabel()`, usage-counter trigger |
| 11 | knowledge, citations, logs, expert questions, state-machine triggers, `erase_version()` |
| 12 | readiness test tables, review queue |
| 13 | AI cost tables and seeds; plan `free` added to `plan_limits` |
| 14 | new permissions and matrix rows (`03`). **The primary key of `role_permissions` changes** from `(role_key, permission_key)` to `(role_key, permission_key, grant_source)`: an Expert needs both an `own` base row and a `tenant` pilot row for `knowledge:read`, which the Phase 1 key cannot hold. The Phase 1 matrix tests are re-run unchanged. |

Each has a tested rollback. The `legacyai_ai` role and the `vector` extension are created by the roles/setup script, not by a migration.
