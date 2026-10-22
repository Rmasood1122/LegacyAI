# Phase 4, Batch B step 4 — Bring-your-own-key (feature 21)

Status on 2026-10-21: the company's key and the code path are built, and tested with a **local stand-in key
service**. No real key service was used. Database tests run only in GitHub Actions. Regional hosting (the other half of
feature 21 in the feature list) is infrastructure and belongs to Batch C.

## What it gives a company

A company can have its **own** encryption key, held at a key service the company controls, for example its own Google
Cloud KMS. LegacyAI never sees that key. If the company switches the key off at its key service, the secrets LegacyAI
keeps for that company can no longer be opened by anybody here, including the platform operator. The company can turn
the key on again later.

## What it covers today, and what it does not

| Covered | Not covered (yet) |
|---|---|
| authenticator-app seeds (sign-in factor) | **documents and knowledge** (text, chunks, embeddings in the AI service's tables) |
| webhook signing secrets | the audit log, people, cards (hashed or not secret) |
| SSO client secrets | backups (they hold what the database holds: the sealed values, which stay sealed) |

Why not the documents and knowledge: search depends on the database reading the text (full-text search) and its
vectors. Encrypting them with a key the database cannot use would switch search off. Covering them needs a different
design, for example encrypted search, or decrypting into memory per company. That is a decision of its own, with real
costs. It is the main remaining gap, and the founder must know it before anyone promises "your data under your key".

## How it works

- **Envelope encryption.** The company gets a *data key* (32 random bytes). The data key is stored only *wrapped*,
  meaning encrypted by the company's key, and only the key service can unwrap it (table `company_data_keys`). The
  company's secrets are sealed with the data key (AES-256-GCM, bound to the row they belong to, like before).
- **One sealer for everything.** Every place that seals a company's secret asks for that company's sealer and gets
  the same two calls as before:
  - a company without its own key is sealed with the platform's key, as before;
  - a company with its own key is sealed with its data key.

  The key id stored with each secret says which key opens it. Secrets sealed earlier keep opening with the key they
  were sealed with.
- **Fail closed.** When the company's key cannot be used (switched off, deleted, unreachable):
  - nothing of it opens. Sign-ins with an authenticator app, webhook signatures and SSO sign-ins of that company stop.
    Passkey sign-ins do not depend on a sealed secret and keep working;
  - nothing new is sealed with the platform's key instead. Setting up an authenticator app, adding a webhook or saving
    an SSO connection answers **503** `company-key-unavailable`.
- **Only what was sealed after the key was brought.** Secrets sealed before the company brought its key stay sealed
  with the platform's key, and switching the company's key off does not lock them. Nothing seals them again yet: the
  person sets up the authenticator app again, the Owner rotates the webhook secret and saves the SSO secret again.
  Re-sealing in bulk is not built.
- **An outage is not a mistake.** While the company's key is out of reach:
  - a failed authenticator code is not counted against the card, so an outage does not pause people's cards;
  - webhook deliveries are not attempted. They wait for the next run instead of using up their retries.
- **Delay.** Unwrapped data keys are kept in memory for at most **5 minutes**, so switching the key off takes effect
  within that time, not at once.
- **Changing key.** Each change makes a new version of the data key, and the old version is retired. What the old
  version sealed still opens while the old key at the key service works. Going back to "none" means new secrets are
  sealed with the platform's key again.

## Who sets it

The **platform operator**, at the company's request, once the company has given the platform access to its key at the
key service: `PUT /v1/tenants/{tenant_id}/encryption-key` with `{ "key_ref": "..." }` or `null`, and
`GET` the same address to read the state. The company's own Owner cannot set it. An Owner card is no proof of control
over a key service, and a wrong key would lock the company out of its own secrets.

A key that does not work is refused (**422**) before anything is sealed with it: the new data key is wrapped and
unwrapped once as a test. The company's audit log records an operator action, without the key reference.

There is no screen for it yet. It is an operator action through the API, like the seat limit.

## Configuration

`KEY_SERVICE=none` (the default) means no company can bring a key.

`KEY_SERVICE=local` with `LOCAL_KEY_SERVICE_KEYS` (JSON of name → base64 32 bytes) is the stand-in. It is refused when
`NODE_ENV=production`. Its key references are `local:<name>`.

**The missing piece** is a real key service adapter, for example Google Cloud KMS: one class with the same two calls,
`wrap` and `unwrap`. It needs a cloud account, and so a decision of the founder.

## Operations (191 in total)

| Operation | Path | Permission |
|---|---|---|
| `getCompanyEncryptionKey` | `GET /v1/tenants/{tenant_id}/encryption-key` | `tenant:encryption_key` (platform only) |
| `setCompanyEncryptionKey` | `PUT /v1/tenants/{tenant_id}/encryption-key` | `tenant:encryption_key` (platform only) |

## Database

Migration `20261008000100_company_keys.sql` adds:
- the table `company_data_keys`, with FORCE row-level security. A guard keeps versions unchanged and retiring final,
  and there is no DELETE;
- one live version per company;
- the permission.

**Rollback** refuses to run while any company has data keys, because secrets sealed with them could no longer be
opened.

`tenants.encryption_key_ref` (a Phase 1 placeholder) stays unused. The application may not update tenant rows, and the
reference belongs with the wrapped key it opens.

## Known limits (from the review)

- **Timing:** a sign-in of such a company with a known card may ask the key service when the cache is empty; an
  unknown card does not. With a real key service this difference could show that a card exists (see below).
- **Race:** a secret sealed at the very moment the operator sets the key can still be sealed with the platform's key.
- **Faults:** a key service fault other than "key unavailable" (a future adapter's bug) gives a 500, not the fail-closed
  answer.
- **No binding:** the key reference is not bound to the company. The operator could point one company at another
  company's key. Only the operator can set keys, and every change is in both audit logs.

## Found on the way

- `sso_connection_id`, which the SSO step writes to the audit log, was in the database's list of allowed detail keys
  but not in the server's own list. Saving or removing an SSO connection would have failed with a 500. It is fixed
  here, together with `key_version`.
- The readiness check (`/v1/ready`) compares the database's newest migration with a constant in the code. The SSO commit
did not raise it, so readiness would have said "not ready". It now names this step's migration, and a new unit test
fails whenever the constant is not the newest migration file.

## What was tested, and what was not

- **Run locally (no database):** 12 unit tests. They cover:
  - the stand-in: a wrapped key is bound to its company and version; a key that is switched off opens nothing;
    references; no key service;
  - the sealer: platform key without a company key; the company's key for new secrets, with old ones still opening;
    a key switched off (nothing opens, nothing new sealed); a change of key and back to none; a key that does not work
    is refused; a wrapped key copied to another company does not open there; the cache;
  - the configuration, including that `local` is refused in production;
  - the readiness constant.
- **Run only by GitHub:** the database tests. They cover:
  - operator only;
  - refusals of keys that do not work;
  - versions and audit;
  - authenticator sign-ins before and after the key, with the key off and on again;
  - 503 for a new authenticator, webhook and SSO connection while the key is off;
  - another company is unaffected.
- **Not tested:**
  - a real key service;
  - documents and knowledge (not covered, see above);
  - the timing of a sign-in. The first authenticator sign-in of such a company after a restart asks the key service,
    which takes longer than for an unknown card. ASSUMPTION: this tells an observer at most that the card's company
    brought a key, and that the card exists. The cache shortens the window; measuring it needs a real key service.

## Confirmed by the founder (2026-10-22: the recommended defaults)

1. Secrets are covered first. Documents and knowledge come only after a separate design decision. **Until then,
   nobody may tell a customer "your data is under your key".**
2. The operator, not the company's Owner, sets the key.
3. Switching a key off may take up to 5 minutes to take effect.

Still open, because it needs a customer: which key service first (Google Cloud KMS fits the current hosting).
