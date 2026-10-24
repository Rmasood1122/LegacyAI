# Documents and knowledge under the company's key — design (decision D41, 2026-10-24)

> **Status: a design, not built.** Nothing in this document is in the code yet. It answers the gap named in
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
3. **Search in memory, while the text is still readable:**
   - build the in-memory index from today's readable columns;
   - compare its rankings with today's SQL on the synthetic companies (the acceptance test above);
   - measure memory and time at 1k / 10k / 50k chunks.
   - Switch over only if the results are accepted.
4. **Seal on write** for chunks, interview turns and knowledge versions. Read both forms.
5. **The background job** that seals existing rows. Then empty the readable columns. A migration refuses to drop
   them early.
6. **The rest of the content columns:**
   - titles, topic names (uniqueness then by keyed hash), quiz, scenarios, feedback, conflict excerpts, questions;
   - exports unseal what they export.
7. **Key off and key destroyed, end to end:**
   - the answers people see;
   - the operator's runbook;
   - backups and restore with sealed content;
   - documentation for customers.

Only after step 7 may anyone promise "your documents under your key".

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
