# Documents and knowledge under the company's key — design (decision D41, 2026-10-24)

> **Status: steps 2 to 4b, the first part of step 5 with re-keying, all of step 6 and step 7 built (2026-10-27); step 5 part 2 waits for production.** The AI service locks documents, items'
> texts and interview turns with the company's key when they are saved (`services/ai/app/platform/sealing.py`,
> `services/ai/app/capture/sealed_chunks.py`), answers questions with the in-memory search
> (`services/ai/app/capture/memory_search.py`, `search_cache.py`), and the housekeeping command locks what was saved
> before (`services/ai/app/capture/seal_existing.py`). This design answers the gap named in
> `08-bring-your-own-key.md` ("documents and knowledge are not covered") and splits the work into steps that can each
> be built, tested and merged on their own. The founder confirmed the three choices at the end on 2026-10-24.

## In plain language

Today a company's own key protects only a few small secrets. Its **documents, interview answers and knowledge** sit in
the database as readable text. Anyone who gets a copy of the database or of a backup can read them.

The goal: **everything a company wrote or uploaded is stored locked.** It is locked with the company's own key when
the company brought one, and with the platform's key otherwise. Then:
- a stolen database or backup shows only locked bytes;
- a company that switches its key off makes all its content unreadable here within minutes, even to the platform
  operator;
- destroying the key erases the content for good, even inside old backups ("crypto-shredding").

The hard part is **search**. Today the database itself searches the text: word search, and "meaning" search with
vectors. A database cannot search what it cannot read. So search moves out of the database and into the AI service,
which unlocks a company's content into memory for a few minutes while it is being used.

## What is in the database today (read from the code on 2026-10-24)

- **No uploaded file is stored anywhere.** The bytes pass through memory once (`capture/ingest.py`).
- **Content in readable columns:**
  - `chunks.text` and `chunks.embedding` (document pieces, interview-answer pieces, one copy of each knowledge item);
  - `topics.name`, `.description` and `.embedding`;
  - `interview_turns.question_text` and `.answer_text`;
  - `knowledge_items.title` and `knowledge_versions.body`;
  - `sources.title`;
  - `answer_logs` and `expert_questions.question_redacted`;
  - quiz items and answers;
  - scenarios, their steps and answers;
  - `answer_feedback.comment_redacted`;
  - `knowledge_item_conflicts` excerpts.
- **Who reads it:** only the AI service's database role (`legacyai_ai`, under row-level security). The API's role has
  no right to these columns.
- **Search runs in SQL:**
  - `capture/retrieval.py`: exact cosine distance over every visible chunk, plus PostgreSQL full-text search;
  - `knowledge/items.py`: links an item to its topics by vector similarity.
  - There is **no** vector or text index. Every question already scans all of the company's visible chunks.
- **Backups** (`pg_dump` by `legacyai_backup`) hold all of it in readable form.

## The design

### 1. One content key per company, from the key it already has
- **Where the content key comes from:** derived from the company's data key with HKDF (purpose `content`):
  - **with its own key (BYOK):** the data key is wrapped by the company's key (D35/D40);
  - **without:** the data key is wrapped by the platform's key.
- **Recommended:** every company's content is encrypted, not only BYOK companies. One code path, and backups are
  protected for everyone.
- **Each field is sealed on its own** with AES-256-GCM. The "associated data" binds it to its place:
  `tenant:table:column:row id:key version`. A sealed value copied to another row, column or company does not open.
- **What stays readable:**
  - ids, labels, states, departments, sensitivity levels, dates, the hashes already there;
  - the access filters, which are SQL on these labels.

### 2. The AI service unlocks the company's key itself
- **Python stand-ins first:**
  - the local stand-in (tests);
  - Google Cloud KMS, the same two REST calls as `gcp-kms.ts`, with the AI service's own service account.
- **Recommended:** the company grants the role to **both** service accounts, the API's and the AI service's. The API
  never hands a key to the AI service in a request.
