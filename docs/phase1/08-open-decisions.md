# 08 — Open decisions

> **Status: all eight recommendations were ACCEPTED at Gate 1** (the founder replied "approved" on 2026-10-02). They are implemented as recommended. Decisions that came up *during* the build are in `REPORT.md` under "Decisions I need from the founder".

Eight decisions I need from you. For each: the question in plain language, my recommendation, and what it costs if we get it wrong. **If you just reply "approved", I will go with every recommendation below.**

---

## 1. What is the company card *for*?

**The question.** Every person gets a card to log in with. Every company also gets a card and an SC — but a company cannot hold a phone or a passkey. So what does the company card do?

**Recommendation.** In Phase 1 the company card is the company's **identity and subscription clock**, not a login. It is issued when the tenant is created, has a number and an SC, expires and renews like any card, and **nobody can log in with it**. When the company card expires, the whole tenant goes read-only for the 14-day grace period; renewing it (the Phase 4 billing trigger) restores everything. People always log in with their own person card.

**Cost of being wrong.** Low now, medium later. If you intended the company card to be a shared login, that conflicts with the security rule (a shared card cannot have a personal strong factor) and with the audit log (we could not say *who* did something). Changing its meaning after customers exist would need a data migration.

---

## 2. How do LegacyAI's own operators create and manage tenants?

**The question.** Someone at LegacyAI (you) must be able to create a new customer. That is a power no customer role should have. How do you prove you are the operator?

**Recommendation.** A special **platform tenant** that represents LegacyAI itself. You hold a normal card in it and log in the normal way (card + SC + passkey). Only cards in that tenant can use `tenant:create` and `tenant:list`. It is created once by a command-line tool. No master password, no special API key, no ninth role — the same audited login path as everyone else.

**Cost of being wrong.** Medium. The alternative — a static "admin API key" — is simpler but is a single secret that grants everything and bypasses the strong-factor rule. If the platform-tenant approach proves awkward it can be replaced without touching customer data.

---

## 3. Passkey as the default, authenticator app as the fallback?

**The question.** Both passkeys and authenticator-app codes count as the strong factor. Which do we steer people to?

**Recommendation.** **Passkey by default, authenticator app allowed as a fallback** (a per-tenant setting can switch either off). Reasons: passkeys cannot be phished and cannot be guessed, so a stranger who knows a card number can do nothing to a passkey user. Authenticator codes can be phished in real time, and a stranger can temporarily pause a TOTP-only user's login by guessing (see `03` §4).

**Cost of being wrong.** If you require passkeys only: some experts close to retirement may have older devices and be unable to enrol — a support burden and a pilot blocker. If you allow TOTP only: weaker against phishing. Allowing both with passkey preferred is the lowest-regret choice and fully reversible.

---

## 4. If the only Company Owner is locked out, who lets them back in?

**The question.** Unlocking a card needs another Owner or Admin. A small company may have exactly one.

**Recommendation.** (a) The product **warns** when a tenant has fewer than two cards able to unlock others. (b) Last-resort recovery is a **manual procedure by the platform operator**: verify the person out-of-band (a call to a number on file), then issue a reset from the platform tenant; fully audited in both tenants. Phase 1 builds the mechanism and writes the runbook; the identity-verification step is a human process you own.

**Cost of being wrong.** High either way. Too easy → the recovery path becomes the way attackers get in ("hello, I'm the owner, I lost my phone"). Too hard → a paying customer is permanently locked out of their own data. This is a business-process decision more than a technical one.

---

## 5. What should a card number look like?

**The question.** Your two documents disagree. The Phase 1 prompt says 15 random digits + 1 check digit shown in groups of four — `4821 9376 0152 7730` — which is exactly the shape of a bank card. Your feature list shows `LGY-4821-9376-0152` (a prefix and 12 digits) and says "do not make the format look like a bank card".

**Recommendation.** Keep the prompt's **16 digits** (15 random + 1 Damm check digit) but **always display them with the `LGY-` prefix and dashes: `LGY-4821-9376-0152-7730`**. The prefix is display-only; people may type the number with or without it. Together with the Damm check digit and the rule that we never issue a number that passes the bank-card (Luhn) check, no LegacyAI card can validate as a payment card.

