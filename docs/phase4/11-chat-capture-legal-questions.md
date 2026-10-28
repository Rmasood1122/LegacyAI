# Capture from chats (feature 6) — questions for a lawyer, before anything is built

**Status (2026-10-28): questions only. Nothing is built.** The feature list says this feature needs consent design and
legal review first (`docs/feature-list-35.md`, row 6). This paper is what the founder takes to a lawyer. Each question
says why it matters and what would be built under each answer. **Nothing here is legal advice, and nothing here says
what the law is.** Where a law is named, it is named so the lawyer can say whether it applies; Claude has not checked
it. Every such mention is marked **(for the lawyer to confirm)**.

## 1. What the feature would do, in plain words

Experts explain a lot in team chats (Slack, Microsoft Teams, Google Chat and similar): how a machine is restarted,
why a setting is what it is. The feature would take those explanations into LegacyAI the same way a document is taken
in today: read, personal details replaced by placeholders, cut into passages, searched and cited, verified by a
reviewer before learners rely on them.

Two ways it could work. **The lawyer's answers decide which, if either, is allowed.**

| | A. "My own messages" | B. "A whole channel" |
|---|---|---|
| Who starts it | The expert, for their own messages | An Admin or Owner, for a channel |
| Where the text comes from | An export file the expert makes and uploads | The company's export, or a live connection to the chat tool |
| Whose words are kept | **Only the expert's own messages**; everyone else's are dropped while the file is read, never stored | Everyone who wrote in the channel |
| Whose consent | The expert's, like a document today | Every participant's? (question 2) |

**Our recommendation to put to the lawyer: A only, from export files, no live connection.** It fits what the product
already does for documents, keeps no one else's words, and needs no access to the company's chat account.

## 2. What the product already does (true today, proven by tests)

- **Nothing of a person's words is captured without that person's own "yes"** in the product, for a stated purpose and a
  versioned wording. Only the person's own card can give it; an Admin cannot tick it for them. Enforced by the database
  itself, not only by the code (`docs/phase2/05-capture-and-ingestion.md`, section 1).
- **Personal details are replaced by placeholders before anything is stored or sent to an AI model** (e-mail addresses,
  phone numbers, ID and card numbers, passwords and keys, names and places). **This is never complete**: how much it
  catches is measured on a synthetic test set in every test run (`capture/test_redaction_golden`), and some names and
  addresses in unusual forms get through (`docs/phase2/07-threat-model.md`, T47).
- **The original file is never kept**, only the redacted passages and a fingerprint (hash) of the file.
- **Withdrawal:** the person (or, for someone who has left, an Owner on their written request) withdraws; everything of
  theirs is hidden at once and then erased, including verified items built only from it. A legal hold can pause the
  erasure (but not the hiding). Backups age out after their retention period; text already sent to an AI provider
  follows that provider's retention.
- **Every permission decision is written to the audit log** — captures, reads and withdrawals included (tamper-evident;
  it holds ids and counts, never the text).
- **Regions:** a company can be kept entirely in the EU copy (decision D43), so its data stays in the EU region.
- **No paid AI model is used yet** (Gate 2). When one is, redacted passages are sent to it.

## 3. The questions

Each question: **why it matters**, then **what we would build** under the possible answers.

### Q1. On what legal basis may an employer take an employee's chat messages into LegacyAI?

Why: the product records a "yes", but whether an employee's "yes" to their employer is freely given — and so valid —
is a legal question. Under the EU's GDPR, consent in employment is often doubted, and "legitimate interest" or another
basis may be the one to use **(for the lawyer to confirm)**. Several EU countries have their own employee-data rules
**(for the lawyer to confirm)**.

What we would build: if consent is a valid basis, the existing consent gate with a new scope "my chat messages". If
another basis is needed, the product would still ask the person (as a safeguard and for withdrawal), but the wording
and the record would change — the lawyer would give us the wording.

### Q2. Messages of people who never agreed

A chat is a conversation: an expert's message quotes, answers or names colleagues.