- **Unwrapped keys are cached for at most 5 minutes**, as in the API (D35). Key off → within 5 minutes every answer
  about that company's content is a clear "the company's key is unavailable".

### 3. Search moves into memory, per company
- **On a company's first question,** the AI service reads that company's sealed chunks once:
  - it unseals them in memory;
  - it builds a small in-memory index: the vectors as one matrix, and a word index (BM25 with an English stemmer).
- **Each question is then ranked in memory:**
  - with the same two signals as today, meaning and words, merged the same way (reciprocal-rank fusion);
  - the access filter is still applied in SQL first (labels are readable), so a person never gets a chunk they may
    not see.
- **The index lives as long as the key cache (5 minutes) and is rebuilt after a write** (a version counter per
  company).
- **Measured today in the code:** search is already an exact scan of every visible chunk. **Not measured yet:** how
  much memory and time this costs. Rough sizes:
  - a vector is 384 numbers, about 1.5 KB of memory (float32);
  - a chunk is at most 2,000 characters;
  - 10,000 chunks ≈ 15 MB of vectors + 20 MB of text;
  - step 3 below measures it on synthetic companies of 1,000 / 10,000 / 50,000 chunks.
- **The word search changes:**
  - PostgreSQL's `ts_rank_cd` is replaced by BM25 with a Snowball English stemmer (`snowballstemmer`, pure Python,
    BSD; the 60-day and source checks are done when it is added).
  - Results will not be identical.
  - The acceptance test: on the existing synthetic test companies, the top-5 answers must contain the same verified
    items as before, or the differences are listed and accepted by the founder.

### 4. Moving existing content
- New writes are sealed at once.
- A background job seals each company's existing rows, a batch at a time.
- Reads accept both forms until a company is done; then the readable columns are emptied.
- When a company **clears** its own key, the same job re-seals its content with the platform's key, as long as the
  company's key still works.
- The migration that finally drops the readable columns is refused while any company still has unsealed rows.

### 5. What it does NOT protect (said plainly, also to customers)
- **A running, compromised AI service:** it holds unlocked content in memory for up to 5 minutes.
- **The AI provider** (Gate 2): a question and the pieces used to answer it are sent to it in readable form, as today.
- **Labels and structure:** how many documents, their sizes, who wrote what and when.
- **Erasing by destroying the key** works only for the content. Labels and hashes stay until the company is deleted.

## The steps (each one is its own pull request)

1. **This design** (D41). No code.
2. **Python sealing and key access in the AI service:**
   - content key derivation, field sealing with bound associated data;
   - the local and Cloud KMS key services in Python;
   - tests against stand-ins.
   - Nothing uses it yet.
   - **Built 2026-10-24.** A test opens a key wrapped by the API's own code, so both services use one format.
3. **Search in memory, while the text is still readable:**
   - build the in-memory index from today's readable columns;
   - compare its rankings with today's SQL on the synthetic companies (the acceptance test above);
   - measure memory and time at 1k / 10k / 50k chunks.
   - Switch over only if the results are accepted.
   - **Built and measured 2026-10-24; not switched on.** Results in "Step 3: what was measured" below.
