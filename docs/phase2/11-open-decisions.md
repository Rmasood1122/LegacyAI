# 11 — Open decisions (Phase 2)

> Eight decisions that are yours to make. For each: the question in plain words, what I recommend and why, and what it costs if the choice turns out wrong. Replying "approved" at Gate 1 accepts all eight recommendations; or name the numbers you want changed.

## 1. Which AI model answers questions? (decided at Gate 2, not now)

**The question.** The design works with any provider. Before the first paid call you must pick one.

**Recommendation.** Do not pick blind. At Gate 2, run the small evaluation on **two** candidates under one hard cap of about $5 — **Claude Haiku 4.5** ($1 / $5 per million tokens) and **GPT-5.6 Luna** ($0.20 / $1.20) — and choose from the measured results: correct refusals, citation behaviour, answer correctness, cost per question. Both pass our 60-day maturity rule; both providers let you set a hard monthly spending limit; neither trains on API data by default. *I am an Anthropic model, so treat my leaning with suspicion and let the numbers decide.*

**Cost of being wrong.** Low. Switching provider is a configuration change plus a re-run of the evaluation. The lasting cost is only what was spent with the first one.

## 2. Search vectors: computed inside our own service, or bought from a provider?

**The question.** To search by meaning, each piece of text is turned into a list of numbers. That can be done by a small open model running inside our Python service ($0 per use) or by a paid service (about $0.02 per million tokens, better quality).

**Recommendation.** **Inside our own service** (`bge-small-en-v1.5`, 384 numbers). It keeps the $0 rule, adds no vendor and no key, and no text leaves our service for this step. Price: English only, somewhat weaker search, and the Python service needs 1 GiB of memory instead of 512 MiB.

**Cost of being wrong.** Medium-low. Every stored vector records which model made it, and a re-embedding job is part of the design, so switching later means re-running that job (minutes at pilot size, a few cents if a paid service is chosen). If search quality proves too weak in the evaluation, this is the first thing to change.

## 3. May an expert confirm their own statements?

**The question.** Verification is the product's differentiator. If Maria's interview produces an item, can Maria herself mark it "verified"?

**Recommendation.** **No, for anything the AI extracted from her words** — a second person (another Expert or an Admin with reviewer rights) must confirm it. Yes for an answer she typed herself in reply to a routed question. Both are company settings, default as stated. Reason: the extraction step can distort what she said, and self-confirmation proves nothing to a buyer.

**Cost of being wrong.** If too strict: in a company where only one person understands a topic, items wait unverified (the gap report shows them as "single-source" — which is true and useful). If too loose: "verified" means little, and a careless or malicious expert can fill the base with confirmed errors. Changing the setting later is trivial; rebuilding trust in the word "verified" is not.

## 4. What may learners see: only confirmed knowledge, or everything with a warning label?

**The question.** A learner asks a question. Should the answer draw only on verified items, or also on unverified documents and interview text, marked as unverified?

**Recommendation.** **Verified only, for learners** (Owners, Admins and Experts see everything they are entitled to, with unverified sources marked). It is a company setting. Reason: a successor will act on what the system says; and readiness tests are built from verified items anyway.

**Cost of being wrong.** If too strict: early in a pilot, before much is verified, learners get many "I don't know" answers and the product looks empty — a real adoption risk. If too loose: a learner acts on an unverified, possibly wrong statement. One setting changes it per company.

## 5. Consent: three points that need you and a lawyer

**The questions.**
(a) Company documents with no personal author are ingested on the uploader's **attestation** ("this is the company's document") instead of an individual's consent. Acceptable?
(b) When an expert withdraws consent, their material is **erased, including items already verified**, unless an Owner has placed a **legal hold**. Acceptable?
(c) Who may place a legal hold — proposed: a Company Owner, with a written reason, audited, and the expert is told.

**Recommendation.** Yes to all three as the pilot default — **and have an employment/data-protection lawyer review the consent wording, the withdrawal process and the hold before any real employee's words are captured.** Code can record and enforce a "yes"; it cannot make it legally valid.

**Cost of being wrong.** High, and not technical: a regulator, a works council or a single employee complaint. This is the one decision where "we'll fix it later" is not available. The pilot's synthetic data avoids the problem; the first real customer does not.

## 6. The private AI service: reachable address with an identity check, or a private network?

**The question.** Only the API should be able to call the Python service. Google offers two ways: (A) the service has an internet address but Google rejects every caller except the API's own identity — free; (B) a private network — about $0.20 a month or more, plus slower starts.

**Recommendation.** **(A)**, with our own signed token as a second lock. It is the only $0 option.

**Cost of being wrong.** Low to medium. The address can be probed; rejected requests are documented as not billed, but I could not confirm that they can never wake the service. If abuse of that address ever shows up, moving to (B) is a Terraform change and a small monthly charge.

## 7. AI spending caps (numbers confirmed at Gate 2)

**The question.** How much may AI cost per company per month, and in total, before the system refuses?

**Recommendation.** Starting point: **$5 per company per month** on the pilot plan, **$1** on the free plan, **$20 global**, and a **$25 hard limit at the provider**. When a cap is reached: questions return search results without generated text, interviews fall back to fixed questions, open test answers wait for manual grading — nothing fails, nothing overspends. Only you (the platform operator) can change a company's cap, because you pay the bill until billing exists.

**Cost of being wrong.** Too low: a company hits the wall mid-month and the product degrades to search-only — annoying, visible, instantly fixable by you. Too high: your maximum loss is the global cap per month. The caps are the reason "wrong" has a ceiling.

## 8. Storage rules while on the free database

**The question.** The free database is small. What do we refuse in order to stay inside it, and when do we leave it?

**Recommendation.**
- **5,000 text chunks per company** (roughly 1,500–2,500 pages), 40,000 in total.
- **The uploaded file is not kept** — only the redacted text. (So a document must be uploaded again to benefit from better redaction later.)
- Uploads up to **5 MB / 50 pages**, text and text-layer PDF only.
- New uploads are refused when the database is 80 % full.
- **Move to a paid database (about $15/month) before the first paying customer's data goes in.**

**Cost of being wrong.** Quota too low: a pilot company cannot load its material — you raise the setting. Not keeping originals: re-processing means re-uploading; a customer may also *expect* the original to be retrievable — say clearly that it is not. Leaving the free plan too late: an outage when the monthly compute allowance runs out, or a full database refusing writes, with a customer watching.

---

## Not decisions, but things you should know before saying "approved"

- **Phase 1 code changes in Phase 2.** The audit writer moves into a database function used by both services; the policy decision point gains a structured-filter function and a "second reviewer" guard; the Terraform guardrail about the AI service changes; secrets are regrouped. All covered by the existing tests plus new ones.
- **The Python service needs many new libraries** (PDF parser, redaction engine with a language model, embedding runtime). Each is pinned, audited in CI and recorded in `docs/DEPENDENCIES.md`, but the supply-chain surface grows substantially. One of them (`psycopg`) is LGPL-licensed; we use it unmodified, which the licence permits.
- **Most of the Python tests need the database and will run only on GitHub**, like the Phase 1 database tests.
- **Your checklist is still open:** the repository is public, the commit identity is unchanged, `gh` is not installed. Phase 2 will add the threat model and the injection test corpus to a public repository unless that changes first.
