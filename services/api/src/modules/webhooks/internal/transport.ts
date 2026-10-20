// Sending one webhook message. The port is what the delivery job sees; HttpsTransport is the one real sender.
//
// HttpsTransport (node:https only - no new library):
//   - looks the host name up, refuses it unless EVERY address is public (address.ts), and connects to the address
//     it checked: the lookup is pinned, so the name cannot be re-pointed between the check and the connection;
//   - verifies the TLS certificate against the host name (node's default; never switched off);
//   - follows no redirect (a 3xx is a failed attempt);
//   - gives up after a few seconds in all - the name lookup included - and closes the connection as soon as the
//     status line has arrived: only the status code counts, the body is never read, and nothing a receiver sends
//     back is stored or shown (a receiver that trickles a body cannot keep the delivery job waiting).
import { lookup as dnsLookup } from 'node:dns/promises';
import { request } from 'node:https';
import type { LookupAddress } from 'node:dns';
import { checkedAddress, isPublicAddress, type ResolvedAddress, type Resolver } from './address.ts';
import { WEBHOOK_LIMITS } from './rules.ts';

export interface WebhookRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
  body: string;
}

export type SendError = 'address_refused' | 'dns' | 'connect' | 'tls' | 'timeout' | 'http_status';
export type SendOutcome = { ok: true; status: number } | { ok: false; error: SendError; status?: number };

export interface WebhookTransport {
  readonly name: string;
  send(req: WebhookRequest): Promise<SendOutcome>;
}

const systemResolver: Resolver = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));

const TLS_ERROR = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|ERR_CERT)/;

function classify(err: unknown): SendError {
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && TLS_ERROR.test(code)) return 'tls';
  if ((err as Error).message === 'timeout') return 'timeout';
  return 'connect';
}

export interface HttpsTransportOptions {
  /** Tests only: a resolver for test host names. Default: the system's. */
  resolve?: Resolver;
  /** Tests only: which addresses may be connected to. Default: public addresses only. */
  isAllowed?: (address: string) => boolean;
  /** Tests only: an extra certificate authority to trust (the test server's own). */
  ca?: string;
  timeoutMs?: number;
}

export class HttpsTransport implements WebhookTransport {
  readonly name = 'https';
  readonly #o: HttpsTransportOptions;
  constructor(options: HttpsTransportOptions = {}) {
    this.#o = options;
  }

  async send(req: WebhookRequest): Promise<SendOutcome> {
    const url = new URL(req.url);
    if (url.protocol !== 'https:') return { ok: false, error: 'address_refused' };
    // ONE deadline for everything: the lookup, the connection, the request, the status line
    const deadline = Date.now() + (this.#o.timeoutMs ?? WEBHOOK_LIMITS.timeoutMs);
    let lookupTimer: NodeJS.Timeout | undefined;
    const target = await Promise.race([
      checkedAddress(url.hostname, this.#o.resolve ?? systemResolver, this.#o.isAllowed ?? isPublicAddress),
      new Promise<'timeout'>((resolve) => {
        lookupTimer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now()));
      }),
    ]).finally(() => clearTimeout(lookupTimer));
    if (typeof target === 'string') return { ok: false, error: target };
    return new Promise<SendOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: SendOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        r.destroy();   // nothing more is read or sent; the socket is closed now
        resolve(outcome);
      };
      const pinned = pinnedLookup(target);
      const r = request({
        protocol: 'https:', hostname: url.hostname, port: url.port === '' ? 443 : Number(url.port), path: `${url.pathname}${url.search}`,
        method: 'POST', lookup: pinned, servername: url.hostname, agent: false, ...(this.#o.ca === undefined ? {} : { ca: this.#o.ca }),
        headers: { ...req.headers, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(req.body)), 'user-agent': 'LegacyAI-Webhooks/1' },
      }, (res) => {
        const status = res.statusCode ?? 0;
        res.on('error', () => undefined);
        finish(status >= 200 && status < 300 ? { ok: true, status } : { ok: false, error: 'http_status', status: status >= 100 && status <= 599 ? status : undefined });
      });
      const timer = setTimeout(() => {
        r.destroy(new Error('timeout'));
        finish({ ok: false, error: 'timeout' });
      }, Math.max(0, deadline - Date.now()));
      r.on('error', (err) => finish({ ok: false, error: classify(err) }));
      r.end(req.body);
    });
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** A lookup function that answers with the one address that was checked, whatever it is asked. */
export function pinnedLookup(target: ResolvedAddress): (host: string, options: unknown, callback: LookupCallback) => void {
  return (_host, options, callback) => {
    if (typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true) {
      callback(null, [{ address: target.address, family: target.family }]);
    } else {
      callback(null, target.address, target.family);
    }
  };
}
