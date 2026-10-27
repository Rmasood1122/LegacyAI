# Runbook: a company's own key — switched off, back on, changed, cleared, destroyed

For the platform operator. Decision D41 (`docs/phase4/10-content-under-company-key.md`, step 7) and feature 21
(`docs/phase4/08-bring-your-own-key.md`). Plain steps; nothing here needs anyone to read a company's content.

## What the company's key locks

A company that brought its own key (at its own Google Cloud KMS) has these locked with a data key that only its key
can open:

- its documents (the text, the search copies and their vectors) and their titles;
- its knowledge items (titles and every version's text), interview questions and answers, questions people asked,
  questions to experts, readers' comments, the words a stored conflict quotes, readiness questions and answers,
  scenario texts and answers, topic names and descriptions;
- the secrets the API keeps for it: authenticator-app seeds, webhook signing secrets, SSO client secrets.

Not locked by it: ids, labels, dates, counts and sizes, who did what and when, the audit log, people and cards. A
company without a key of its own has the same content locked with a data key wrapped by the platform's content key
(Terraform: `google_kms_crypto_key.content_platform`), which only the AI service's account may use.

**Both service accounts need the role.** The company grants **Cloud KMS CryptoKey Encrypter/Decrypter** on its key
to the API's service account (secrets) **and** to the AI service's (documents and knowledge). With only the API's,
secrets work and every screen that needs the company's content answers "the company's key cannot be used".

## How you notice

- **People** see, on every screen that needs the company's content: *"The company's own encryption key cannot be
  used right now"* (HTTP 503, problem type `company-key-unavailable`). Screens that need no content (people, cards,
  the audit log) keep working. Sign-in with a passkey keeps working; sign-in with an authenticator app,
  SSO sign-in and webhook deliveries of that company stop.
- **Housekeeping** (`npm run housekeeping`, under `knowledge`): `seal_key_unavailable` counts companies whose current
  key cannot be used; `old_key_unavailable` counts companies whose content is still on an old key that cannot be
  used.
- **The AI service's log** has the warning `content key unavailable` with the request's path (no content, no key name).

The AI service and the API keep an opened data key for at most **5 minutes**. Switching a key off takes effect
within 5 minutes; switching it back on takes effect at the next request.

## 1. The key is switched off (or its permission removed)

Expected when the company does it on purpose; nothing is lost.

1. Ask the company whether it was on purpose. If not: check the key version is **enabled** in the company's KMS and
   that both service accounts still have the role (above).
2. Nothing to do on our side. While it is off, nothing new is added for the company either (nothing is ever locked
   with the platform's key instead).
3. When it is back on, run housekeeping once: rows that waited (`seal_key_unavailable`) are locked then.

## 2. The company changes to another key, or clears its key (back to none)

The operator does this at the company's request (`PUT /v1/tenants/{tenant_id}/encryption-key`, see the feature-21
note). From that moment new content is locked with the new key (or the platform's), but what was locked before is
still on the OLD key.

1. **Tell the company: keep the old key enabled, with both roles, until step 3 says 0.** Destroying it earlier loses
   what is still on it, for good.
2. Run housekeeping until every `old_key_*` number is 0 (each run does a bounded amount). See
   `docs/runbooks/housekeeping.md`, "Locking again after a company clears or changes its own key".
3. **Secrets are not moved by housekeeping.** Authenticator apps, webhook secrets and SSO secrets set up under the old
   key keep needing it. Before the company retires the old key: each person sets up the authenticator app again (or
   uses a passkey), the Owner rotates each webhook secret and saves the SSO secret again.
4. Only then may the company disable or destroy the old key version.

## 3. The key is destroyed

Google keeps a destroyed key version **scheduled for destruction for 30 days by default** and it can be restored in
that time; after that, nothing encrypted with it can be decrypted
([Google: destroy and restore key versions](https://cloud.google.com/kms/docs/destroy-restore), read 2026-10-27).

1. **Within the waiting period:** if it was a mistake, the company restores the key version in its KMS and enables
   it. Everything comes back (case 1).
2. **After it:** everything locked with that key is gone for good - in the database and in every backup (backups hold
   only the locked values and the wrapped data keys). Nobody here can open it, including the platform operator. Ids,
   labels, dates, counts and the audit log stay until the company is deleted.
3. If the company did this to erase its content, tell it what stays (point 2) and offer to delete the company if it
   wants those gone too.
4. If it was a mistake: say so plainly. There is no way back. A backup does not help.

## 4. Backups and restore

- A backup (`scripts/backup.sh`) holds what the database holds: locked values stay locked, and data keys are stored
  only wrapped. **A backup opens only while the keys that wrapped them still work** - the company's own key, or the
  platform's content key for everyone else. **Never destroy the platform's content key** (Terraform refuses to:
  `prevent_destroy`): every company without its own key would lose its content, including in every backup.
- `scripts/restore-test.sh` checks that a restore brings back every row, forced row-level security and the audit
  triggers. **ASSUMPTION, not tested end to end:** that the restored locked values open with the same keys. Nothing in
  a restore changes a locked value or a wrapped key, and every locked value is bound to its company and row, which
  the restore keeps; a restore into a database where the company has other ids would not open.

## 5. The platform's own content key

If the AI service cannot use the platform's content key (permission removed, key version disabled), every company
without its own key behaves as in case 1, at once for all of them. Check the key version is enabled and that the AI
service's account has the role (`google_kms_crypto_key_iam_member.content_platform_ai`). Terraform is applied by hand
by the founder; this runbook changes nothing in the cloud.