4. **Seal on write** for chunks, interview turns and knowledge versions. Read both forms. Done in two parts:
   - **4a, built 2026-10-25: answers use the in-memory search.** Each company's index is kept at most 5 minutes and
     rebuilt as soon as its chunks change (a per-company change count kept by a database trigger,
     `tenant_usage_counters.search_version`). All indexes together: at most 1 GB (`SEARCH_MEMORY_MB`), the company
     not asked for the longest dropped first. A warning is logged above 50,000 chunks in one company.
     `SEARCH_ENGINE=sql` switches back to the database search until step 5 removes it.
   - **4b part 1, built 2026-10-25: a content key for every company.** A company with its own key uses its live data
     key (unwrapped by the AI service's own account; the company grants the role to both services' accounts). Every
     other company gets a data key of its own, made on first use and wrapped by the **platform's content key**: one
     Cloud KMS software key in the platform's project, usable only by the AI service (the founder's choice of
     2026-10-25; about USD 0.06 a month, read from https://cloud.google.com/kms/pricing that day). Keys are named
     "company:<version>" or "platform:<version>"; each sealed value will store its key name. Nothing is sealed yet.
   - **4b part 2, built 2026-10-25: chunks are stored sealed.** Document pieces, interview answers' search copies and
     verified items' search copies are written with their text and vector sealed (`chunks.text_sealed`,
     `embedding_sealed`, the key name in `sealed_key`); the readable columns stay empty. Each value is bound to its
     company, column and the chunk's natural key ("source:<id>:<ordinal>" or "item:<id>"). Chunks written before stay
     readable and are read as before; a chunk is never both. The search, the answer step (which now computes the
     similarity itself) and topic suggestions open sealed chunks in memory. A company whose key is off gets
     "company_key_unavailable" (503) and nothing new is written. Production refuses to start without a platform
     content key. Limits: the SQL fallback (`SEARCH_ENGINE=sql`) finds only readable chunks; the database migration
     cannot be rolled back once a chunk is sealed.
   - **4b part 3, built 2026-10-25: knowledge versions and interview turns are stored sealed.** The text of every
     new knowledge version (`knowledge_versions.body_sealed`) and every new interview question and answer
     (`interview_turns.question_sealed`, `answer_sealed`), with the key name in `sealed_key`. Bound to the row's natural
     key ("version:<item>:<number>", "turn:<interview>:<ordinal>"). Versions stay unchangeable; erasing one (consent
     withdrawal) empties both forms. The item screens, version history, conflict check, test questions, scenarios
     and the interview screens open them for the request only. Older rows stay readable until step 5.
