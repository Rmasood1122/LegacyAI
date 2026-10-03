// The HTTP layer. Every request passes through `runRoute`, which enforces, in order:
// contract validation -> rate limit -> session -> CSRF -> policy decision -> idempotency
// -> handler -> response validation.
//
// Gateway routes (Phase 2) split the handler in two: `prepare` runs inside the decision's
// transaction, which is then COMMITTED; `call` talks to the AI service with no database
// connection held, and may open short transactions of its own (docs/phase2/01).
//
// Handlers cannot skip the policy decision point: a route can only be registered through
// `defineRoutes`, which requires policy metadata, and Fastify is hooked so that any route
// registered another way makes the server refuse to start.
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Clock } from '../../../shared/clock.ts';
import { constantTimeEqual } from '../../../shared/crypto.ts';
import { ProblemError, problemBody, problems } from '../../../shared/errors.ts';
import { KNOWN_OBLIGATIONS, type Decision, type RequestContext, type ResourceRef, type Subject } from '../../../shared/policy-types.ts';
import { writeAudit } from './audit.ts';
import type { Config } from './config.ts';
import type { Database, Tx } from './db.ts';
import type { Logger } from './logger.ts';
import { loadContract, validationErrors, type Contract, type Operation } from './openapi.ts';
import { WEB_APP_CSP, type StaticSite } from './static-site.ts';
import { hashRequest, type IdempotencyStore, type RateLimiter } from './support.ts';

export const SESSION_COOKIE = '__Host-lai_session';

/** What the HTTP layer needs from the identity module. Implemented there, plugged in by app.ts. */
export interface AuthPort {
  /** Extracts the tenant id from an opaque session token, or null if the token is malformed. */
  tenantOfToken(token: string): string | null;
  /** Returns the subject for a live session whose card is still allowed to act, else null. */
  resolveSession(tx: Tx, token: string, ctx: RequestContext): Promise<{ subject: Subject; csrfToken: string } | null>;
  /** The policy decision point. */
  authorize(tx: Tx, subject: Subject, action: string, resource: ResourceRef, ctx: RequestContext): Promise<Decision>;
  /** Writes a decision to the audit log inside `tx`. The HTTP layer calls this for EVERY decision. */
  recordDecision(tx: Tx, subject: Subject, action: string, resource: ResourceRef, decision: Decision, ctx: RequestContext): Promise<void>;
}

export interface HandlerResult {
  status?: number;
  body?: unknown;
  setSessionCookie?: string;
  clearSessionCookie?: boolean;
}

export interface PublicHandlerArgs {
  ctx: RequestContext;
  body: any;
  params: any;
  query: any;
}

export interface SessionHandlerArgs extends PublicHandlerArgs {
  /** The request's content type (without parameters), for raw-file uploads. */
  contentType?: string;
  tx: Tx;
  subject: Subject;
  decision: Decision;
  resource: ResourceRef;
  sessionToken: string;
  csrfToken: string;
}

export type PolicySpec =
  | { public: true; reason: string }
  | {
      /** Loads the thing being acted on. Returning null means "not found" (also for other tenants' data). */
      resource: (args: { tx: Tx; subject: Subject; params: any; body: any; query: any; ctx: RequestContext }) => Promise<ResourceRef | null>;
    };

