# Decision log

Choices that would take more than about an hour to reverse. Three lines each. Evidence for versions is in `docs/DEPENDENCIES.md`. Status **PROPOSED** becomes **ACCEPTED** at Gate 1.

| # | Date | Status |
|---|---|---|
| D1–D12 | 2026-10-02 | PROPOSED (awaiting Gate 1) |

**D1 — Fastify 5, not NestJS.**
CONTEXT: NestJS 12 is 5 weeks old and no official LTS statement was found; rejected NestJS 11 (labelled `legacy` on npm) and NestJS 12.
CONSEQUENCES: module boundaries enforced by our own CI rule; one Fastify 6 upgrade expected in 2027.

**D2 — 60-day maturity rule for major versions.**
CONTEXT: alternative was "always latest". Rejected: a solo founder cannot debug a fresh ecosystem.
CONSEQUENCES: TypeScript 6.0, vitest 4, SimpleWebAuthn 13, Google provider 7; scheduled re-check each phase.

**D3 — No ORM; hand-written parameterised SQL with the `pg` driver.**
CONTEXT: rejected Prisma/Drizzle/TypeORM — row-level security, grants and triggers must be explicit.
CONSEQUENCES: more SQL to write and test; nothing hidden between the code and the database.

**D4 — dbmate for migrations.**
CONTEXT: rejected node-pg-migrate (JS-first), graphile-migrate (no down migrations), Flyway/Atlas (heavier).
CONSEQUENCES: plain SQL up/down files usable by both services; a small binary in CI and Docker.

**D5 — `openapi.yaml` drives runtime validation and generated types.**
CONTEXT: rejected generating the contract from code (the code would be the source of truth, not the file).
CONSEQUENCES: the contract must be written by hand first; drift is impossible rather than merely detected.

**D6 — Damm check digit; Luhn-valid numbers are regenerated.**
CONTEXT: rejected Luhn (misses 09↔90, looks like a payment card) and Verhoeff (same strength, more tables).
CONSEQUENCES: issued card numbers can never change algorithm without re-issuing cards.

**D7 — Strong factor is verified before the SC counts toward lockout; all factors in one request.**
CONTEXT: rejected SC-first (anyone could lock anyone out) and two-step verify (leaks which step failed).
CONSEQUENCES: TOTP-only users can be temporarily throttled by a stranger; passkey users cannot.

**D8 — Global `card_directory` reachable only through `SECURITY DEFINER` functions.**
CONTEXT: login must find the tenant before row-level security can apply; rejected a table readable by the app role.
CONSEQUENCES: two privileged functions to keep narrow and audited.

**D9 — Audit hash chain computed by a database trigger, verified independently in TypeScript.**
CONTEXT: rejected app-computed hashes (forkable under concurrency, forgeable by the app).
CONSEQUENCES: the hash encoding is a frozen format; changing it needs a versioned chain.

**D10 — Sessions: opaque token containing the tenant id, stored only as a SHA-256 hash.**
CONTEXT: rejected JWTs (cannot be revoked instantly) and a global sessions table (no row-level security).
CONSEQUENCES: every request costs one database read; revocation is immediate.

**D11 — Platform operator = a card in a special platform tenant.**
CONTEXT: rejected a static admin API key (bypasses the strong-factor rule). Open decision 2.
CONSEQUENCES: one bootstrap CLI; operators use the normal login path.

**D12 — Repository visibility: private, local only.**
CONTEXT: no remote exists; nothing is pushed by Claude.
CONSEQUENCES: before any future publication — secrets scan, full-history scan, and review of commit messages.
