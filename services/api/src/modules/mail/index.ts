// PUBLIC SURFACE of the mail module (Phase 4, part C of docs/phase4/06-open-api-webhooks-email.md; features 11 and
// 33 are the first users: their notices - retirement nudges, renewal reminders - now also go out by e-mail).
//
// What it does: when an e-mail sender is configured, every notice the product raises is queued as well as logged,
// and the delivery run sends it, as fixed plain text, to the people the notice is for. What it does NOT do: connect
// a real e-mail service (MAIL_SENDER is 'none' or the test stand-in 'fake'); store addresses (they are read when a
// message is sent); send anything a company wrote, a code, a key or a link.
//
// Nothing here imports another feature module: who receives a notice comes through the RecipientDirectory port,
// which the identity module implements and app.ts connects.
import type { Config, Database, Logger, Notifier, Tx } from '../platform/index.ts';
import { MailNotifier, runMailCompany, type MailRunResult, type RecipientDirectory } from './internal/queue.ts';
import { FakeMailSender, type MailSender } from './internal/sender.ts';

export { MAIL_LIMITS, nextMailAttemptAt } from './internal/rules.ts';
export { FakeMailSender, isSendableAddress, type MailMessage, type MailOutcome, type MailSender } from './internal/sender.ts';
export { isNoticeType, render, TEMPLATES, type Audience, type NoticeType, type Template } from './internal/templates.ts';
export { recipientsOf, type MailRunResult, type RecipientDirectory } from './internal/queue.ts';

export interface MailModule {
  /** Whether notices are queued and sent at all (MAIL_SENDER, or a sender given by a test). */
  readonly enabled: boolean;
  /** The notifier the rest of the product uses: the given one, plus the queue when mail is enabled. */
  readonly notifier: Notifier;
  /** Must be set before the first delivery run. */
  useDirectory(directory: RecipientDirectory): void;
  /** One delivery run for one company. All zeros when mail is switched off. */
  runCompany(tenantId: string, now?: () => Date): Promise<MailRunResult>;
  /** Waits until every notice raised so far is queued. */
  flush(): Promise<void>;
  /** Housekeeping: notices and finished messages older than `before` are removed. */
  purge(tx: Tx, tenantId: string, before: Date): Promise<number>;
}

export function createMail(deps: {
  config: Config; db: Database; log: Logger; notifier: Notifier;
  /** For tests: a stand-in sender. Default: what MAIL_SENDER names ('none' = nothing; 'fake' = the stand-in). */
  sender?: MailSender;
}): MailModule {
  const sender: MailSender | null = deps.sender ?? (deps.config.mail.sender === 'fake' ? new FakeMailSender() : null);
  const queue = sender === null ? null : new MailNotifier(deps.notifier, deps.db, deps.log);
  let directory: RecipientDirectory | null = null;
  return {
    enabled: sender !== null,
    notifier: queue ?? deps.notifier,
    useDirectory: (d) => {
      directory = d;
    },
    runCompany: async (tenantId, now = () => new Date()) => {
      if (sender === null || queue === null) return { notices: 0, queued: 0, sent: 0, failed: 0, no_address: 0 };
      if (directory === null) throw new Error('mail: no recipient directory was connected');
      await queue.flush();
      return runMailCompany({ sender, directory, from: deps.config.mail.from, withTx: (fn) => deps.db.withTenantTx(tenantId, fn) }, tenantId, now);
    },
    flush: async () => {
      await queue?.flush();
    },
    purge: async (tx, tenantId, before) => {
      const messages = await tx.query(
        `DELETE FROM mail_messages WHERE tenant_id = $1 AND created_at < $2 AND status IN ('sent', 'failed', 'no_address')`, [tenantId, before]);
      const notices = await tx.query(
        `DELETE FROM mail_notices n WHERE tenant_id = $1 AND created_at < $2 AND expanded_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM mail_messages m WHERE m.tenant_id = n.tenant_id AND m.notice_id = n.id)`, [tenantId, before]);
      return messages.rowCount + notices.rowCount;
    },
  };
}