export interface GatewayCallArgs {
  ctx: RequestContext;
  subject: Subject;
  resource: ResourceRef;
  /** A short transaction for the subject's tenant, for work between or after AI-service calls. */
  withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

/** What `prepare` returns: either the final answer, or the call to make once the transaction has committed. */
export type GatewayPrepared = HandlerResult | { call: (a: GatewayCallArgs) => Promise<HandlerResult> };

export type RouteDef =
  | { kind: 'public'; operationId: string; policy: { public: true; reason: string }; handler: (a: PublicHandlerArgs) => Promise<HandlerResult> }
  | { kind: 'session'; operationId: string; policy: Extract<PolicySpec, { resource: unknown }>; handler: (a: SessionHandlerArgs) => Promise<HandlerResult> }
  | {
      kind: 'gateway'; operationId: string; policy: Extract<PolicySpec, { resource: unknown }>;
      /** Larger request bodies (file uploads). Defaults to the normal limit. */
      bodyLimit?: number;
      prepare: (a: SessionHandlerArgs) => Promise<GatewayPrepared>;
    };

type SessionRouteDef = Extract<RouteDef, { kind: 'session' | 'gateway' }>;

export interface HttpDeps {
  config: Config;
  db: Database;
  log: Logger;
  clock: Clock;
  auth: AuthPort;
  rateLimiter: RateLimiter;
  idempotency: IdempotencyStore;
  contractPath: string;
  /** Per-IP limit on all endpoints. Tests override it; production uses the default. */
  generalLimit?: { limit: number; windowSeconds: number };
  /** The web application's files. Absent = the API serves no files at all. See static-site.ts. */
  staticSite?: StaticSite;
}

export interface RegisteredRoute {
  operationId: string;
  method: string;
  path: string;
  kind: 'public' | 'session' | 'gateway';
  permission: string | null;
  publicReason: string | null;
}

export interface HttpServer {
  app: FastifyInstance;
  contract: Contract;
  defineRoutes(routes: RouteDef[]): void;
  registeredRoutes(): RegisteredRoute[];
}

const ROUTE_MARK = Symbol('legacyai.route');
const DEFAULT_GENERAL_LIMIT = { limit: 300, windowSeconds: 60 };
const tracer = trace.getTracer('legacyai-api');

export async function createHttpServer(deps: HttpDeps): Promise<HttpServer> {
  const { config, db, log, clock, auth } = deps;
  const contract = loadContract(deps.contractPath);
  const registry: RegisteredRoute[] = [];
  const GENERAL_LIMIT = deps.generalLimit ?? DEFAULT_GENERAL_LIMIT;

  const app = Fastify({
    loggerInstance: log as FastifyBaseLogger,
    // Fastify's built-in request log is replaced by the one-line access log below, which
    // records the route PATTERN (no ids, no query string) and nothing from the body.
    disableRequestLogging: true,
    bodyLimit: 64 * 1024,
    requestTimeout: 30_000,
    // Trust exactly N proxy hops for the client address (never "all"): anything further left in
    // X-Forwarded-For was written by the caller and is ignored.
    trustProxy: config.trustProxyHops === 0 ? false : (_address: string, hop: number) => hop < config.trustProxyHops,
    genReqId: () => randomUUID(),
  });

  // Fail closed: a route that did not come through defineRoutes has no policy check.
  app.addHook('onRoute', (route) => {
    const marked = (route.config as Record<symbol, unknown> | undefined)?.[ROUTE_MARK] === true;
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    const internal = methods.every((m) => m === 'HEAD' || m === 'OPTIONS');
    if (!marked && !internal) {
      throw new Error(`Route ${String(route.method)} ${route.url} was registered without defineRoutes(); it has no policy check`);
    }
  });

  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: { maxAge: 31536000, includeSubDomains: true },
  });
  await app.register(cors, {
    origin: (origin, cb) => cb(null, origin !== undefined && config.allowedOrigins.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'x-csrf-token', 'idempotency-key'],
    maxAge: 600,
  });
  await app.register(cookie);
  // Raw files (uploads) arrive as bytes. Only operations whose contract lists the type accept them;
  // any other operation refuses a non-JSON body in validateRequest.
  app.addContentTypeParser(['application/pdf', 'text/plain', 'text/markdown'], { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  const staticReplies = new WeakSet<FastifyReply>();
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
    // API answers are never cached, whatever a handler set. The ONLY exception is a reply the
    // static-file handler below produced, which it marks explicitly.
    if (!staticReplies.has(reply)) reply.header('cache-control', 'no-store');
  });
  app.addHook('onResponse', async (req, reply) => {
    req.log.info({
      request_id: req.id, method: req.method, route: req.routeOptions?.url ?? 'unmatched', status: reply.statusCode,
      duration_ms: Math.round(reply.elapsedTime),
    }, 'request');
  });

  const sendProblem = (req: FastifyRequest, reply: FastifyReply, err: ProblemError): FastifyReply => {
    for (const [k, v] of Object.entries(err.headers ?? {})) reply.header(k, v);
    return reply.status(err.status).type('application/problem+json').send(problemBody(err, req.id));
  };

  // Nothing matched an API route. The only other thing this server may send is a file of the web
  // application (never under /v1, GET and HEAD only, only files read at start-up).
  app.setNotFoundHandler((req, reply) => {
    const asset = deps.staticSite?.resolve(req.method, req.url) ?? null;
    if (asset === null) return sendProblem(req, reply, problems.notFound());
    staticReplies.add(reply);
    return reply.status(200)
      .header('content-security-policy', WEB_APP_CSP)
      .header('cache-control', asset.cacheControl)
      .type(asset.contentType)
      .send(req.method === 'HEAD' ? undefined : asset.body);
  });
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ProblemError) return sendProblem(req, reply, err);
    // Two requests that lock the same rows in opposite order: PostgreSQL aborts one of them.
    // Nothing was changed by the aborted request, so the caller can simply retry.
    const pgCode = (err as { code?: unknown }).code;
    if (pgCode === '40P01' || pgCode === '40001') {
      return sendProblem(req, reply, problems.conflict('concurrent-update', 'Another request changed the same data at the same time; please retry'));
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      // Malformed JSON, body too large, unsupported media type: a client error with no detail.
      const code = status === 413 ? 'payload-too-large' : 'bad-request';
      return sendProblem(req, reply, new ProblemError(status, code, 'The request could not be read'));
    }
    req.log.error({ err, request_id: req.id }, 'unhandled error');
    return sendProblem(req, reply, new ProblemError(500, 'internal', 'Something went wrong'));
  });

  function contextOf(req: FastifyRequest): RequestContext {
    const ua = req.headers['user-agent'];
    return { requestId: req.id, ip: req.ip, userAgent: typeof ua === 'string' ? ua.slice(0, 300) : '', now: clock.now() };
  }

  function validateRequest(op: Operation, req: FastifyRequest): { body: unknown; params: unknown; query: unknown; idemKey: string | null; contentType: string } {
    const errors: Array<{ path: string; message: string }> = [];
    const params = { ...((req.params as Record<string, unknown>) ?? {}) };
    const query = { ...((req.query as Record<string, unknown>) ?? {}) };
    const body = req.body;
    if (op.validateParams && !op.validateParams(params)) errors.push(...validationErrors(op.validateParams, 'path'));
    if (op.validateQuery && !op.validateQuery(query)) errors.push(...validationErrors(op.validateQuery, 'query'));
    const contentType = String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (Buffer.isBuffer(body)) {
      if (!op.binaryTypes.includes(contentType)) errors.push({ path: 'body', message: 'this content type is not accepted here' });
    } else if (op.binaryTypes.length > 0 && !op.validateBody) {
      errors.push({ path: 'body', message: `send the file as one of: ${op.binaryTypes.join(', ')}` });
    } else if (op.validateBody) {
      if (!op.validateBody(body ?? null)) errors.push(...validationErrors(op.validateBody, 'body'));
    } else if (body !== undefined && body !== null) {
      errors.push({ path: 'body', message: 'this operation does not accept a body' });
    }
    let idemKey: string | null = null;
    if (op.validateIdempotencyKey) {
      const header = req.headers['idempotency-key'];
      if (typeof header !== 'string' || !op.validateIdempotencyKey(header)) {
        errors.push({ path: 'header/Idempotency-Key', message: 'a valid Idempotency-Key header is required' });
      } else idemKey = header;
    }
    if (errors.length > 0) throw problems.badRequest(errors);
    return { body, params, query, idemKey, contentType };
  }

  function send(op: Operation, reply: FastifyReply, result: HandlerResult): FastifyReply {
    const status = result.status ?? 200;
    if (config.validateResponses) {
      if (!op.responses.has(status)) throw new Error(`contract: ${op.operationId} returned undeclared status ${status}`);
      const validate = op.responses.get(status);
      if (validate === null || validate === undefined) {
        if (result.body !== undefined) throw new Error(`contract: ${op.operationId} ${status} must not have a body`);
      } else if (!validate(result.body)) {
        throw new Error(`contract: ${op.operationId} ${status} response does not match openapi.yaml: ${JSON.stringify(validate.errors?.slice(0, 3))}`);
      }
    }
    if (result.setSessionCookie !== undefined) {
      reply.setCookie(SESSION_COOKIE, result.setSessionCookie, { httpOnly: true, secure: true, sameSite: 'strict', path: '/' });
    }
    if (result.clearSessionCookie === true) {
      reply.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: true, sameSite: 'strict', path: '/' });
    }
    reply.status(status);
    return result.body === undefined ? reply.send() : reply.type('application/json').send(result.body);
  }

  function checkCsrf(req: FastifyRequest, expectedToken: string): void {
    if (req.method === 'GET') return;
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !config.allowedOrigins.includes(origin)) throw problems.csrf();
    const token = req.headers['x-csrf-token'];
    if (typeof token !== 'string' || token === '' || !constantTimeEqual(token, expectedToken)) throw problems.csrf();
  }

  type Outcome = { result: HandlerResult } | { problem: ProblemError } | { call: Extract<GatewayPrepared, { call: unknown }>['call'] };

  async function runSessionRoute(
    op: Operation, def: SessionRouteDef, req: FastifyRequest,
    input: ReturnType<typeof validateRequest>, ctx: RequestContext,
  ): Promise<HandlerResult> {
    const token = req.cookies[SESSION_COOKIE];
    const tenantId = typeof token === 'string' ? auth.tenantOfToken(token) : null;
    if (typeof token !== 'string' || tenantId === null) throw problems.unauthenticated();
    const action = op.permission as string;

    let allowed: { subject: Subject; resource: ResourceRef; decision: Decision } | null = null;
    try {
      const outcome = await db.withTenantTx<Outcome>(tenantId, async (tx) => {
        const session = await auth.resolveSession(tx, token, ctx);
        if (!session) return { problem: problems.unauthenticated() };
        checkCsrf(req, session.csrfToken);
        const { subject } = session;

        const loaded = await def.policy.resource({ tx, subject, params: input.params, body: input.body, query: input.query, ctx });
        if (loaded === null) {
          await writeAudit(tx, {
            tenantId, actorCardId: subject.card_id, actorKind: 'card', action, decision: 'deny',
            reasonCode: 'DENY_RESOURCE_NOT_FOUND', requestId: ctx.requestId, ip: ctx.ip,
          });
          return { problem: problems.notFound() };
        }

        const decision = await auth.authorize(tx, subject, action, loaded, ctx);
        if (decision.effect !== 'allow') {
          await auth.recordDecision(tx, subject, action, loaded, decision, ctx);
          return { problem: problems.forbidden() };
        }
        // An obligation this layer does not understand cannot be honoured, so the request is refused.
        if (decision.obligations.some((o) => !KNOWN_OBLIGATIONS.has(o.type))) {
          req.log.error({ operation: op.operationId }, 'unknown policy obligation; denying');
          await auth.recordDecision(tx, subject, action, loaded, { effect: 'deny', reason_code: 'DENY_UNKNOWN_OBLIGATION', obligations: [] }, ctx);
          return { problem: problems.forbidden() };
        }
        allowed = { subject, resource: loaded, decision };
        // The "allow" row is written at the END of the transaction (see below), together with the
        // work it allowed. Writing it first would hold the tenant's audit-chain lock for the whole
        // request and make every other request of that tenant wait behind a slow one.
        const recordAllow = (): Promise<void> => auth.recordDecision(tx, subject, action, loaded, decision, ctx);

        if (input.idemKey !== null) {
          const started = await deps.idempotency.begin(tx, {
            tenantId, actorCardId: subject.card_id, key: input.idemKey, operationId: op.operationId,
            requestHash: hashRequest(op.operationId, input.params, input.body), now: ctx.now,
          });
          if (started.kind === 'replay') {
            await recordAllow();
            return { result: { status: started.status, body: started.body ?? undefined } };
          }
        }

        const handlerArgs: SessionHandlerArgs = {
          ctx, tx, subject, decision, resource: loaded, body: input.body, params: input.params, query: input.query,
          sessionToken: token, csrfToken: session.csrfToken, contentType: input.contentType,
        };
        if (def.kind === 'gateway') {
          const prepared = await def.prepare(handlerArgs);
          if ('call' in prepared && typeof prepared.call === 'function') {
            // The decision (and anything prepare wrote) is committed BEFORE the AI service is called.
            await recordAllow();
            return { call: prepared.call };
          }
          if (input.idemKey !== null) {
            await deps.idempotency.complete(tx, {
              tenantId, actorCardId: subject.card_id, key: input.idemKey, status: (prepared as HandlerResult).status ?? 200,
              body: (prepared as HandlerResult).body,
            });
          }
          await recordAllow();
          return { result: prepared as HandlerResult };
        }
        const result = await def.handler(handlerArgs);

        if (input.idemKey !== null) {
          await deps.idempotency.complete(tx, {
            tenantId, actorCardId: subject.card_id, key: input.idemKey, status: result.status ?? 200, body: result.body,
          });
        }
        await recordAllow();
        return { result };
      });
      if ('problem' in outcome) throw outcome.problem;
      if ('result' in outcome) return outcome.result;
      const granted = allowed as unknown as { subject: Subject; resource: ResourceRef; decision: Decision };
      const withTx = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => db.withTenantTx(tenantId, fn);
      let result: HandlerResult;
      try {
        result = await outcome.call({ ctx, subject: granted.subject, resource: granted.resource, withTx });
      } catch (callErr) {
        // The allow row is already committed; record that the work did not complete, and free the
        // idempotency key so the caller can try again.
        const status = callErr instanceof ProblemError ? callErr.status : 502;
        try {
          await db.withTenantTx(tenantId, async (tx) => {
            if (input.idemKey !== null) {
              await tx.query('DELETE FROM idempotency_keys WHERE tenant_id = $1 AND actor_card_id = $2 AND key = $3 AND status = $4',
                [tenantId, granted.subject.card_id, input.idemKey, 'in_progress']);
            }
            await writeAudit(tx, {
              tenantId, actorCardId: granted.subject.card_id, actorKind: 'card', action,
              resourceType: granted.resource.type, resourceId: granted.resource.id ?? null,
              decision: 'allow', reasonCode: granted.decision.reason_code, requestId: ctx.requestId, ip: ctx.ip,
              details: { outcome: 'failed', status },
            });
          });
        } catch (auditErr) {
          req.log.error({ err: auditErr }, 'could not record a failed gateway call in the audit log');
        }
        allowed = null; // already recorded above
        throw callErr;
      }
      if (input.idemKey !== null) {
        const key = input.idemKey;
        await db.withTenantTx(tenantId, (tx) => deps.idempotency.complete(tx, {
          tenantId, actorCardId: granted.subject.card_id, key, status: result.status ?? 200, body: result.body,
        }));
      }
      return result;
    } catch (err) {
      // The transaction rolled back, taking the "allow" audit row with it. Record that the
      // request was allowed but did not complete, so the trail has no silent gap.
      const granted = allowed as { subject: Subject; resource: ResourceRef; decision: Decision } | null;
      if (granted !== null) {
        const pgCode = (err as { code?: unknown }).code;
        const status = err instanceof ProblemError ? err.status : pgCode === '40P01' || pgCode === '40001' ? 409 : 500;
        try {
          await db.withTenantTx(tenantId, (tx) => writeAudit(tx, {
            tenantId, actorCardId: granted.subject.card_id, actorKind: 'card', action,
            resourceType: granted.resource.type, resourceId: granted.resource.id ?? null,
            decision: 'allow', reasonCode: granted.decision.reason_code, requestId: ctx.requestId, ip: ctx.ip,
            details: { outcome: 'failed', status },
          }));
        } catch (auditErr) {
          req.log.error({ err: auditErr }, 'could not record a failed request in the audit log');
        }
      }
      throw err;
    }
  }

  function defineRoutes(routes: RouteDef[]): void {
    for (const def of routes) {
      const op = contract.operations.get(def.operationId);
      if (!op) throw new Error(`defineRoutes: "${def.operationId}" is not an operation in openapi.yaml`);
      if (registry.some((r) => r.operationId === def.operationId)) throw new Error(`defineRoutes: "${def.operationId}" registered twice`);
      const kind = def.kind;
      // The contract and the code must agree about which routes are public. There are no
      // service-only routes any more (Phase 2 removed the internal policy endpoint): an operation
      // marked x-service cannot be registered.
      if ((kind === 'public') !== op.isPublic || op.isService) {
        throw new Error(`defineRoutes: "${def.operationId}" public/service flag differs from openapi.yaml`);
      }
      if (def.kind === 'public' && def.policy.reason.trim().length < 10) {
        throw new Error(`defineRoutes: public route "${def.operationId}" needs a written reason`);
      }
      registry.push({
        operationId: op.operationId, method: op.method, path: op.path, kind, permission: op.permission,
        publicReason: def.kind === 'public' ? def.policy.reason : null,
      });

      app.route({
        method: op.method,
        url: op.fastifyPath,
        config: { [ROUTE_MARK]: true } as Record<symbol, unknown>,
        // Sign-in and enrollment bodies are small; anonymous callers get a tighter limit. Uploads declare their own.
        ...(kind === 'public' ? { bodyLimit: 16 * 1024 } : {}),
        ...(def.kind === 'gateway' && def.bodyLimit !== undefined ? { bodyLimit: def.bodyLimit } : {}),
        handler: (req, reply) =>
          tracer.startActiveSpan(op.operationId, async (span) => {
            try {
              const ctx = contextOf(req);
              const general = await deps.rateLimiter.hit(`ip:${ctx.ip}`, GENERAL_LIMIT.limit, GENERAL_LIMIT.windowSeconds, ctx.now);
              if (!general.allowed) throw problems.tooManyRequests(general.retryAfterSeconds);
              const input = validateRequest(op, req);

              let result: HandlerResult;
              if (def.kind === 'public') {
                result = await def.handler({ ctx, body: input.body, params: input.params, query: input.query });
              } else {
                result = await runSessionRoute(op, def, req, input, ctx);
              }
              span.setAttribute('http.response.status_code', result.status ?? 200);
              return send(op, reply, result);
            } catch (err) {
              span.setStatus({ code: SpanStatusCode.ERROR });
              throw err;
            } finally {
              span.end();
            }
          }),
      });
    }
  }

  return { app, contract, defineRoutes, registeredRoutes: () => [...registry] };
}
