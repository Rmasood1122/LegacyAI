// One error type for everything that should reach the caller as an RFC 9457 problem.
// Anything else that is thrown becomes a generic 500 with no detail.

export interface FieldError {
  path: string;
  message: string;
}

export class ProblemError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string | undefined;
  readonly errors: FieldError[] | undefined;
  readonly headers: Record<string, string> | undefined;

  constructor(
    status: number,
    code: string,
    title: string,
    options: { detail?: string; errors?: FieldError[]; headers?: Record<string, string> } = {},
  ) {
    super(title);
    this.name = 'ProblemError';
    this.status = status;
    this.code = code;
    this.title = title;
    this.detail = options.detail;
    this.errors = options.errors;
    this.headers = options.headers;
  }
}

export const problems = {
  badRequest: (errors?: FieldError[]) =>
    new ProblemError(400, 'bad-request', 'The request does not match the API contract', { errors }),
  /**
   * No session or key, or it is no longer valid. `bearer`: the operation also takes an API key, so the answer says
   * how to present one (RFC 6750) - the same answer for every cause.
   */
  unauthenticated: (bearer = false) =>
    new ProblemError(401, 'unauthenticated', 'Sign-in required', bearer ? { headers: { 'www-authenticate': 'Bearer' } } : {}),
  /** An API key was sent to an operation that takes none (the contract says which do). Nothing was looked up. */
  apiKeyNotAccepted: () => new ProblemError(403, 'api-key-not-accepted', 'This operation does not take an API key'),
  /** A working key asked for something it was not made for. Says nothing about what the key does hold. */
  apiKeyScope: () => new ProblemError(403, 'api-key-scope', 'This API key may not do this'),
  /** Every sign-in / enrollment failure. One message for all causes, on purpose. */
  authFailed: () => new ProblemError(401, 'auth-failed', 'Sign-in failed'),
  forbidden: () => new ProblemError(403, 'forbidden', 'Not allowed'),
  csrf: () => new ProblemError(403, 'forbidden', 'Not allowed'),
  notFound: () => new ProblemError(404, 'not-found', 'Not found'),
  conflict: (code: string, title: string) => new ProblemError(409, code, title),
  unprocessable: (title: string, errors?: FieldError[]) => new ProblemError(422, 'unprocessable', title, { errors }),
  tooManyRequests: (retryAfterSeconds: number) =>
    new ProblemError(429, 'rate-limited', 'Too many requests', {
      headers: { 'retry-after': String(Math.max(1, Math.ceil(retryAfterSeconds))) },
    }),
  notReady: () => new ProblemError(503, 'not-ready', 'Service is not ready'),
};

export function problemBody(error: ProblemError, requestId: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    type: `urn:legacyai:problem:${error.code}`,
    title: error.title,
    status: error.status,
    request_id: requestId,
  };
  if (error.detail !== undefined) body.detail = error.detail;
  if (error.errors !== undefined && error.errors.length > 0) body.errors = error.errors;
  return body;
}
