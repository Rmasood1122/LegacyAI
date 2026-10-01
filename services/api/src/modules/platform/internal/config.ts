// Configuration loader. FAILS CLOSED: any missing, empty, malformed or too-weak value
// stops the process before it listens. Error messages name the variable, never its value.
import { inspect } from 'node:util';

/** Wraps a secret so that logging or serialising it by accident prints "[redacted]". */
export class Secret<T = string> {
  readonly #value: T;
  constructor(value: T) {
    this.#value = value;
  }
  reveal(): T {
    return this.#value;
  }
  toString(): string {
    return '[redacted]';
  }
  toJSON(): string {
    return '[redacted]';
  }
  [inspect.custom](): string {
    return '[redacted]';
  }
}

export interface Keyring {
  currentId: string;
  keys: ReadonlyMap<string, Secret<Buffer>>;
}

export interface Config {
  env: 'development' | 'test' | 'production';
  version: string;
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  databaseUrl: Secret;
  dbPoolMax: number;
  scPepper: Keyring;
  credentialEnc: Keyring;
  hmacIndexKey: Secret<Buffer>;
  internalServiceToken: Secret;
  webauthn: { rpId: string; rpName: string };
  allowedOrigins: string[];
  argon2: { memoryKiB: number; iterations: number; parallelism: number; maxConcurrency: number };
  trustProxy: boolean;
  validateResponses: boolean;
  exportDir: string;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

// OWASP Password Storage Cheat Sheet minimum for Argon2id (verified 2026-10-02).
export const ARGON2_FLOOR = { memoryKiB: 19456, iterations: 2, parallelism: 1 } as const;

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env): Config {
  const problems: string[] = [];

  const raw = (name: string): string | undefined => {
    const v = env[name];
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    return t === '' ? undefined : t;
  };
  const required = (name: string): string => {
    const v = raw(name);
    if (v === undefined) {
      problems.push(`${name} is required and is missing or empty`);
      return '';
    }
    return v;
  };
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const v = raw(name);
    if (v === undefined) return fallback;
    if (!/^\d{1,9}$/.test(v)) {
      problems.push(`${name} must be a whole number`);
      return fallback;
    }
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < min || n > max) {
      problems.push(`${name} must be between ${min} and ${max}`);
      return fallback;
    }
    return n;
  };
  const bool = (name: string, fallback: boolean): boolean => {
    const v = raw(name);
    if (v === undefined) return fallback;
    if (v === 'true') return true;
    if (v === 'false') return false;
    problems.push(`${name} must be "true" or "false"`);
    return fallback;
  };
  const oneOf = <T extends string>(name: string, allowed: readonly T[], fallback: T | undefined): T => {
    const v = raw(name);
    if (v === undefined) {
      if (fallback === undefined) problems.push(`${name} is required`);
      return (fallback ?? allowed[0]) as T;
    }
    if (!(allowed as readonly string[]).includes(v)) {
      problems.push(`${name} must be one of: ${allowed.join(', ')}`);
      return (fallback ?? allowed[0]) as T;
    }
    return v as T;
  };
  const decodeKey = (name: string, b64: unknown, minBytes: number, exactBytes?: number): Buffer | undefined => {
    if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64)) {
      problems.push(`${name} must contain base64 key material`);
      return undefined;
    }
    const buf = Buffer.from(b64, 'base64');
    if (exactBytes !== undefined ? buf.length !== exactBytes : buf.length < minBytes) {
      problems.push(
        exactBytes !== undefined
          ? `${name} keys must be exactly ${exactBytes} bytes`
          : `${name} keys must be at least ${minBytes} bytes`,
      );
      return undefined;
    }
    return buf;
  };
  const keyring = (name: string, exactBytes?: number): Keyring => {
    const empty: Keyring = { currentId: '', keys: new Map() };
    const text = required(name);
    if (text === '') return empty;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      problems.push(`${name} must be JSON like {"current":"v1","keys":{"v1":"<base64>"}}`);
      return empty;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      problems.push(`${name} must be a JSON object`);
      return empty;
    }
    const { current, keys } = parsed as { current?: unknown; keys?: unknown };
    if (typeof current !== 'string' || !/^[a-z0-9_-]{1,20}$/.test(current)) {
      problems.push(`${name}.current must be a short id such as "v1"`);
      return empty;
    }
    if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) {
      problems.push(`${name}.keys must be an object`);
      return empty;
    }
    const map = new Map<string, Secret<Buffer>>();
    for (const [id, value] of Object.entries(keys)) {
      if (!/^[a-z0-9_-]{1,20}$/.test(id)) {
        problems.push(`${name}.keys has an invalid key id`);
        continue;
      }
      const buf = decodeKey(name, value, 32, exactBytes);
      if (buf) map.set(id, new Secret(buf));
    }
    if (!map.has(current)) {
      problems.push(`${name}.current does not match any usable key in ${name}.keys`);
      return empty;
    }
    return { currentId: current, keys: map };
  };

  const nodeEnv = oneOf('NODE_ENV', ['development', 'test', 'production'] as const, undefined);

  const databaseUrl = required('DATABASE_URL');
  if (databaseUrl !== '' && !/^postgres(ql)?:\/\/[^\s]+$/.test(databaseUrl)) {
    problems.push('DATABASE_URL must be a postgres:// connection string');
  }

  const hmacKeyText = required('HMAC_INDEX_KEY');
  const hmacKey = hmacKeyText === '' ? undefined : decodeKey('HMAC_INDEX_KEY', hmacKeyText, 32);

  const serviceToken = required('INTERNAL_SERVICE_TOKEN');
  if (serviceToken !== '' && serviceToken.length < 32) {
    problems.push('INTERNAL_SERVICE_TOKEN must be at least 32 characters');
  }

  const originsText = required('ALLOWED_ORIGINS');
  const allowedOrigins: string[] = [];
  for (const o of originsText.split(',').map((s) => s.trim()).filter((s) => s !== '')) {
    let url: URL | undefined;
    try {
      url = new URL(o);
    } catch {
      url = undefined;
    }
    const local = url !== undefined && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if (url === undefined || url.origin !== o || o.includes('*') || (url.protocol !== 'https:' && !local)) {
      problems.push('ALLOWED_ORIGINS must be a comma-separated list of exact https origins (no wildcards, no paths)');
      continue;
    }
    allowedOrigins.push(o);
  }
  if (originsText !== '' && allowedOrigins.length === 0 && problems.every((p) => !p.startsWith('ALLOWED_ORIGINS'))) {
    problems.push('ALLOWED_ORIGINS must list at least one origin');
  }

  const rpId = required('WEBAUTHN_RP_ID');
  if (rpId !== '' && !/^[a-z0-9.-]{1,253}$/.test(rpId)) problems.push('WEBAUTHN_RP_ID must be a bare host name');

  const config: Config = {
    env: nodeEnv,
    version: raw('APP_VERSION') ?? '0.1.0',
    port: integer('PORT', 8080, 1, 65535),
    logLevel: oneOf('LOG_LEVEL', ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const, 'info'),
    databaseUrl: new Secret(databaseUrl),
    dbPoolMax: integer('DB_POOL_MAX', 5, 1, 50),
    scPepper: keyring('SC_PEPPER_KEYRING'),
    credentialEnc: keyring('CREDENTIAL_ENC_KEYRING', 32),
    hmacIndexKey: new Secret(hmacKey ?? Buffer.alloc(0)),
    internalServiceToken: new Secret(serviceToken),
    webauthn: { rpId, rpName: raw('WEBAUTHN_RP_NAME') ?? 'LegacyAI' },
    allowedOrigins,
    argon2: {
      // The floor is enforced: asking for less than the OWASP minimum is a start-up error.
      memoryKiB: integer('ARGON2_MEMORY_KIB', ARGON2_FLOOR.memoryKiB, ARGON2_FLOOR.memoryKiB, 1048576),
      iterations: integer('ARGON2_ITERATIONS', ARGON2_FLOOR.iterations, ARGON2_FLOOR.iterations, 20),
      parallelism: integer('ARGON2_PARALLELISM', ARGON2_FLOOR.parallelism, ARGON2_FLOOR.parallelism, 8),
      maxConcurrency: integer('ARGON2_MAX_CONCURRENCY', 4, 1, 64),
    },
    trustProxy: bool('TRUST_PROXY', false),
    validateResponses: bool('VALIDATE_RESPONSES', nodeEnv !== 'production'),
    exportDir: raw('EXPORT_DIR') ?? './exports',
  };

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
