# Phase 4, Batch B step 2 — open API, webhooks, e-mail

Status on 2026-10-05:

| Part | What | State |
|---|---|---|
| A | API keys for machines (read and ask only) | Built, reviewed and reworked once (a key is its own kind of caller; it ends with its maker's sign-in). Local checks pass. Database and browser tests are written but **have not run** (they run only in GitHub Actions). |
| B | Outgoing webhooks, one example connector | **Not started.** |
| C | E-mail delivery of notices | **Not started.** |

Nothing here calls an outside service. No new library was added.

## Part A — API keys

### What a key is

A key lets another system (an intranet search, a reporting tool) **read** part of the knowledge and **ask**
questions without a person signing in. The Company Owner makes it on the "API keys" screen, sees it **once**, and
pastes it into the other system, which sends it with every request as `Authorization: Bearer <key>`.

A key is for use **between servers**. It must never be put into a web page: the API does not allow browsers on
other sites to send it (no CORS for the `Authorization` header), and a request that carries both a key and a
session cookie is refused.

A key looks like `lak1.<company id>.<key id>.<secret>`. The secret is 32 random bytes. The server keeps only a
SHA-256 hash of the secret and its last four characters (to tell keys apart on the screen). The copy of the
"created" answer that is kept for a retried request has the key removed: the contract marks the field as shown
once (`x-one-time-secrets`), the same way as a card's 3-digit code and a set-up token.

### The rule: a key is its own kind of caller, and never holds more than its maker

In the code a key is not "a card with a mark on it". It is a separate kind of caller (`ApiKeySubject`): it has no
roles, no session and no person. Everything that means "a card" (sessions, card restrictions, usage caps, card
events, role checks) accepts only a card, so the compiler refuses a key there. What a key may do is decided by the
policy decision point alone, as the overlap of:

1. what the maker's card holds **at the moment of the request** (its roles; its state and expiry gate the key);
2. the permissions written into the key when it was made;
3. the short list a key may ever carry — five permissions, fixed in code:
   `knowledge:read`, `knowledge:ask`, `topic:read`, `gap:read`, `source:read`;

and nothing labelled above the key's level (0–3), whatever its maker may read.

**A key cannot add or change anything.** Adding documents was taken off the list after the security read: a document
added by a machine would have been recorded as attested by the Owner in person. Allowing uploads later needs a rule
that a person confirms what a machine added. This is a conservative default for the founder to confirm.

What follows:

- A key never does more than its maker. If the maker loses a role, the key loses it on the next request.
- A key cannot issue cards, verify knowledge, export, read billing or the audit log, or make, list or revoke keys.
- The restrictions on the maker's card (hours, networks, usage cap) do **not** bind the key. A key has its own
  optional network list and its own limits, and it writes no events on the maker's card.
- Rules that need a second person treat a key as its maker (a key may not approve what its maker wrote). No such
  permission is on the short list today; the rule is tested so that it holds if the list ever grows.
- In the audit trail the acting card is the maker's card and every row names the key (`api_key_id`), including
  rows about a request that failed half-way and the rows the AI service writes. The audit log has no separate
  actor kind for keys: the existing kinds were kept and the key is named in the details.

### A key ends with its maker's sign-in

Whenever a card's sessions are ended because something about the card changed, every key that card made is
**revoked in the same transaction, for good** — a new key has to be made afterwards. The one function that ends a
card's sessions does this, so sessions and keys cannot drift apart. The events:

| Event on the maker's card | Its keys |
|---|---|
| 3-digit code changed (also at a renewal or an unlock with a new code) | revoked |
| sign-in factors reset | revoked |
| the holder removes one of their own sign-in factors | revoked (only the sessions opened with that factor end; all keys end) |
| roles changed | revoked |
| card replaced | revoked |
| card revoked | revoked |
| card suspended | revoked (and stay revoked after the card is reinstated) |
| card locked (wrong codes, or an anomaly rule) | revoked |
| signing out | unchanged (nothing about the card changed) |
| card expires | unchanged; the card's state decides on every request (read-only in the grace time, then nothing) |

Removing one's own factor ends all keys although it ends only some sessions: a factor is removed when it is lost
or no longer trusted, nothing records which session made which key, and "a key does not outlive a change of its
maker's sign-in" is the rule. The price: an Owner who tidies up an old factor has to make the keys again (the Owners
are told at once). A unit test reads every source file and fails if a statement that ends sessions appears anywhere
but in the one function (the housekeeping job, which deletes rows of sessions that ended long ago, is the one named
exception).