**The alternative.** 12 digits as in your example (`LGY-4821-9376-0152`): shorter to type on a shop-floor kiosk, and still 100 billion possible numbers. Because the card number is an identifier and not a secret, 12 would be acceptable. Say "12 digits" at Gate 1 if you prefer it.

**Cost of being wrong.** Medium. The length is baked into every issued card, printed badge and QR code. Changing it after cards are issued means re-issuing them. Changing only the display (prefix, dashes) is free.

---

## 6. Lock the audit-anchor bucket permanently?

**The question.** Google Cloud Storage can enforce "nobody may delete or change these files for N days". It can also **lock** that rule so that nobody — not you, not Google support — can ever shorten or remove it. Locking is irreversible.

**Recommendation.** **Not locked during the pilot** (retention on, lock off). Lock it before the first paying customer or the first audit that relies on it. The Terraform has a switch, default off.

**Cost of being wrong.** Unlocked: a project administrator could remove the retention rule and then delete anchors, so the "write-once" claim is weaker — which is why we will only say "write-once-*style*" until it is locked. Locked too early: a mistake in bucket naming or retention length is permanent, and the bucket cannot be deleted until every object ages out (you keep paying for storage, though at kilobyte scale that is effectively nothing).

---

## 7. Fastify instead of NestJS, and "one major behind" for brand-new libraries — accepted?

**The question.** The prompt said NestJS was provisional. Two things I want you to explicitly accept.

**Recommendation.** (a) **Fastify 5** rather than NestJS: NestJS 12 was released five weeks ago with a major internal change, and I could not find any official statement of which NestJS line is "Active LTS"; Fastify 5 has two years of stability and a written support policy. (b) The **60-day maturity rule**: where a library's newest major version is under 60 days old (or other tools do not support it yet), use the previous one. That is why we use TypeScript 6.0 not 7.0, vitest 4 not 5, SimpleWebAuthn 13 not 14, and Google's Terraform provider 7 not 8. Full evidence in `docs/DEPENDENCIES.md`.

**Cost of being wrong.** Low to medium. Fastify gives us less ready-made structure, so module boundaries are enforced by our own CI rule rather than by the framework. Fastify 6 will arrive at some point and require an upgrade (budget a day or two in 2027). If you later hire developers who prefer NestJS, it can run on top of Fastify, so the HTTP layer is not thrown away.

---

## 8. Is "every decision is audited" allowed to mean every *read* as well?

**The question.** The prompt says every allow and deny is written to the audit log. Taken literally, every page view writes a permanent row. Audit rows can never be deleted, and Neon's free database holds about 0.5 GB.

**Recommendation.** **Yes for Phase 1 — log everything, literally as specified**, and measure the real row size and growth in Step 5. Before real traffic, choose one of: (a) move to Neon's paid plan (first non-zero cost — see `06`), (b) archive old audit segments to the write-once bucket with their chain hashes and keep only recent rows in the database, or (c) record low-risk reads in batches. I recommend (b) when the time comes, because it keeps the full trail and stays cheap.

**Cost of being wrong.** If we log less now: gaps in the trail that an enterprise buyer or auditor will ask about, and that can never be filled in afterwards. If we log everything and do nothing: the free database fills (EST around a million audited requests) and **writes stop** — an outage. That is why the storage level appears in `GET /v1/tenants/current/usage` and in the readiness report.

---

## Not decisions, but things you should know

- **Your feature list has 30 features; the prompt says 35** and mentions a "feature 34". I mapped the prompt's numbers onto the 30 (table at the top of `07-feature-map.md`). Tell me if a 35-item list exists.
- **Expired cards look like any other failed sign-in**, exactly as the prompt requires. A genuine user will not be told why; we rely on notifications before expiry. Worth revisiting after the pilot.
- **Your list calls the audit log "tamper-proof".** What can honestly be delivered is tamper-evident. Please use that wording with buyers.
- **Your list's first build group includes SSO/SCIM (16) and the answer quality monitor (22).** The prompt forbids both in Phase 1, so they are not built now.
- **Legal review** of consent for capturing employee communications is untouched by Phase 1 (no capture is built), but it gates Phase 2.
- **Neon's free plan and commercial use:** third-party pages say it is allowed; please read Neon's terms yourself before the first paying customer.
- **A Google Cloud billing account needs a payment card** even for $0 usage.
