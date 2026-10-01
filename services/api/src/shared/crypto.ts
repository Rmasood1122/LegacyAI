// Thin wrappers over node:crypto. No algorithms are implemented here.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256(data: string | Buffer): Buffer {
  return createHash('sha256').update(data).digest();
}

export function hmacSha256(key: Buffer, data: string | Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

/** URL-safe random token with `bytes` bytes of entropy from the OS CSPRNG. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time comparison. Different lengths compare as not equal (without throwing). */
export function constantTimeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const ha = sha256(a);
  const hb = sha256(b);
  return timingSafeEqual(ha, hb);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
