// PUBLIC SURFACE of the platform module (backend Part 5).
// Other modules may import ONLY from this file - never from ./internal/*.
// Enforced by dependency-cruiser (see .dependency-cruiser.cjs).

export { ARGON2_FLOOR, ConfigError, loadConfig, Secret, type Config, type Keyring } from './internal/config.ts';
export { createLogger, scrub, scrubString, type Logger } from './internal/logger.ts';
export {
  Database, EXPECTED_SCHEMA_VERSION, PLATFORM_TENANT_ID, UnsafeDatabaseRoleError, type QueryResult, type Tx,
} from './internal/db.ts';
export {
  ALLOWED_DETAIL_KEYS,
  canonicalDetails, computeRowHash, countAuditRows, queryAudit, recordAnchor, toApiAuditEvent,
  verifyAgainstExternalAnchors, verifyChain, writeAudit, type AuditEntry, type AuditRow, type VerifyResult,
} from './internal/audit.ts';
export {
  hashRequest, LogNotifier, PostgresIdempotencyStore, PostgresRateLimiter, stripOneTimeSecrets,
  type IdempotencyStore, type NotificationEvent, type Notifier, type RateLimiter, type RateLimitResult,
} from './internal/support.ts';
export {
  createTenant, ExportRegistry, getPlan, getSettings, getTenant, listTenants, toApiTenant, updateSettings,
  type ExportTable, type TenantRow, type TenantSettings,
} from './internal/tenants.ts';
export {
  createHttpServer, SESSION_COOKIE,
  type AuthPort, type GatewayCallArgs, type GatewayPrepared, type HandlerResult, type HttpDeps, type HttpServer, type PublicHandlerArgs,
  honoursFilter, type ListFilter, type RegisteredRoute, type RouteDef, type SessionHandlerArgs,
} from './internal/http.ts';
export { StaticSite, StaticSiteError, WEB_APP_CSP, type StaticAsset } from './internal/static-site.ts';
export { loadContract, type Contract, type Operation } from './internal/openapi.ts';
export { decodeCursor, decodeIdCursor, encodeCursor, platformRoutes } from './internal/routes.ts';