- **Q2a.** Under way A (only the expert's own messages kept), is it enough to drop everyone else's messages while the
  file is read, and to redact names in the expert's messages? Or is reading the others' messages, even for a moment,
  already a use of their data that needs a basis **(for the lawyer to confirm)**?
- **Q2b.** Under way B, must every participant agree before the channel is read? Per channel or per message? What about
  people who have left the company and cannot be asked?
- **Q2c.** Must people who appear in an expert's messages (quoted, mentioned) be told?

What we would build: under A, the reader keeps only messages whose author is the consenting expert and drops the rest
before redaction; a quote of someone else inside the expert's message is redacted like any name. Under B, a per-person
consent check for every author in the channel, and messages of anyone without consent dropped.

### Q3. Works councils and employee representatives

In some countries a tool that could be used to watch employees needs the works council's agreement before it is
introduced — Germany's Works Constitution Act is the usual example **(for the lawyer to confirm)**. Even way A could
count, because the company decides to use it.

What we would build: a company setting "chat capture switched on", off by default, that only an Owner can switch on,
with the date and the Owner's statement that any needed agreement exists — recorded in the audit log. The product
cannot check the statement.

### Q4. What must never be read

Private and direct messages; HR, health, union, religious or political matters (the GDPR's special categories,
**for the lawyer to confirm**); channels marked confidential.

- **Q4a.** Is it enough that the expert chooses what to export (way A)? Or must the product refuse some content even
  when the expert chooses it?
- **Q4b.** Who decides the list of excluded channels or topics: the company, the expert, the law?

What we would build: under A, direct messages refused by default (an export file says which channel a message came
from); under B, an allow-list of channels the Owner names, nothing else read.

### Q5. Notice and transparency

Some places require employers to tell employees in writing before electronic monitoring — for example a New York law on
notice of electronic monitoring **(for the lawyer to confirm whether it applies to this use)**; the GDPR requires
information to the people whose data is used **(for the lawyer to confirm)**.

What we would build: a notice text the company shows its employees (the lawyer writes it); the product shows it again
when chat capture is switched on and when a person gives consent.

### Q6. Is an impact assessment (DPIA) needed before a company switches it on?

Large-scale use of employees' communications may require a data protection impact assessment under the GDPR **(for the
lawyer to confirm)**.

What we would build: nothing in code; a template the company fills in, and a reminder on the switch-on screen.

### Q7. Keeping and deleting

The design proposes: **no raw messages kept, ever**; only the redacted passages of the expert's own messages; withdrawal
works as for documents (section 2).

- **Q7a.** Is that enough? Is there a maximum time passages from chats may be kept, separate from documents?
- **Q7b.** When a colleague (not the expert) asks for their data to be deleted, what must be found and removed, given
  that their name was redacted?

### Q8. The chat tool's own rules

Slack, Microsoft and Google set terms for exports and for apps that read messages; an export may need an admin, and
some plans may not allow it **(for the lawyer and the founder to confirm for the tools customers use)**.

What we would build: export files only (way A) avoids an app in the customer's chat tool. A live connection (way B)
would need each tool's app approval and its own review.

### Q9. Sending chat text to an AI model (after Gate 2)

Redacted passages go to the AI provider when an answer is written. Chat text may be more personal than manuals.

- **Q9a.** Is the provider's processing agreement (and, for EU companies, the transfer rules) enough for chat text, or is
  more needed **(for the lawyer to confirm)**?
- **Q9b.** Should EU companies' chat passages go only to a provider processing in the EU?

## 4. What we need back

1. The lawyer's answers to Q1–Q9 (a short written note is enough), or "do not build it".
2. Which countries the first customers are in (the answers may differ by country).
3. Which chat tools those customers use, and what their export files look like (a synthetic sample, never a real one).

Nothing is built until then. With the answers, the build would be its own pull request: a consent scope, the export
reader for one tool, the drop-everyone-else rule, the company switch, tests with synthetic chats only.

## 5. What this paper does not do

It does not say what the law is, in any country. It does not cover tickets or e-mail (also in feature 6): e-mail is
closer to private correspondence and would need its own questions. It does not estimate cost.
