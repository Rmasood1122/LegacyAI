// Notices by e-mail, in two halves.
//
// 1. MailNotifier wraps the notifier the product already has. Every notice is still written to the log exactly as
//    before; in addition it is put in the queue (`mail_notices`). Queuing never blocks or fails the caller: the
//    insert runs in the background on its own connection (a caller may still hold its transaction open - waiting
//    for a second connection there could exhaust the pool), and an error is logged, not thrown.
// 2. The delivery run (one company at a time) works out who receives each queued notice - from the company's
//    records AT THAT MOMENT, through the RecipientDirectory the identity module provides - and sends one message
//    per person. Addresses are read at send time and never stored here; a person without an address (or who has
//    left) gets status 'no_address'.
//
// Known and accepted: a notice raised inside a request that is rolled back afterwards is still queued. It names a
// card; if that card does not exist (it was never committed) nobody is found and nothing is sent; if it exists
// (e.g. a lock that was undone with the rest of the request), the e-mail may describe something that did not
// happen. The log notifier has always had the same behaviour. A message whose sender died mid-send is sent again
// after a minute (at least once, not exactly once).
import type { Database, Logger, NotificationEvent, Notifier, Tx } from '../../platform/index.ts';
import { MAIL_LIMITS, nextMailAttemptAt } from './rules.ts';
import { isSendableAddress, type MailOutcome, type MailSender } from './sender.ts';
import { isNoticeType, render, TEMPLATES } from './templates.ts';

/** Who is behind a notice, answered by the identity module (mail does not read cards or roles itself). */
export interface RecipientDirectory {
  /** People who hold the card (`audience: 'holder'`), or the company's Owners. Only people who have not left. */
  holderOf(tx: Tx, tenantId: string, cardId: string): Promise<string | null>;
  owners(tx: Tx, tenantId: string): Promise<string[]>;
  /** The person's e-mail address now, or null (none recorded, or the person has left). */
  addressOf(tx: Tx, tenantId: string, personId: string): Promise<string | null>;
}

export class MailNotifier implements Notifier {
  readonly #inner: Notifier;
  readonly #db: Database;
  readonly #log: Logger;
  readonly #pending = new Set<Promise<void>>();

  constructor(inner: Notifier, db: Database, log: Logger) {
    this.#inner = inner;
    this.#db = db;
    this.#log = log;
  }

