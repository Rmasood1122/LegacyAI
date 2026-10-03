// The ONLY module that talks to the network. Everything else calls operations by their name from
// the contract (generated.ts), so a screen cannot call something that does not exist.
//
// What it takes care of, so no screen has to:
//   - the session lives in a cookie the browser keeps and JavaScript cannot read; requests are
//     same-origin, so the browser sends it by itself;
//   - the anti-forgery (CSRF) token: the API returns it with the session, it is kept in memory only
//     and sent on every changing request;
//   - an Idempotency-Key on every operation the contract marks as needing one, so a repeated click
//     or a retry cannot do the thing twice;
//   - errors arrive in one shape (ApiError) with the API's plain-language title.
import { operations, type OperationId, type OperationTypes, type Problem, type Session } from './generated.ts';

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

type Defined<T, K extends string> = [T] extends [undefined] ? { [P in K]?: undefined } : { [P in K]: T };
type QueryOf<K extends OperationId> = [OperationTypes[K]['query']] extends [undefined] ? { query?: undefined } : { query?: OperationTypes[K]['query'] };
/** Only an operation whose body is a file takes a content type. Must be one the contract lists for it. */
type FileTypeOf<K extends OperationId> = [OperationTypes[K]['body']] extends [Blob] ? { contentType?: string } : { contentType?: undefined };
export type CallArgs<K extends OperationId> =
  Defined<OperationTypes[K]['path'], 'path'> & QueryOf<K> & Defined<OperationTypes[K]['body'], 'body'> & FileTypeOf<K>;
/** The argument object is required exactly when the operation has a path or a body. */
export type ArgsTuple<K extends OperationId> = Record<string, never> extends CallArgs<K> ? [args?: CallArgs<K>] : [args: CallArgs<K>];
export type ResponseOf<K extends OperationId> = OperationTypes[K]['response'];

export type ApiErrorKind = 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' | 'invalid' | 'too_many' | 'too_large' | 'unavailable' | 'network';

const KIND_BY_STATUS: Readonly<Record<number, ApiErrorKind>> = {
  400: 'invalid', 401: 'unauthenticated', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 413: 'too_large', 422: 'invalid', 429: 'too_many',
};

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  /** The API's machine-readable code, e.g. "consent-required" (the last part of the problem type); null if there was none. */
  readonly code: string | null;
  readonly requestId: string | null;
  readonly fieldErrors: ReadonlyArray<{ path: string; message: string }>;

  constructor(kind: ApiErrorKind, status: number, title: string, problem?: Partial<Problem>) {
    super(title);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.code = problem?.type?.split(':').pop() || null;
    this.requestId = problem?.request_id ?? null;
    this.fieldErrors = problem?.errors ?? [];
  }
}

/** The part of the client the rest of the application depends on (easy to replace in tests). */
export interface Api {
  /**
   * Calls one operation of the contract and returns its answer, or throws an ApiError.
   * Side effects a caller should know about: an answer that is a session (sign-in, set-up,
   * getSession) makes the client remember its anti-forgery token; `logout` forgets it; and a
   * "not signed in" answer to a non-public operation forgets it and reports the session as lost.
   * ('unavailable' is also the kind for any status this client has no better word for.)
   */
  call<K extends OperationId>(operation: K, ...args: ArgsTuple<K>): Promise<ResponseOf<K>>;
}

export interface ApiClientOptions {
  fetch: FetchLike;
  /** Makes a fresh Idempotency-Key (default: a random UUID). */
  newIdempotencyKey?: () => string;
  /** Called when the API says the session is gone (signed out, expired, card suspended). */
  onSessionLost?: () => void;
}

const isSession = (value: unknown): value is Session =>
  typeof value === 'object' && value !== null && typeof (value as { csrf_token?: unknown }).csrf_token === 'string'
  && typeof (value as { card_id?: unknown }).card_id === 'string';

export class ApiClient implements Api {
  readonly #fetch: FetchLike;
  readonly #newIdempotencyKey: () => string;
  readonly #onSessionLost: () => void;
  #csrfToken: string | null = null;

