// The e-mail service as the mail module sees it. The founder chose Resend (resend.ts, decision D36); the sending
// domain (SPF, DKIM, DMARC) is set up in the founder's Resend account (docs/phase4/06). Another service would be one
// more MailSender; the callers do not change.
//
// FakeMailSender sends NOTHING: it keeps the messages in memory so that tests can read them. The configuration
// accepts it only when NODE_ENV=test.

export interface MailMessage {
  /** Stable per recipient and notice: a service that de-duplicates can use it, and a retry carries the same one. */
  id: string;
  from: string;
  to: string;
  subject: string;
  text: string;
}

export type MailOutcome = { ok: true } | { ok: false; error: 'rejected' | 'unavailable' | 'timeout' };

export interface MailSender {
  readonly name: string;
  send(message: MailMessage): Promise<MailOutcome>;
}

export class FakeMailSender implements MailSender {
  readonly name = 'fake';
  readonly sent: MailMessage[] = [];
  #failures: Array<'rejected' | 'unavailable' | 'timeout'> = [];

  /** The next sends fail with these errors, in order (tests of retries). */
  failNext(...errors: Array<'rejected' | 'unavailable' | 'timeout'>): void {
    this.#failures.push(...errors);
  }

  async send(message: MailMessage): Promise<MailOutcome> {
    const error = this.#failures.shift();
    if (error !== undefined) return { ok: false, error };
    this.sent.push(message);
    return { ok: true };
  }
}

/** An address the sender may be given: one line, one @, no spaces or angle brackets. Pure. */
export function isSendableAddress(address: string): boolean {
  return address.length <= 254 && /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/.test(address);
}