  async notify(event: NotificationEvent): Promise<void> {
    await this.#inner.notify(event);
    const queued = this.#queue(event).catch((err: unknown) => {
      this.#log.error({ notification: event.type, tenant_id: event.tenantId, reason: err instanceof Error ? err.message.slice(0, 200) : 'unknown' },
        'mail: a notice could not be queued');
    }).finally(() => this.#pending.delete(queued));
    this.#pending.add(queued);
  }

  /** Waits until every notice raised so far is in the queue (the delivery job and the tests call it). */
  async flush(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all([...this.#pending]);
  }

  async #queue(event: NotificationEvent): Promise<void> {
    await this.#db.withTenantTx(event.tenantId, (tx) => tx.query(
      `INSERT INTO mail_notices (tenant_id, type, card_id, recipient_card_id, audience, about_tenant_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [event.tenantId, event.type, event.cardId ?? null, event.recipientCardId ?? null, event.audience ?? null, event.aboutTenantId ?? null]));
  }
}

interface NoticeRow { id: string; type: string; card_id: string | null; recipient_card_id: string | null; audience: string | null }

/** The people a notice goes to. Pure apart from the directory's answers. */
export async function recipientsOf(tx: Tx, tenantId: string, notice: NoticeRow, directory: RecipientDirectory): Promise<string[]> {
  if (!isNoticeType(notice.type)) return [];
  const audience = notice.audience === 'owners' ? 'owners' : TEMPLATES[notice.type].audience;
  const people = new Set<string>();
  if (audience === 'holder' || audience === 'both') {
    const card = notice.recipient_card_id ?? notice.card_id;
    const holder = card === null ? null : await directory.holderOf(tx, tenantId, card);
    if (holder !== null) people.add(holder);
  }
  if (audience === 'owners' || audience === 'both') {
    for (const owner of await directory.owners(tx, tenantId)) people.add(owner);
  }
  return [...people].sort();
}

export interface MailRunResult { notices: number; queued: number; sent: number; failed: number; no_address: number }

interface Claimed { id: string; notice_id: string; person_id: string; type: string; attempts: number }

export interface MailDeliveryDeps {
  sender: MailSender;
  directory: RecipientDirectory;
  from: string;
  withTx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

async function expand(tx: Tx, tenantId: string, directory: RecipientDirectory): Promise<{ notices: number; queued: number }> {
  const { rows } = await tx.query<NoticeRow>(
    `SELECT id, type, card_id, recipient_card_id, audience FROM mail_notices WHERE tenant_id = $1 AND expanded_at IS NULL
      ORDER BY created_at, id LIMIT $2 FOR UPDATE SKIP LOCKED`, [tenantId, MAIL_LIMITS.noticesPerRun]);
  let queued = 0;
  for (const notice of rows) {
    for (const personId of await recipientsOf(tx, tenantId, notice, directory)) {
      const res = await tx.query(
        `INSERT INTO mail_messages (tenant_id, notice_id, person_id) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, notice_id, person_id) DO NOTHING`,
        [tenantId, notice.id, personId]);
      queued += res.rowCount;
    }
  }
  if (rows.length > 0) await tx.query('UPDATE mail_notices SET expanded_at = now() WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [tenantId, rows.map((r) => r.id)]);
  return { notices: rows.length, queued };
}

async function claim(tx: Tx, tenantId: string, now: Date): Promise<Claimed[]> {
  await tx.query(
    `UPDATE mail_messages SET status = 'failed', locked_until = NULL, last_error = coalesce(last_error, 'timeout')
      WHERE tenant_id = $1 AND status = 'sending' AND locked_until <= $2 AND attempts >= $3`, [tenantId, now, MAIL_LIMITS.maxAttempts]);
  const { rows } = await tx.query<Claimed>(
    `UPDATE mail_messages m SET status = 'sending', locked_until = $2::timestamptz + interval '1 minute', attempts = m.attempts + 1
       FROM mail_notices n
      WHERE m.id IN (SELECT id FROM mail_messages WHERE tenant_id = $1
                        AND ((status = 'pending' AND next_attempt_at <= $2) OR (status = 'sending' AND locked_until <= $2))
                      ORDER BY next_attempt_at, id LIMIT $3 FOR UPDATE SKIP LOCKED)
        AND n.tenant_id = m.tenant_id AND n.id = m.notice_id
    RETURNING m.id, m.notice_id, m.person_id, n.type, m.attempts`, [tenantId, now, MAIL_LIMITS.perCompanyPerRun]);
  return rows;
}

async function record(tx: Tx, tenantId: string, m: Claimed, outcome: MailOutcome | 'no_address', now: Date): Promise<'sent' | 'failed' | 'no_address' | 'stale'> {
  // every update below applies only while this run still holds the message (its attempt count did not move on)
  if (outcome === 'no_address') {
    const res = await tx.query(`UPDATE mail_messages SET status = 'no_address', locked_until = NULL WHERE tenant_id = $1 AND id = $2 AND status = 'sending' AND attempts = $3`, [tenantId, m.id, m.attempts]);
    return res.rowCount === 0 ? 'stale' : 'no_address';
  }
  if (outcome.ok) {
    const res = await tx.query(`UPDATE mail_messages SET status = 'sent', sent_at = $4, locked_until = NULL, last_error = NULL WHERE tenant_id = $1 AND id = $2 AND status = 'sending' AND attempts = $3`, [tenantId, m.id, m.attempts, now]);
    return res.rowCount === 0 ? 'stale' : 'sent';
  }
  // a refused address is not tried again; a service that was unavailable or slow is
  const retryAt = outcome.error === 'rejected' ? null : nextMailAttemptAt(m.attempts, now);
  const res = await tx.query(
    `UPDATE mail_messages SET status = $4, next_attempt_at = coalesce($5, next_attempt_at), locked_until = NULL, last_error = $6 WHERE tenant_id = $1 AND id = $2 AND status = 'sending' AND attempts = $3`,
    [tenantId, m.id, m.attempts, retryAt === null ? 'failed' : 'pending', retryAt, outcome.error]);
  return res.rowCount === 0 ? 'stale' : 'failed';
}

/** One run for one company. A failed message never throws; a database error stops this company's run only. */
export async function runMailCompany(deps: MailDeliveryDeps, tenantId: string, now: () => Date): Promise<MailRunResult> {
  const result: MailRunResult = { notices: 0, queued: 0, sent: 0, failed: 0, no_address: 0 };
  const expanded = await deps.withTx((tx) => expand(tx, tenantId, deps.directory));
  result.notices = expanded.notices;
  result.queued = expanded.queued;
  const claimed = await deps.withTx((tx) => claim(tx, tenantId, now()));
  for (const m of claimed) {
    const address = await deps.withTx((tx) => deps.directory.addressOf(tx, tenantId, m.person_id));
    let outcome: MailOutcome | 'no_address';
    if (address === null || !isSendableAddress(address) || !isNoticeType(m.type)) {
      outcome = 'no_address';
    } else {
      const { subject, text } = render(m.type);
      outcome = await deps.sender.send({ id: `${m.notice_id}.${m.person_id}`, from: deps.from, to: address, subject, text })
        .catch((): MailOutcome => ({ ok: false, error: 'unavailable' }));
    }
    const done = await deps.withTx((tx) => record(tx, tenantId, m, outcome, now()));
    if (done === 'sent') result.sent += 1;
    if (done === 'failed') result.failed += 1;
    if (done === 'no_address') result.no_address += 1;
  }
  return result;
}
