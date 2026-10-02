# Runbook — recovering a locked-out Company Owner

**Who runs this:** a LegacyAI platform operator (today: the founder).
**When:** a customer's Company Owner cannot sign in — locked card, lost phone or passkey, or a card that expired past its grace period — and asks us for help.

## Why this is the operator's job

Inside a company, a card can only be unlocked, renewed, replaced or re-enrolled by someone who ranks **above** it. Nobody ranks above a Company Owner, and Owners deliberately cannot do these things to each other (each of them would hand one Owner a way into another Owner's card). So for an Owner, the only way back in is this procedure.

Everyone below an Owner (Admin, Expert, Successor) is recovered inside the company by an Owner or Admin. **Do not use this procedure for them** — the system refuses anyway.

## What the recovery does

One action, all-or-nothing:

- every strong factor (passkey / authenticator app) on the card is revoked;
- every session of the card ends;
- the Secret Code (SC) is replaced — the old one stops working;
- any lock is cleared; an expired card gets a new validity period;
- a new one-time **enrollment token** is created (valid 72 hours), so the Owner must enrol a **new** strong factor;
- the action is written to the customer's audit log as an **operator** action, to our own audit log, and to the card's history;
- every other Owner of that company is notified.

You receive the new SC and the enrollment token **once**. They are not stored in readable form and cannot be shown again.

## The danger, in plain words

The SC plus the enrollment token let whoever holds them enrol a factor and become that Owner. During the recovery **you** hold both. That is unavoidable — somebody has to hand the Owner a way back in — and it is why every step is recorded and the other Owners are told. It also means: **if you recover the wrong person, you have given a stranger a company's Owner account.** The identity check below is the control that matters. Do not skip it and do not shorten it.

## Step 1 — verify the person, out of band

"Out of band" means: through a channel the requester did not choose in this request.

1. Open a support case and note its id (for example `CASE-2026-000123`). You will need it in step 3.
2. **Call back** on a phone number that is in **our own** records for this customer from **before** the request arrived (contract, onboarding record). Never use a number or email address given in the request itself, and **never rely on the contact details stored in the product** (the person record there can be edited by another Owner of the same company).
3. On a video or voice call, confirm the person against what is on file: their name, the company, and the last four digits of their card number.
4. If the company has **another** Owner, contact that Owner as well and get their confirmation.
5. If the company has no other Owner, get confirmation from a second contact named in the customer's contract. If there is none, wait 24 hours after the call-back before going on, and tell the requester so.
6. Write in the case: who you spoke to, when, on which number, and what was confirmed. **Personal details stay in the case — never in the API request.**

If anything does not match, or you feel pushed to hurry: **stop.** Refusing a real Owner costs them a day. Recovering an impostor costs them their company's data.

## Step 2 — find the tenant and the card

Sign in to the API as the operator. You need the tenant id (from `GET /v1/tenants`) and either the Owner's **card number** — printed on their card; they read it to you during the call-back — or the card's id if you have it. The card must belong to that tenant; a number from another company is refused.

## Step 3 — run the recovery

```
POST /v1/tenants/{tenant_id}/owner-recovery
Idempotency-Key: <a fresh random key>

{ "card_number": "LGY-1234-5678-9012-3456", "verification_reference": "CASE-2026-000123" }
```

(Use `"card_id": "<id>"` instead of `card_number` if you have the id. Exactly one of the two.)

`verification_reference` is the **case id only** (letters, digits, `.`, `_`, `-`; 6–64 characters; not 16 digits in a row). The system rejects spaces, `@` and anything shaped like a card number — but it cannot tell a case id from a surname written without spaces, so **it is on you** to put only the case id there. It is copied into two audit logs that can never be edited.

Possible answers:

| Answer | Meaning |
|---|---|
| 201 | Done. The response contains the new `sc` and `enrollment_token` — shown once. `notified_owner_count` says how many other Owners were told. |
| 403 | You are not signed in as a platform operator. |
| 404 | No such tenant, or the card does not belong to it. Nothing was changed. |
| 400 / 422 | The request is malformed: no card named, both `card_id` and `card_number` given, or a reference that is not a plain case id. Nothing was changed. |
| 409 `not-an-owner-card` | The card is not a Company Owner's card. Recovery inside the company is the right path. |
| 409 `illegal-transition` | The card is suspended, revoked or replaced. A suspended Owner is reinstated by another Owner; a revoked or replaced card needs a new card, not a recovery. |

If the request times out, **send it again with the same Idempotency-Key**. It will not run twice. (The repeated answer does not show the secrets again; if you never received them, run a new recovery with a new key.)

## Step 4 — hand over, over two channels

Send the **SC** one way (for example read out on the verified phone call) and the **enrollment token** another way (for example the email address in our own contract record — not the one stored in the product). Someone who intercepts one channel cannot use it alone.

Then delete both from wherever you copied them.

## Step 5 — the Owner enrols a new factor

The Owner uses card number + new SC + enrollment token to enrol a passkey (or authenticator app, if the company allows it), then signs in normally. The token works once and expires after 72 hours. If it expires, run the procedure again from step 1.

## Step 6 — close the case

- Confirm with the Owner that they are signed in.
- Note in the case the time of the recovery. The audit entries can be found by the case id.
- If the Owner says they did **not** ask for this: treat it as an incident. Ask another Owner of the company to suspend the card at once. If there is no other Owner, verify the real Owner again (step 1) and run a new recovery — it revokes whatever factor was enrolled in the meantime. Then review the case.

## What the customer sees

- In their audit log: an entry `card:owner_recovery`, actor kind **operator**, with the case id.
- In the card's history: `owner_recovered`.
- A notification to the recovered Owner and to every other Owner. **Today notifications are written to the server log only — email delivery is not built yet.** Until it is, step 1.4 (contacting the other Owner yourself) is how the other Owners really learn about it.

## Related: renewing a company card

The company card is the customer's subscription clock. Only the operator can renew it (`POST /v1/tenants/{tenant_id}/company-card/renew`), and it is recorded the same way. When billing is built (Phase 4) it takes this over.

## If the locked-out person is you (the operator)

Operator cards follow the same rules: one operator cannot renew, unlock or re-enrol another, and the recovery endpoint refuses the operator tenant. For an operator card there is a **break-glass command** instead. It needs what the API itself runs with (database access and the secret keys), so only someone who already controls the deployment can use it:

```
cd services/api
npm run platform:recover-operator -- --card-number LGY-1234-5678-9012-3456
```

It does the same as an Owner recovery (old factors, sessions and SC are dead; new SC and a one-time enrollment token are printed once) and writes `card:owner_recovery` with actor `system` to the platform audit chain. To make it rare: renew the operator card before its 90 days are up, and enrol two passkeys on two devices.

## Known gaps

- **A missed renewal needs the full recovery.** An Owner can renew their own card only *before* it expires. After that, this procedure is the only way back, and it also wipes their passkeys. There is no lighter "just extend the Owner's card" action yet (decision for the founder in `REPORT.md`).
- **One operator can do this alone.** There is no second-person approval step in the system.
- **Email notification is not built** (see above).
- **This procedure has never been run against a deployed system.** The automated tests exercise the endpoint; the human steps are untested.
