// The e-mail service the founder chose: Resend (decision D36, docs/phase4/06, part C). One message = one HTTPS request
// to Resend's sending address (https://resend.com/docs/api-reference/emails/send-email, read 2026-10-22):
//
//   POST https://api.resend.com/emails
//   Authorization: Bearer <RESEND_API_KEY>          the key comes from the configuration (Secret Manager); never logged
//   Idempotency-Key: <message id>                   Resend sends a message once per key for 24 hours, so a retry of a
//                                                   message it already accepted is not sent twice (our retries end
//                                                   about 15 hours after the first attempt: rules.ts)
//   { from, to: [one address], subject, text }      plain text only, as every notice is
//
// What an answer means (https://resend.com/docs/api-reference/errors, read 2026-10-22):
//   2xx                                  sent
//   400, 422; 409 invalid_idempotent_request
//                                        this message cannot be sent as it is: 'rejected', not tried again
//   401, 403 (key or sending domain), 404, 405
//                                        OUR set-up is wrong, not the address: 'unavailable' (tried again, so that the
//                                        messages go out once the operator fixes it) and a warning in the log
//   409 (another request with the key in progress), 429, 5xx, no answer
//                                        'unavailable'; no answer in time: 'timeout'
//
// The request goes through the platform's guarded HTTPS client (outbound.ts): public addresses only, certificate
// checked, no redirect followed, one deadline, a size limit on the answer.
import { httpsRequest, type HttpsOptions, type HttpsResponse, type Logger, type Secret } from '../../platform/index.ts';
import type { MailMessage, MailOutcome, MailSender } from './sender.ts';

export const RESEND_URL = 'https://api.resend.com/emails';

/** How one answer from Resend is counted, and what (if anything) the operator should hear about it. Pure. */
export function resendOutcome(response: HttpsResponse): { outcome: MailOutcome; problem: string | null } {
  if (!response.ok) {
    if (response.error === 'timeout') return { outcome: { ok: false, error: 'timeout' }, problem: null };
    return { outcome: { ok: false, error: 'unavailable' }, problem: `no answer (${response.error})` };
  }
  const { status } = response;
  if (status >= 200 && status < 300) return { outcome: { ok: true }, problem: null };
  const code = errorName(response.body);
  const problem = `HTTP ${status}${code === null ? '' : ` ${code}`}`;
  if (status === 400 || status === 422 || (status === 409 && code === 'invalid_idempotent_request')) {
    return { outcome: { ok: false, error: 'rejected' }, problem };
  }
  // 409 in progress, 429 and 5xx are passing; 401/403/404/405 are our set-up and are logged so that somebody fixes it
  const passing = status === 409 || status === 429 || status >= 500;
  return { outcome: { ok: false, error: 'unavailable' }, problem: passing ? null : problem };
}

/** Resend's error name (`validation_error`, ...): a fixed word, never its message, which can carry an address. */
function errorName(body: Buffer): string | null {
  try {
    const name = (JSON.parse(body.toString('utf8')) as { name?: unknown }).name;
    return typeof name === 'string' && /^[a-z_]{1,64}$/.test(name) ? name : null;
  } catch {
    return null;
  }
}

export class ResendMailSender implements MailSender {
  readonly name = 'resend';
  readonly #apiKey: Secret;
  readonly #log: Logger;
  readonly #url: string;
  readonly #http: HttpsOptions;

  constructor(deps: {
    apiKey: Secret; log: Logger;
    /** Tests only: a stand-in for Resend (its address, and the test resolver / authority of HttpsOptions). */
    url?: string; http?: Partial<HttpsOptions>;
  }) {
    this.#apiKey = deps.apiKey;
    this.#log = deps.log;
    this.#url = deps.url ?? RESEND_URL;
    this.#http = { timeoutMs: 10_000, maxBytes: 64 * 1024, ...deps.http };
  }

  async send(message: MailMessage): Promise<MailOutcome> {
    const response = await httpsRequest({
      url: this.#url,
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#apiKey.reveal()}`,
        'content-type': 'application/json',
        'idempotency-key': message.id.slice(0, 256),
      },
      body: JSON.stringify({ from: message.from, to: [message.to], subject: message.subject, text: message.text }),
    }, this.#http);
    const { outcome, problem } = resendOutcome(response);
    // the message id and Resend's answer code only: no address, no text, no key
    if (problem !== null) this.#log.warn({ mail_message: message.id, resend: problem }, 'mail: Resend did not take a message');
    return outcome;
  }
}