Why: someone who got into the Owner's session could otherwise make a key valid for a year and keep it after the
Owner had reset everything. The Owners are told (a notice through the existing notifier) when a key is made and
when keys are stopped by the system. The database refuses to undo a revocation or a suspension, or to change what
a key is (scope, level, maker, hash).

### How a request with a key is checked (in order)

1. The operation must say `x-api-key: true` in the contract. On any other operation a key gets 403
   `api-key-not-accepted` (it is no secret which operations take a key).
2. A key together with a session cookie: 401. An `Authorization` header that is not a `Bearer lak1.` key is
   ignored (a proxy adding its own header does not break people's sessions).
3. Shape of the key, then one lookup by company and key id, then the secret's hash compared in constant time (also
   when no such key exists). Unknown, wrong, expired, suspended, revoked, wrong network, or a maker whose card can
   no longer act: one answer for all, 401 with `WWW-Authenticate: Bearer`.
4. Limits: 120 requests a minute per key; asking questions has its own number per hour, set when the key is made
   (default 30, at most 600). Beyond either: 429 with `Retry-After`, before the AI service is called.
5. The policy decision point, as above. Something outside the key's scope: 403 `api-key-scope`.

Asking a question accepts an `Idempotency-Key` from a key client, so that a retry after a time-out does not spend
the AI budget twice. Records for retried requests are kept per key: not with its maker's, not with another key's.
In the table `idempotency_keys` the actor is a card **or** a key (two columns, each with its own foreign key, and a
check that exactly one is set); the store is told "card" or "API key" and nothing more about keys.

Reading starts no work: a key that reads a document still being processed (`getSource`) is told its status; only a
signed-in card's request continues the processing.

The AI service checks for itself: a token made for a key is accepted only for the six internal operations behind
reading and asking (`knowledge.candidates`, `knowledge.answer`, `item.list`, `item.read`, `graph.read`,
`gap.report`); for anything else it is refused like any bad token. In that service a key is nobody's person — the
person in such a token is ignored — so a key can never be taken for a contributor or an author (and "my items" is
empty for a key).

### When a key misbehaves or is attacked

- Refusals that suggest probing are counted against **the key** and suspend the key (the same rule and thresholds
  as for cards). The maker's card is never locked by its key.
- A failed attempt against a key that exists (wrong secret, wrong network, expired, suspended, revoked) is recorded:
  one audit row per key and reason in a 15-minute window, however many attempts, so the log cannot be flooded.
- **Wrong secrets never stop a key.** A key's id is not secret (it is in lists, in the audit trail and in the key
  itself), and the secret is 256 random bits that cannot be guessed. Suspending a key for wrong secrets would
  therefore protect nothing and would let anybody who has seen the id stop somebody else's integration. Instead, at
  the tenth wrong secret within a window one more audit row is written (`API_KEY_WRONG_SECRETS`) and the Owners get
  **one** notice for that key and window; the key goes on working for whoever has the right secret. No extra
  throttle per key id was added: one keyed by the id would also slow the rightful machine, so only the general
  limit per address applies to wrong attempts.
- **What is not prevented:** all keys and all people share the company's hourly AI allowance in the AI service. A
  key's own number of questions per hour bounds what one key can take, but several keys together can still use up
  the allowance.

### Operations (169 in total)

| Operation | Path | Permission | Takes a key | List filter |
|---|---|---|---|---|
| `listApiKeys` | `GET /v1/api-keys` | `api_key:read` | no | unfiltered, with reason (Owner only) |
| `getApiKeyOptions` | `GET /v1/api-keys/options` | `api_key:read` | no | – |
| `createApiKey` | `POST /v1/api-keys` | `api_key:manage` | no | – |
| `revokeApiKey` | `POST /v1/api-keys/{api_key_id}/revoke` | `api_key:manage` | no | – |

