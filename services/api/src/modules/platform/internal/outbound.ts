// One HTTPS request to an address a company gave us (its identity provider today), with the same protections as a
// webhook delivery (address.ts): the host name is looked up and EVERY address must be public; the connection is
// pinned to the checked address; the certificate is checked against the host name; no redirect is followed; one
// deadline covers the lookup and the whole exchange; the answer is read up to a size limit and no further.
// node:https only - no library.
import { lookup as dnsLookup } from 'node:dns/promises';
import { request } from 'node:https';
import { checkedAddress, isPublicAddress, pinnedLookup, type Resolver } from './address.ts';

export interface HttpsRequest {
  url: string;
  method: 'GET' | 'POST';
  headers?: Readonly<Record<string, string>>;
  body?: string;
}

export type HttpsResponse =
  | { ok: true; status: number; body: Buffer }
  | { ok: false; error: 'address_refused' | 'dns' | 'connect' | 'tls' | 'timeout' | 'too_large' };

export interface HttpsOptions {
  timeoutMs: number;
  maxBytes: number;
  /** Tests only: a resolver for test host names, which addresses may be connected to, an extra trusted authority. */
  resolve?: Resolver;
  isAllowed?: (address: string) => boolean;
  ca?: string;
}

const systemResolver: Resolver = async (host) =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));

const TLS_ERROR = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|ERR_CERT)/;

export async function httpsRequest(req: HttpsRequest, o: HttpsOptions): Promise<HttpsResponse> {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return { ok: false, error: 'address_refused' };
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return { ok: false, error: 'address_refused' };
  const deadline = Date.now() + o.timeoutMs;
  let lookupTimer: NodeJS.Timeout | undefined;
  const target = await Promise.race([
    checkedAddress(url.hostname, o.resolve ?? systemResolver, o.isAllowed ?? isPublicAddress),
    new Promise<'timeout'>((resolve) => {
      lookupTimer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now()));
    }),
  ]).finally(() => clearTimeout(lookupTimer));
  if (typeof target === 'string') return { ok: false, error: target };

  return new Promise<HttpsResponse>((resolve) => {
    let settled = false;
    const finish = (outcome: HttpsResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      r.destroy();
      resolve(outcome);
    };
    const r = request({
      protocol: 'https:', hostname: url.hostname, port: url.port === '' ? 443 : Number(url.port), path: `${url.pathname}${url.search}`,
      method: req.method, lookup: pinnedLookup(target), servername: url.hostname, agent: false, ...(o.ca === undefined ? {} : { ca: o.ca }),
      headers: {
        ...(req.headers ?? {}), 'user-agent': 'LegacyAI/1',
        ...(req.body === undefined ? {} : { 'content-length': String(Buffer.byteLength(req.body)) }),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > o.maxBytes) finish({ ok: false, error: 'too_large' });
        else chunks.push(chunk);
      });
      res.on('end', () => finish({ ok: true, status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      res.on('error', () => finish({ ok: false, error: 'connect' }));
    });
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), Math.max(0, deadline - Date.now()));
    r.on('error', (err) => {
      const code = (err as { code?: unknown }).code;
      finish({ ok: false, error: typeof code === 'string' && TLS_ERROR.test(code) ? 'tls' : 'connect' });
    });
    r.end(req.body);
  });
}
