// The only way the API talks to the AI service (docs/phase2/01).
//
// Every call carries a service token minted here for ONE operation (and, where the operation names a
// record, for that record), signed with SERVICE_TOKEN_KEY, valid for 60 seconds, accepted once.
// The client refuses to call anything the internal contract (contracts/ai-internal.openapi.json)
// does not list, or with an action other than the one the contract names.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { ProblemError, problems } from '../../../shared/errors.ts';
import type { FilterSpec } from '../../identity-access/index.ts';
import type { Secret } from '../../platform/index.ts';

export const TOKEN_LIFETIME_SECONDS = 60;

export interface TokenClaims {
  tenant_id: string;
  card_id: string;
  person_id: string | null;
  roles: string[];
  card_phase: 'normal' | 'grace';
  request_id: string;
  filter?: FilterSpec | null;
  approved?: string[];
  limits?: Record<string, number>;
}

interface ContractOperation {
  method: string;
  template: string;
  pattern: RegExp;
  action: string;
  subject: string | null;
}

/** Loads the operations of the internal contract. */
export function loadInternalContract(filePath: string): ContractOperation[] {
  const doc = JSON.parse(readFileSync(filePath, 'utf8')) as { paths: Record<string, Record<string, { 'x-action'?: string; 'x-subject'?: string | null }>> };
  const ops: ContractOperation[] = [];
  for (const [template, item] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (typeof op['x-action'] !== 'string') continue;
      const pattern = new RegExp(`^${template.replace(/\{kind\}/g, '(?:source|knowledge_item)').replace(/\{[a-z_]+\}/g, '[0-9a-f-]{36}')}$`);
      ops.push({ method: method.toUpperCase(), template, pattern, action: op['x-action'], subject: op['x-subject'] ?? null });
    }
  }
  if (ops.length === 0) throw new Error('internal contract lists no operations');
  return ops;
}

export interface AiCall {
  /** The concrete path, e.g. /internal/items/<id>/verify. Ids are interpolated by the caller from validated input. */
  path: string;
  method?: 'POST' | 'PUT';
  action: string;
  subject?: string;
  claims: TokenClaims;
  json?: unknown;
  bytes?: { data: Buffer; contentType: string };
}

/** Status codes the AI service answers with, mapped to what the public API says. Anything else is a 502. */
function toProblem(status: number, code: string): ProblemError {
  switch (status) {
    case 400: return problems.unprocessable(code.replace(/_/g, ' '));
    case 403: return problems.forbidden();
    case 404: return problems.notFound();
    case 409: return problems.conflict(code.replace(/_/g, '-'), code.replace(/_/g, ' '));
    case 413: return new ProblemError(413, 'payload-too-large', 'The file is too large');
    case 422: return problems.unprocessable(code.replace(/_/g, ' '));
    case 429: return problems.tooManyRequests(3600);
    case 503: return new ProblemError(503, 'ai-unavailable', 'AI is not available right now');
    case 507: return new ProblemError(507, 'storage-full', 'Storage for captured knowledge is full');
    default: return new ProblemError(502, 'ai-service-error', 'The knowledge service did not answer');
  }
}

export class AiServiceClient {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #key: Uint8Array;
  readonly #ops: ContractOperation[];

  readonly #identity: 'none' | 'google-metadata';
  #idToken: { value: string; until: number } | null = null;

  constructor(baseUrl: string, timeoutMs: number, key: Secret, contract: ContractOperation[], identity: 'none' | 'google-metadata' = 'none') {
    this.#identity = identity;
    this.#baseUrl = baseUrl;
    this.#timeoutMs = timeoutMs;
    this.#key = new TextEncoder().encode(key.reveal());
    this.#ops = contract;
  }

  async #token(action: string, subject: string | undefined, claims: TokenClaims): Promise<string> {
    const now = Math.floor(Date.now() / 1000);   // real time: the AI service checks the token against its own clock
    const body: Record<string, unknown> = {
      action, tenant_id: claims.tenant_id, card_id: claims.card_id, person_id: claims.person_id, roles: claims.roles,
      card_phase: claims.card_phase, request_id: claims.request_id, filter: claims.filter ?? null, approved: claims.approved ?? [],
      limits: claims.limits ?? {},
    };
    if (subject !== undefined) body.subject = subject;
    return new SignJWT(body)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('legacyai-api').setAudience('legacyai-ai')
      .setIssuedAt(now).setExpirationTime(now + TOKEN_LIFETIME_SECONDS).setJti(randomUUID())
      .sign(this.#key);
  }

  /** Google identity token for Cloud Run's own check (cached; such tokens live about an hour). */
  async #googleIdToken(): Promise<string> {
    if (this.#idToken && this.#idToken.until > Date.now()) return this.#idToken.value;
    const url = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(this.#baseUrl)}`;
    const res = await fetch(url, { headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new ProblemError(502, 'ai-service-error', 'The knowledge service did not answer');
    this.#idToken = { value: (await res.text()).trim(), until: Date.now() + 45 * 60_000 };
    return this.#idToken.value;
  }

  async call<T = Record<string, unknown>>(c: AiCall): Promise<T> {
    const method = c.method ?? 'POST';
    const op = this.#ops.find((o) => o.method === method && o.pattern.test(c.path));
    if (!op) throw new Error(`AI client: ${method} ${c.path} is not in the internal contract`);
    if (op.action !== c.action) throw new Error(`AI client: ${op.template} requires action ${op.action}, not ${c.action}`);
    if ((op.subject !== null) !== (c.subject !== undefined)) throw new Error(`AI client: ${op.template} subject binding mismatch`);
    if (c.subject !== undefined && !c.path.includes(`/${c.subject}`)) throw new Error('AI client: the token subject is not the record in the path');

    const token = await this.#token(c.action, c.subject, c.claims);
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'x-request-id': c.claims.request_id };
    if (this.#identity === 'google-metadata') {
      try {
        headers['x-serverless-authorization'] = `Bearer ${await this.#googleIdToken()}`;
      } catch {
        throw new ProblemError(502, 'ai-service-error', 'The knowledge service did not answer');
      }
    }
    let body: string | Buffer | undefined;
    if (c.bytes) {
      headers['content-type'] = c.bytes.contentType;
      body = c.bytes.data;
    } else if (c.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(c.json);
    }
    let res: Response;
    try {
      res = await fetch(`${this.#baseUrl}${c.path}`, { method, headers, body, signal: AbortSignal.timeout(this.#timeoutMs), redirect: 'error' });
    } catch {
      throw new ProblemError(502, 'ai-service-error', 'The knowledge service did not answer');
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text === '' ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (res.ok) return parsed as T;
    const code = typeof (parsed as { error?: unknown } | null)?.error === 'string' ? (parsed as { error: string }).error : 'error';
    // 401 means the two services disagree about the key or the clock: an operator problem, not the user's.
    if (res.status === 401) throw new ProblemError(502, 'ai-service-error', 'The knowledge service did not answer');
    throw toProblem(res.status, /^[a-z_]{1,40}$/.test(code) ? code : 'error');
  }
}