  constructor(options: ApiClientOptions) {
    this.#fetch = options.fetch;
    this.#newIdempotencyKey = options.newIdempotencyKey ?? (() => crypto.randomUUID());
    this.#onSessionLost = options.onSessionLost ?? (() => undefined);
  }

  async call<K extends OperationId>(operation: K, ...args: ArgsTuple<K>): Promise<ResponseOf<K>> {
    const spec = operations[operation];
    const given = (args[0] ?? {}) as { path?: Record<string, string>; query?: Record<string, unknown>; body?: unknown; contentType?: string };
    const url = buildUrl(spec.path, given.path, given.query);
    const changing = spec.method !== 'GET';
    // One key for the whole call, including the retry below: the API then does the work at most once.
    const idempotencyKey = spec.idempotent ? this.#newIdempotencyKey() : null;

    const send = (): Promise<Response> => {
      const headers: Record<string, string> = { accept: 'application/json' };
      let body: BodyInit | undefined;
      if (given.body instanceof Blob) {
        const type = given.contentType ?? given.body.type;
        if (!(spec.contentTypes as readonly string[]).includes(type)) throw new ApiError('invalid', 0, 'This kind of file is not accepted');
        headers['content-type'] = type;
        body = given.body;
      } else if (given.body !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(given.body);
      }
      if (changing && this.#csrfToken !== null) headers['x-csrf-token'] = this.#csrfToken;
      if (idempotencyKey !== null) headers['idempotency-key'] = idempotencyKey;
      return this.#fetch(url, { method: spec.method, headers, body, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    };

    let response = await this.#attempt(send);
    // The API replaces the session (and with it the anti-forgery token) when a card's rights change.
    // A refused changing request may only mean our token is the old one: fetch the new one, try once more.
    if (response.status === 403 && changing && !spec.public && await this.#refreshCsrfToken()) response = await this.#attempt(send);

    if (response.ok && operation === 'logout') this.#csrfToken = null;
    if (response.status === 204) return undefined as ResponseOf<K>;
    const payload = await readJson(response);
    if (!response.ok) {
      const problem = (payload ?? {}) as Partial<Problem>;
      const kind = KIND_BY_STATUS[response.status] ?? 'unavailable';
      if (kind === 'unauthenticated' && !spec.public) {
        this.#csrfToken = null;
        this.#onSessionLost();
      }
      throw new ApiError(kind, response.status, typeof problem.title === 'string' ? problem.title : 'The service could not complete the request', problem);
    }
    if (isSession(payload)) this.#csrfToken = payload.csrf_token;
    return payload as ResponseOf<K>;
  }

  async #attempt(send: () => Promise<Response>): Promise<Response> {
    try {
      return await send();
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError('network', 0, 'The service could not be reached. Check the connection and try again.');
    }
  }

  /** True if the token changed (so a retry is worth it). */
  async #refreshCsrfToken(): Promise<boolean> {
    const before = this.#csrfToken;
    try {
      const response = await this.#fetch(operations.getSession.path, { method: 'GET', headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
      const payload = response.ok ? await readJson(response) : null;
      if (isSession(payload)) this.#csrfToken = payload.csrf_token;
    } catch {
      return false;
    }
    return this.#csrfToken !== null && this.#csrfToken !== before;
  }
}

function buildUrl(template: string, path: Record<string, string> | undefined, query: Record<string, unknown> | undefined): string {
  const url = template.replace(/\{([a-z_]+)\}/g, (_whole, name: string) => {
    const value = path?.[name];
    if (typeof value !== 'string' || value === '') throw new ApiError('invalid', 0, `Missing "${name}"`);
    return encodeURIComponent(value);
  });
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') search.set(name, String(value));
  }
  const text = search.toString();
  return text === '' ? url : `${url}?${text}`;
}

async function readJson(response: Response): Promise<unknown> {
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('json')) return null;
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}
