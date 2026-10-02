# LegacyAI — the 35 features (source of truth) and proposed delivery phase

Phase key: P1 Foundation · P2 Core value (capture, AI, verification) · P3 Frontend · P4 Revenue · P5 Production readiness · LATER = after the pilot.
"hook" = schema/design only, no working feature.

## Access Card system
| # | Feature | Phase |
|---|---|---|
| 1 | Unique cards (person + company, check digit, SC) | P1 |
| 2 | Role-based access (8 roles; 4 enabled for pilot) | P1 |
| 3 | Card lifecycle: issue, suspend, revoke, expire, replace | P1 |
| 4 | Digital, QR and NFC formats | digital: P1/P3 · QR/NFC: LATER (hook in P1) |
| 5 | Card-level limits, usage history, anomaly lock | limits + history: P1 · anomaly lock: LATER |

## Capture
| # | Feature | Phase |
|---|---|---|
| 6 | Passive expertise capture (chats, tickets, email) | LATER (needs consent + legal review) |
| 7 | Adaptive AI voice interviewer | text interviewer: P2 · voice: LATER |
| 8 | Scenario replay mode | LATER |
| 9 | Shadow mode (offline, frontline) | LATER |
| 10 | Gap detector | P2 (simple version) |
| 11 | Retirement radar (24/12/6-month nudges) | LATER (needs reminders from P4) |

## Proof
| # | Feature | Phase |
|---|---|---|
| 12 | Expert verification loop | P2 |
| 13 | Readiness test for successors | P2 |
| 14 | Source-cited answers that say "I don't know" | P2 |
| 15 | Ask-the-expert mode | P2 |

## Security
| # | Feature | Phase |
|---|---|---|
| 16 | SSO + SCIM provisioning | LATER (hook in P1) |
| 17 | Permission-aware answers (enforced at retrieval) | filter: P1 · retrieval wiring: P2 |
| 18 | Sensitive-data redaction | P2 (basic) |
| 19 | Expert consent and ownership controls | P2 |
| 20 | Tamper-evident audit log | P1 |
| 21 | Regional hosting and bring-your-own-key | LATER (hook in P1) |

## Quality
| # | Feature | Phase |
|---|---|---|
| 22 | Answer quality monitor | LATER (basic logging in P2) |
| 23 | Contradiction and staleness detection | LATER |
| 24 | Human review queue | P2 |
| 25 | Multi-language and multi-format (OCR, voice, drawings) | text + PDF: P2 · rest: LATER |

## Business
| # | Feature | Phase |
|---|---|---|
| 26 | Department templates | LATER |
| 27 | Outcome analytics | LATER (events table in P1) |
| 28 | Open API, webhooks, connectors | LATER (outbox hook in P1) |
| 29 | Multi-tenant admin console and billing | API: P1 · screens: P3 · billing: P4 |

## Lock-in
| # | Feature | Phase |
|---|---|---|
| 30 | Living knowledge graph + open-format export + disaster recovery | export + backup: P1 · graph: LATER |

## Billing
| # | Feature | Phase |
|---|---|---|
| 31 | Renewal center | P4 |
| 32 | One company-wide renewal date | P4 |
| 33 | Expiry reminders and optional auto-renew | P4 |
| 34 | Renewal with SC rotation | identity side: P1 · billing trigger: P4 |
| 35 | Upgrade prompts at card limits | P4 |