5. **The background job** that seals existing rows. Then empty the readable columns. A migration refuses to drop
   them early. Done in two parts:
   - **5 part 1, built 2026-10-25: the job.** Part of the housekeeping command (`npm run housekeeping`, job 6), which
     now also runs the AI service's own housekeeping for every company (until then nothing called it; see the
     report, step 21). Per company and run: batches of 200 chunks, 200 versions and 200 turns, each batch in its own
     transaction, for at most 8 seconds; the rest is done by the next run. Each row is sealed exactly as a new one
     would be (same key choice, same binding) and its readable columns are emptied in the same change. The database
     allows this one change and nothing else: a source chunk only while the job's flag `app.reseal` is on; a version
     only through `seal_version()` (the AI service still cannot change a version itself); never sealed -> readable.
     A company whose key cannot be used is skipped and reported (`seal_key_unavailable`); nothing is half-done. The
     command prints what is left (`knowledge.readable_chunks`, `readable_versions`, `readable_turns`).
     Runbook: `docs/runbooks/housekeeping.md`, "Locking older content".
   - **5 part 2, not built:** once production shows 0 left for every company, a migration drops the readable
     columns (refused while any row is still readable) and `SEARCH_ENGINE=sql` is removed.
   - **Re-keying, part 1, built 2026-10-26** (section 4 above): when a company clears its own key, or changes to
     another one, housekeeping job 6 seals what is still sealed with the retired version again with the company's
     current key (the platform's content key, or its new own key): chunks (text and vector), knowledge versions
     (through `reseal_version()`) and interview turns. The database allows this one change: a sealed value replaced
     by a sealed value when the old key is a RETIRED version of the company's own data key and the new one is the key
     it seals with now (`content_rekey_allowed()`, `content_write_key()`), nothing else changing; it cannot check the
     text inside. Separate rounds from the sealing of readable rows, so a company whose old key no longer works still
     has those sealed (`old_key_unavailable`). Counters: `rekeyed_*`, `old_key_*`. Runbook: "Locking again after a
     company clears or changes its own key".
   - **Re-keying, part 2, built 2026-10-27:** the step-6 columns too (questions asked, questions to experts,
     comments, item titles, conflict quotes, readiness questions and answers, scenario texts and answers, document
     titles, topic names and descriptions with their fingerprints), through one routine driven by a list of the
     sealed columns and their bindings (`services/ai/app/knowledge/rekey.py`). The guards of expert questions,
     readiness questions, scenarios and scenario steps allow the same one change; an answer log goes through
     `reseal_answer_log()`, which checks the rule itself.
6. **The rest of the content columns:**
   - titles, topic names (uniqueness then by keyed hash), quiz, scenarios, feedback, conflict excerpts, questions;
   - exports unseal what they export.
   - **6 part 1, built 2026-10-25: questions and feedback.** The question a person asks (`answer_logs`), a question
     put to an expert (`expert_questions`) and a reader's comment on an answer (`answer_feedback`) are stored sealed
     (`question_sealed` / `comment_sealed`, key name in `sealed_key`), bound to "answer:<id>", "expert_question:<id>"
     and "feedback:<answer id>:<card id>". The row id is taken from the database before the insert so the value can
     be bound to it. Only the AI service reads these columns. Older rows are sealed by housekeeping job 6 like the
     others (an answer log through `seal_answer_log()`, since the AI service may not change a log). The text of an
     expert question can no longer be changed at all (the database refuses it), only sealed or erased.
   - **6 part 2, built 2026-10-25: item titles and conflict excerpts.** The title of a knowledge item
     (`knowledge_items.title_sealed`, bound to "item:<id>") and the two values a stored conflict quotes
     (`knowledge_item_conflicts.item_value_sealed`, `other_value_sealed`, bound to "conflict:<item>:<other item>")
     are stored sealed. The item page, the item list, the knowledge map, answers' citations, scenario screens and the
     other side of a conflict open them for the request only; the other side of a conflict the reader may not read is
     not opened at all. Erasing an item empties its title in both forms. The conflict's measure ("pressure" ...) is a
     label from the check in code and stays readable. Consequence: the database can no longer sort items by title, so
     the knowledge map picks the (at most 50) items of a group in id order and sorts that page by title; with more
     than 50 in a group, which 50 are shown may differ from before. Older rows are sealed by housekeeping job 6.
   - **6 part 3a, built 2026-10-25: readiness questions and answers.** A question's words (stem, options, expected
     points) are stored as one sealed value (`quiz_items.content_sealed`, bound to "quiz_item:<id>"); a learner's
     answer and what the grading model said about it are sealed per answer (`quiz_answers.answer_sealed`,
     `rubric_result_sealed`, one key per row, bound to "quiz_answer:<id>"). The kind, the index of the correct option,
     scores and labels stay readable. The reviewer's question list, starting and handing in a test, grading and the
     learner's view open them for the request only. Retention empties both forms. An approved question still cannot
     be edited (sealing an old one is not an edit). Older rows are sealed by housekeeping job 6.
   - Found, not fixed (reported): when an item is erased, its readiness questions are only retired, not emptied, so
     the words of an erased item can remain in a question (sealed from now on, but still stored). A separate change.
   - **6 part 3b, built 2026-10-25: scenario texts and answers.** A scenario's title and situation (each sealed,
     "scenario:<id>"; separate because erasure empties the situation and keeps the title), a step's question and its
     expected points (each sealed, "scenario_step:<id>"; separate so that what a learner is shown never needs the
     points opened), and a learner's answer with its grading ("scenario_answer:<id>"). The job role, labels and scores
     stay readable. Every scenario screen opens them for the request only; the list a learner may run is sorted by
     job role and title after opening. Erasure and retention empty both forms. The parts of an approved scenario still
     cannot change; sealing an old one (the housekeeping job) is the one exception the database allows.
   - **6 part 4a, built 2026-10-25: document titles.** A document's title is stored sealed (`sources.title_sealed`,
     bound to "source:<id>"). The API login lost its right to the column (SELECT is now every other column; it never
     inserted documents, so INSERT went). The document list and page ask the AI service
     (`/internal/sources/titles`, action `source.titles`, also for a machine's key), which names only documents the
     caller may read; without the AI service those two requests fail (503/502) rather than show no or wrong titles.
     The AI service's own screens (item provenance, citations, the knowledge map) open them. Erasure empties both
     forms. Older titles are sealed by housekeeping job 6. A company whose own key is switched off can no longer even
     create a document entry (its title cannot be sealed).
   - **6 part 4b, first half, built 2026-10-25: topic names move into the AI service.** Nothing is sealed yet; this
     makes the second half possible. Creating, renaming, accepting or retiring a topic (`/internal/topics`,
     `/internal/topics/{id}/change`, actions `topic.create`, `topic.update`) and the topic half of applying a
     department template (`/internal/topics/template`, `topic.template`, with the caller's topic:read filter) are done
     by the AI service, each with the topic's search vector in the same step; the API keeps every permission check,
     the job-role links and the audit entry. The topic list asks the AI service for the names it shows
     (`/internal/topics/texts`, `topic.texts`, also for a machine's key), only for topics the caller may read; without
     the AI service the list, creating and changing fail (503/502). The API login lost every right to `name` and
     `description` and can no longer insert or change topics; the AI login may now add an active topic a person made
     (the database still refuses one without the card that made it) and change name, description and status.
   - **6 part 4b, second half, built 2026-10-25: topic names and descriptions are stored sealed** (`name_sealed`,
     `description_sealed`, bound to "topic:<id>"). A name stays unique per company in any case: `name_hash` is a keyed
     fingerprint of the name in lower case (HMAC-SHA256 with a key derived from the content key for that one column,
     `sealing.fingerprint`), unique per company; a new or changed name is compared with the readable names and with the
     fingerprints under every key the company's topics use, while one writer at a time holds the company's topic-name
     lock. The old unique index on `lower(name)` keeps covering the rows still readable. The gap report, the readiness
     report, the knowledge map, an item's topics and the interview's topic open them; lists are sorted by name after
     opening. Older names are sealed by housekeeping job 6 (`sealed_topics` / `readable_topics`). Limit: the
     fingerprint uses Python's lower case and the readable index PostgreSQL's; they agree for ordinary letters, not
     necessarily for every rare character.
7. **Key off and key destroyed, end to end - built 2026-10-27:**
   - the answers people see: when the AI service cannot use the company's key it answers 503
     `company_key_unavailable`, and the API now passes that on as `company-key-unavailable` ("The company's own
     encryption key cannot be used right now") instead of "AI is not available right now";
   - the operator's runbook: `docs/runbooks/company-key.md` (switched off, back on, changed or cleared, destroyed,
     backups, the platform's own key);
   - backups and restore: documented there. A backup opens only while the keys that wrapped its data keys work.
     **Not proven end to end:** opening restored sealed content (the restore test checks rows, row-level security and
     triggers);
   - documentation for customers: `docs/customers/your-own-key.md`.

Only after step 7 may anyone promise "your documents under your key". **Step 7 is built (2026-10-27).** Before that
sentence is said to a customer, three things are still needed and not done: this code deployed to production; for
that company, housekeeping showing 0 readable and 0 `old_key_` rows (older content is still readable until then); and
one real Google Cloud KMS key tried end to end (only stand-in keys were ever used).

## Step 3: what was measured (2026-10-24)

How: `services/ai/eval/search_compare.py` and `eval/search_measure.py`, run on a cloud test machine (x86_64, 4 CPUs,
PostgreSQL 16 with pgvector 0.8.1; production and CI use PostgreSQL 18). Synthetic data only. GitHub runs both tools on
every change (the 1,000 and 10,000 sizes), so the numbers are re-measured there too.

**1. Same answers on the fictional Northfield company** (13 documents, 16 chunks, 90 questions, asked as its reviewer):

| | SQL search (today) | in-memory search |
|---|---|---|
| The same 5 chunks on top | — | **90 of 90 questions** (with the real local model and with the test stand-in) |
| The same first chunk | — | 90 of 90 |
| A correct source document in the top 5 (48 questions that have one), real local model | 48 | 48 |
| Same, test stand-in vectors | 44 | 44 |
| Median time per question | 3.2 ms | 1.0 ms |

Limit of this result: 16 chunks is very small, so agreement is easy. It shows the two searches behave alike here, not
that they will on real documents.

**2. Larger synthetic companies** (texts of random words from the Northfield documents, random vectors; 50 questions):

| Chunks | Memory held | Memory while building | First question (load + build) | SQL search, per question (median / slowest 5 %) | In-memory search, per question | Same chunks in the top 5 |
|---|---|---|---|---|---|---|
| 1,000 | 2.5 MB | 6 MB | 0.26 s | 195 ms / 269 ms | 4 ms / 6 ms | 2.8 of 5 |
| 10,000 | 25 MB | 60 MB | 2.9 s | 2.1 s / 2.4 s | 31 ms / 43 ms | 2.5 of 5 |
| 50,000 | 125 MB | 303 MB | 15.3 s | 9.9 s / 12.2 s | 126 ms / 161 ms | 2.3 of 5 |

(The in-memory times include the SQL query that applies the access filter.)

What the last column means: on random text there is no right answer, so the column shows how much the change of word
scoring (BM25 instead of PostgreSQL's ts_rank_cd) moves the order, not which is better. A separate check at 1,000
chunks found the **meaning** search identical (the same top 20 in 50 of 50 questions) and the **same chunks matching the
words** (50 of 50); only the order of the word matches differs.

**3. Other checks:**
- Word splitting: the 127 ignored words are PostgreSQL's own list; stems equal PostgreSQL's for 419 of 421 words of
  the documents (different: "emergency", "interval"; each search stems questions and texts the same way, so matching
  still works).
- Access: the permission-leakage suite runs its 16 attack groups against the new search too: 128 searches, 0 leaks.
  With the filter deliberately broken, the same test reports 2,084 leaks (so the test can fail).
- Not measured: real documents, a real company's size, several companies held at once, the production machine.

**The founder's decision (2026-10-25):** switch (built as step 4a); 1 GB for all indexes together; a warning above
50,000 chunks per company; and a 2 GB machine for the AI service, because its 1 GB machine could not also hold 1 GB of
indexes (Terraform changed; the founder applies it).

The questions as they were put:
1. Switch answers to the in-memory search? The results above say it finds the same things on the test company and is
   about 45 to 80 times faster than today's SQL search at 1,000 to 50,000 chunks; word ranking order changes on large
   companies.
2. A memory limit for the AI service: proposed **1 GB for all companies' indexes together** (about 400,000 chunks);
   the company not used for the longest is dropped first and rebuilt on its next question. Proposed warning above
   50,000 chunks per company (the first question then waits about 15 s on this machine).

## Choice for step 6 part 4 (decided 2026-10-25: through the AI service)

Document titles (`sources.title`), topic names and descriptions (`topics.name`, `description`) are read and written by
the API itself, for lists and settings screens, and only the AI service can open sealed content. Either those screens
ask the AI service for the words (more calls, slower lists, the AI service becomes needed for screens that work
without it today), or the API is given its own way to open them (a second service that can use every company's key),
or these short labels stay readable and are named as such to customers. **The founder chose the first (2026-10-25):**
the screens ask the AI service; they are a little slower and do not work while the AI service is down.

## Confirmed by the founder (2026-10-24: the recommended defaults)

1. **Encrypt every company's content, not only BYOK companies?** Recommended: yes. One code path, and protected
   backups.
2. **Encrypt the vectors (embeddings) too?** Recommended: yes. Research shows text can be partly rebuilt from such
   vectors. The price: meaning search runs in memory, never in the database, and no vector index can be added later.
3. **Accept the costs:**
   - more memory in the AI service (to be measured in step 3);
   - the first question after a quiet period is slower while the company's index is built;
   - the word ranking changes slightly.
   - Recommended: yes, within limits set after step 3's measurements.
