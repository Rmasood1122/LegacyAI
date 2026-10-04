# Phase 4, step 3 — QR cards (4), activity numbers (27), knowledge map (30); scenario replay (8) NOT built

> Design note. Decision D27 in `docs/decisions.md`. What was measured is in `docs/phase4/REPORT.md` once CI has run;
> until then nothing here is proven beyond the local checks named in the report.

## In plain language

- **QR card (feature 4):** a card can be shown and printed as a QR code. Scanning it opens the sign-in screen with the
  card number already filled in. It does nothing else.
- **Activity numbers (feature 27):** owners and admins see, month by month, how much was done in the product.
- **Knowledge map (feature 30):** anyone who may read knowledge can walk from a topic to its items, from an item to
  the documents it quotes, and so on. Taking the whole map away as one file is an export: only a card that may
  export (the Company Owner) can do it, a few times an hour, and it is written to the audit log.
- **Scenario replay (feature 8): not built in this step.** See the end of this note.

## QR card

**What the code holds:** `https://<the product's address>/#card=LGY-1234-5678-9012-3456` — the address of the sign-in
screen and the card number. Never the 3-digit code, never a token, never a session.

**Why that is safe to print:** a card number alone signs nobody in. The API still demands the 3-digit code and a
passkey or an authenticator-app code, exactly as before. Someone who photographs the QR code learns the card number,
which is also printed on the card in plain text.

**Why the part after `#`:** browsers do not send it to the server, so the number does not reach access logs or the
address a following page is told it came from. The sign-in screen reads it once, fills the field and removes it from
the address bar. A fragment that is not exactly `#card=<a card number>` is ignored.

**How it is made:** in the browser, by the package `qrcode-generator` (MIT, no dependencies), drawn as one SVG path:
no server call, no outside service, nothing inline (the content-security policy forbids that). Error-correction
level M.

**How it is tested:** a unit test reads the drawn code back with a second, independent package (`jsQR`, test only)
and compares the text with the expected address — so the content is proved, not assumed.

**Where it is shown:** on a card's screen for person cards (company cards are not used to sign in by scanning). A
holder reaches their own card from the home screen.

**Printing:** "Print this card" prints the card and nothing else: the company's name (if the card may read it), the
card number, how long it is valid, and the QR code. Roles, limits and the card's history are not on the paper. The
card section exists in the page but is not shown on the screen; while printing, the style sheet shows only that
section.

**If the visitor is already signed in:** the sign-in screen is not shown, so the frame of the application takes a
card-number fragment out of the address bar itself. The number never stays in the address or the history entry.

**The card-number shape** used by the web application is the API contract's pattern, character for character; a test
compares the two.

**What it cannot do:** NFC cards are not built (they need physical cards and readers). The QR code is not a way to
sign in faster than typing the number; it saves typing 19 characters, nothing more. A link can pre-fill ANY card
number, also somebody else's: that helps a phishing page look right, but the 3-digit code and the passkey or
authenticator code are still needed.

## Activity numbers

**What is counted, for each of the last N calendar months (UTC, N at most 24), newest first:** documents added, items
captured, items verified, the median hours from capture to verification, interviews completed, tests handed in.
Every month of the range is returned, also one in which nothing happened; the first is the current month, which is
not over. Also: the items as they stand now (verified, not yet verified, stale), and readiness tests per job role.

**What these numbers are:** counts of activity. They are **not business outcomes** and the screen says so. Nothing
here says what the knowledge was worth or what it saved.

**Who may read them:** Owner and Admin (`knowledge_settings:read`, the same permission as the quality numbers).

**Every number is narrowed by the caller's own right to read what it counts.** The API puts three filters into the
service token and the AI service applies each to its own kind of thing:

| Number | Narrowed by | If the caller does not hold that right at all |
|---|---|---|
| documents, items, items now | `knowledge:read` | counted as 0 (nothing is visible) |
| interviews completed | `interview:read`; an interview has the level of the material it captured | `null` |
| tests handed in | `quiz:read_results` | `null` |

So an Admin whose right to read interviews ends at level 1 is not told that level-3 capture happened, nor how much.
A `null` is shown on the screen as "Not shown to this card" - never as 0 and never as the company's total.
The filters travel in one claim, `filters`, that maps a permission to its filter; a filter is used only for the
permission it was built for (its own `action` must say so), otherwise it counts as absent.
ASSUMPTION: an interview that has no document yet (only invited) holds nothing and counts as level 0. The list of
interviews in the API does not narrow by level (the table has none); the count here is the stricter of the two.

**Test results per job role** are the one place where a person could be picked out, so they have four rules:

1. **Only for a caller who may read the test results of the whole company** (`quiz:read_results` at company scope).
   Anyone else gets no table (`state: not_allowed`).
2. **One fixed window:** the 12 complete calendar months before the current one, whatever `months` was asked for.
   Two requests with different ranges return the same table, so one cannot be subtracted from the other.
3. **At least 5 different people** in that window, or the row says `too_few_people` and carries no numbers at all.
   ASSUMPTION: 5 is a usual minimum; it was chosen, not derived from data.
4. **The mean is rounded to one decimal** (it is a score between 0 and 1).

Each row says in a `state` why it looks as it does: `shown`, `too_few_people` (suppressed, not zero), or
`no_graded_answers` (enough people, no scored answer yet), so the three cannot be confused.

**What the rules do NOT prevent:** comparing the table before and after one new test was graded shows that a test
was added and roughly moved the mean (and when a month ends, the window moves by one month). That is accepted because
the only cards that receive the table - Owner and Admin - may already read every single result. It would become a
real leak if the table were ever given to a card that may not; rule 1 is there to stop that.

