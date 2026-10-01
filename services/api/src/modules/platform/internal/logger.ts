// Structured JSON logging with redaction of secrets and personal data.
// Two layers: (1) any value under a sensitive KEY is replaced; (2) any string that
// LOOKS like a card number is masked, wherever it appears.
import { pino, type DestinationStream, type Logger } from 'pino';

export type { Logger };

const SENSITIVE_KEYS = new Set([
  'sc', 'secret', 'secret_code', 'password', 'passwd', 'token', 'login_txn', 'enrollment_txn', 'enrollment_token',
  'session_token', 'csrf_token', 'x-csrf-token', 'cookie', 'set-cookie', 'authorization', 'pepper', 'assertion',
  'attestation', 'code', 'totp_code', 'totp', 'otpauth_uri', 'sc_hash', 'totp_secret_enc', 'webauthn_public_key',
  'database_url', 'databaseurl', 'connectionstring', 'email', 'owner_email', 'display_name', 'owner_display_name',
  'name', 'ip', 'card_number', 'idempotency-key',
]);

const REDACTED = '[redacted]';
// 16 digits, optionally grouped with spaces or dashes and prefixed LGY-.
const CARD_NUMBER_RE = /(?:LGY[- ]?)?\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/gi;

export function scrubString(value: string): string {
  return value.replace(CARD_NUMBER_RE, '[card-number]');
}

/** Returns a deep copy with sensitive values removed. Never mutates its input. */
export function scrub(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (depth > 8) return '[too-deep]';
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return '[bytes]';
  if (value instanceof Error) {
    return { type: value.name, message: scrubString(value.message), stack: scrubString(value.stack ?? '') };
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? REDACTED : scrub(v, depth + 1);
    }
    return out;
  }
  return '[unserialisable]';
}

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: 'legacyai-api' },
      timestamp: pino.stdTimeFunctions.isoTime,
      messageKey: 'msg',
      formatters: {
        level: (label) => ({ level: label }),
        log: (obj) => scrub(obj) as Record<string, unknown>,
      },
      hooks: {
        logMethod(args, method) {
          const scrubbed = args.map((a) => (typeof a === 'string' ? scrubString(a) : a)) as Parameters<typeof method>;
          method.apply(this, scrubbed);
        },
      },
    },
    destination,
  );
}