Ten existing operations also take a key: `listSources`, `getSource`, `askKnowledge`, `listKnowledgeItems`,
`getKnowledgeItem`, `getGraphNeighbourhood`, `getGapReport`, `listTopics`, `listJobRoles`, `getRoleTopics`.
A unit test pins this list and checks that each of them needs only a permission from the short list.

The interface under `/v1` is meant to stay compatible: fields may be added; nothing is removed or renamed without
a new version. That is a statement of intent written in the contract, not something a test can prove.

### Database

Migration `20261005000100_api_keys.sql`: table `api_keys` (company id on every row, forced row-level security, no
DELETE for the API login), a guard that makes revocation and suspension final and freezes what a key is, two
permissions for the Company Owner (`api_key:read`, `api_key:manage`), one audit detail key. It also changes
`idempotency_keys`: new column `actor_api_key_id` (foreign key to the key), `actor_card_id` may be empty, a check
that exactly one of the two is set, and two unique indexes (company + card + key string; company + key + key string)
in place of the primary key. The rollback removes all of it; every key stops working. For `idempotency_keys` it
first deletes the records made with a key (short-lived replay records; row-level security is lifted for that one
statement and put back, as in the other Phase 4 migrations), then restores the old column rule and primary key.

### What was tested, and what was not

- Run on the developer's computer (no database): the unit tests for the parsing of a key, its states, the rights
  of a key as a pure function (every combination of maker's grants, scope, list and level), the events that revoke
  keys, the failed-attempt record, the choice between cookie and key, the declared one-time fields, the list of ten
  operations, and the screen (the key stays on screen while the list is read again).
- **Written but not run until GitHub runs them:** the database tests (a key does exactly its scope; the table walk
  of every operation with a key that carries everything a key may carry; key plus cookie; each event on the maker's
  card; the database guard; suspension; per-key limits; fifty wrong secrets and then the right one; a repeated
  question answered from the key's own record without a second AI call; a key reading a document in processing)
  and the browser test (the Owner makes a key, a cookie-less
  connection uses it, it stops when revoked).
- Not tested at all: the rollback of the migration on a database that holds records made with a key (GitHub
  rolls every migration back on a database without rows; the delete step is written like the ones in the other
  Phase 4 migrations but has never run against data); a real outside system using a key; behaviour behind the real proxy (the network list relies
  on `TRUST_PROXY` matching the real set-up).

### For the founder to confirm

1. Should Admins also manage keys, or only the Owner (now: Owner only)?
2. May keys add documents (now: no; see above for what that would need)?
3. May keys ask questions, which uses the AI budget (now: yes, with a number per hour for each key)?
4. Are the limits right: at most 366 days, 50 live keys per company, 120 requests a minute, 30 questions an hour
   by default and at most 600?
5. Every change to the maker's card ends that person's keys for good. An integration then stops until someone makes
   a new key. Is that acceptable for the integrations you expect?

### Known limits

- `last_used_at` is updated at most once a minute.
- The company export does not include the list of keys.
- There is no way to "resume" a suspended or revoked key; a new one is made.
- Keys are not OAuth: no per-user tokens, no consent screen, no developer portal.

## Part B — webhooks (not started)

Nothing was built. Planned shape, for the next step: endpoints registered by the Owner; deliveries taken from the
existing outbox; each delivery signed (HMAC-SHA256, timestamp, id); only `https` to public addresses, with the
address checked again at connect time (so a name cannot be re-pointed at an internal address), no redirects, short
time-outs, small bodies; retries with back-off; an endpoint that keeps failing is paused; one documented example
receiver.

## Part C — e-mail (not started)

Nothing was built. Planned shape: a `MailSender` port with a fake sender for tests and `none` as the default, so
that no message leaves until the founder chooses and configures a provider. Features 11 and 33 keep writing their
notices as they do now.
