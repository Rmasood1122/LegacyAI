# Completing the 35 features — plan

> Written 2026-10-04 after the founder's instruction "complete all features". **A plan; nothing in it is built yet
> unless a later report says so.** Source of truth for the features: `docs/feature-list-35.md`.

## Where we stand

Built and tested (backend, screens, container image; nothing deployed): features 1, 2, 3, 10, 12, 13, 14, 15, 17,
18, 19, 20, 24 in full for the pilot scope, and the first part of 4 (digital card), 5 (limits and history),
7 (text interviewer), 22 (answer log only), 25 (text and PDF), 29 (admin console and API), 30 (export and backup),
34 (the identity side of renewal).

Missing, whole or in part: **4** (QR, NFC), **5** (anomaly lock), **6**, **7** (voice), **8**, **9**, **11**, **16**,
**21**, **22** (the monitor itself), **23**, **25** (OCR, voice, drawings, languages), **26**, **27**, **28**,
**29** (billing), **30** (knowledge graph), **31**, **32**, **33**, **34** (billing trigger), **35**.

## The rules do not change

$0 spend; no real account touched; no paid AI call without the founder's word; synthetic data only; no new backend
service (the limit of five stays); every claim backed by a test or labelled; a design review and, for anything
touching permissions or personal data, an independent security read before each push.

## Three batches, by what each feature needs

### Batch A — needs nothing from outside (start now)

| # | Feature | What will be built | Honest limit |
|---|---|---|---|
| 23 | Contradiction and staleness detection | A check in code that finds verified items and passages giving different values for the same thing, opens a review task, and makes the answer refuse; staleness sweep and screen | Rule-based detection finds numeric and yes/no conflicts, not every contradiction in prose. This is also the second line of defence against the weakness the evaluation measured (2 of 8 conflict questions answered from one side) |
| 22 | Answer quality monitor | Counts and trends from the answer log: refusals by reason, citations removed, feedback from readers ("this was wrong"), per week; a screen | It reports what was logged; it cannot know whether an answer was true |
| 5 | Anomaly lock | Rules on card use (many refusals, impossible travel between addresses, use outside set hours) that lock a card and open a task | Simple rules, not learning; false alarms are possible, so a lock is reversible by an admin |
| 11 | Retirement radar | Planned leaving date per person; nudges at 24, 12 and 6 months as tasks and in-app notices; what knowledge is still uncaptured for that person | Notices inside the product only until e-mail delivery exists (Batch B) |
| 26 | Department templates | Ready-made topic lists and job-role maps per department type that an admin can apply and then edit | The templates are written by us, not validated by an industry expert |
| 27 | Outcome analytics | Captured, verified, asked, answered, time to verify, readiness results over time; a screen and export | Activity numbers, not business outcomes; no claim about money saved |
| 30 | Knowledge graph | Items, topics, sources, people and job roles as a graph that can be browsed and exported in an open format | Derived from links that already exist; no automatic discovery of new relations |
| 8 | Scenario replay | A reviewer writes a "what would you do if..." scenario from verified items; a learner answers it step by step; graded like the readiness test | Text only |
| 4 | QR format | The card shown as a QR code that opens the sign-in screen with the card number filled in (never the secret code) | NFC needs hardware and is in Batch C |

### Batch B — can be built and tested with stand-ins, but going live needs a decision from the founder

| # | Feature | Built with a stand-in | Decision needed before it is real |
|---|---|---|---|
| 29, 31, 32, 33, 34, 35 | Billing, renewal center, one renewal date, reminders and auto-renew, renewal with code rotation, upgrade prompts | Plans, seats, invoices and renewal logic against a fake payment provider; screens | Which payment provider, prices, and a real merchant account |
| 28 | Open API, webhooks, connectors | API keys for machines, signed webhooks from the existing outbox, one example connector | Which outside systems matter first |
| 16 | SSO and SCIM | Sign-in through a company's identity provider and automatic user provisioning, tested against a fake provider | Which providers to support; a real test tenant |
| 21 | Bring-your-own-key | Per-company encryption key reference and the code path, tested with a local key | A real key service; regional hosting is infrastructure and belongs to deployment |
| 11, 33 | E-mail delivery of nudges and reminders | A mail interface with a fake sender | Which e-mail service and sending domain |

### Batch C — needs money, hardware, new AI models or legal advice

| # | Feature | Why it cannot be finished at $0 |
|---|---|---|
| 7, 25 | Voice interviewer; voice, scanned documents (OCR), drawings, other languages | Speech and image models cost money or need a much larger machine; each needs its own measured evaluation |
| 6 | Passive capture from chats, tickets and e-mail | Reads people's communications: the feature list itself says it needs consent design and **legal review** first; also real accounts at those systems |
| 9 | Shadow mode (offline, frontline) | An offline app for phones or tablets is a product of its own |
| 4 | NFC cards | Physical cards and readers |
| 21 | Regional hosting | Real cloud resources in several regions |

For Batch C the code can be prepared up to an interface with a fake behind it, so that the missing piece is one
adapter. That would be "prepared", not "complete", and will be labelled so.

## Order of work

1. Batch A in this order: 23 and 22 together (they fix the measured weakness), then 5, 11, 26, 27, 30, 8, 4.
2. Batch B: billing group first, then 28, 16, 21.
3. Batch C preparations last.

Each step: design note → build with tests → design reviews → security read where relevant → CI green → a report in
`docs/phase4/` saying what was measured and what was not.

## What "complete" will honestly mean at the end

- Batch A: complete within the stated limits.
- Batch B: complete against stand-ins; not usable with real money, real identity providers or real e-mail until the
  founder chooses providers and creates accounts.
- Batch C: prepared, not complete.

## Decisions the founder can make at any time (none blocks Batch A)

1. Payment provider and prices (Batch B, billing).
2. E-mail service (Batch B).
3. Which identity providers to support (Batch B).
4. Whether to spend on voice and OCR models, and how much (Batch C).
5. Legal review for passive capture (Batch C).