**No pass rate:** the product defines no pass mark, so the table gives the mean score of graded answers and says it is
not a pass mark.

**Not duplicated:** questions, answers and refusals are counted on the answer-quality screen (step 1); this screen
links to it. Cards and people come from the existing usage numbers. Two counters share a name on purpose:
`stale_items` here counts stale items the caller may read; `stale_items` in the quality summary counts open review
tasks for stale items in the whole company. The contract says so.

**Download:** the monthly table can be saved as a CSV file made in the browser (cells that start with `=`, `+`, `-`
or `@` are made harmless for spreadsheets). It holds the same counts as the screen and nothing else, so it is a
deliberate exception to "exports go through the export job": the audit log records that the numbers were READ (as for
every request), not that they were saved. It is not part of the company export.

**What it cannot do:** it does not follow one person over time, does not compare departments, and cannot say whether
captured knowledge was any good. The Phase 1 "events table" hook does not exist as a table, so the numbers are
computed from the records themselves.

## Knowledge map

**Nodes:** topics, knowledge items, documents, job roles. **Links** (only ones that already exist):

| Link | Where it comes from |
|---|---|
| item — topic | the topics set on an item (automatically or by a reviewer) |
| item — document | the passages the item's current version quotes |
| job role — topic | the topics a job role needs |
| item — item | a conflict found between two verified items (step 1) |

Nothing is inferred or guessed.

**People are not on the map.** A graph of who wrote what and who holds which role would make it easy to list
everything about one person; the existing screens show that only to people managers.

**Who may read it:** every card that may read knowledge (`knowledge:read`). What a card sees is narrowed where the
data lives: items by the card's knowledge filter, documents exactly as an item's provenance is read elsewhere (ready,
and readable through the same filter - the two places share the SQL), topics by the card's topic filter. A learner
therefore sees verified knowledge only. One definition of "an item the caller may see" (readable and not withdrawn)
is used by every query, the conflict links included. A node the card may not read is not listed, not counted, and
answers "not found" when asked for directly - the same answer as for a node that does not exist. For the same reason
an empty group means "nothing this card may read", not "nothing": hidden and absent cannot be told apart, on purpose.

**Links have ends of a known kind.** An id is unique within its kind only (a job role's id is its name), so every end
of a link is `{kind, id}`:

| Link | from | to | origin |
|---|---|---|---|
| `item_topic` | item | topic | `similarity` or `reviewer` (how the link was made) |
| `item_source` | item | document it cites | - |
| `job_role_topic` | job role | topic | - |
| `item_conflict` | item | item | - ; it has no direction, the smaller id is `from` by convention |

**Bounds:** one neighbourhood lists at most 50 nodes per group, and each group says for itself (`truncated`) when
there are more; the rest of such a group cannot be reached through the map (there is no paging here - the list
screens page).

**The screen** is a list-based browser (no drawing): pick a topic or an item, see what it is linked to grouped by
kind, follow a link to walk on. An item's screen links to its place on the map.

**Taking the whole map out is an export.** It is a separate operation (`POST /v1/knowledge/graph/export`) that

- needs the right to export (`export:create`) - today the Company Owner only. A learner, an expert or an admin can
  browse the map and cannot take it out;
- is still narrowed by the caller's own knowledge and topic filters;
- writes an audit entry of its own (action `knowledge:graph_export`, with the number of nodes and links only);
- can be done at most 5 times an hour per card (then 429);
- is capped at 2000 nodes of each kind (items, topics, documents, job roles) and 10000 links; `truncated` says a cap
  was reached, and the caps are in the file (`limits`).

It is a second, smaller export next to the company's data export (`POST /v1/exports`): it runs at once, returns its
content in the answer and creates no export job. The file is JSON in a named, versioned shape:

```
{ "schema": "legacyai-knowledge-graph/1",
  "nodes": [ { "kind": "topic" | "item" | "source" | "job_role", "id": "...", "label": "...", "status": <item status or null> } ],
  "edges": [ { "kind": "item_topic" | "item_source" | "job_role_topic" | "item_conflict",
               "from": { "kind": "...", "id": "..." }, "to": { "kind": "...", "id": "..." }, "origin": "similarity" | "reviewer" | null } ],
  "truncated": false,
  "limits": { "nodes_per_kind": 2000, "edges": 10000 } }
```

Every edge joins two nodes that are in the file. It holds what the caller may read, so two people can get different
files. It holds titles and names (with personal details blanked out, as everywhere), internal ids, no text of items
or documents and no people.

**What it cannot do:** no relations beyond the four above; no history (it is the state now); no drawing; no paging
of a group beyond 50.

## Data added

None. No table, no column, no migration, no permission, no grant. Three operations (141 in total):
`GET /v1/analytics/activity`, `GET /v1/knowledge/graph`, `POST /v1/knowledge/graph/export`; three internal routes in
the AI service. One new claim in the service token (`filters`). Two packages in the web application (one runs in
the browser, one in tests only).

## Scenario replay (feature 8) — NOT built

Not started. What it needs, so the next step can pick it up:

- scenarios as an ordered list of steps, each tied to verified items; draft → approved by a second person → retired
  (the readiness question rule);
- a learner answers step by step in free text; grading through the existing readiness grading; the learner never sees
  the expected points before handing in; a reviewer can override; results are personal data;
- a scenario whose item becomes stale, rejected or withdrawn must not be offered;
- it needs new tables (or a new kind of quiz item and attempt), so it needs a migration and its own security read.
