// How a receiver knows a message came from this product and was not changed or replayed.
//
// The format is the open "Standard Webhooks" one (https://www.standardwebhooks.com, checked 2026-10-06), so a
// receiver can use an existing library instead of code written for us:
//   webhook-id:        the event's id - the same on every retry; a receiver ignores an id it has seen
//   webhook-timestamp: seconds since 1970 when this attempt was signed; a receiver refuses one more than 5 minutes off
//   webhook-signature: "v1," + base64(HMAC-SHA256(secret, "<id>.<timestamp>.<body>"))
// The secret is "whsec_" + base64 of 32 random bytes; the HMAC key is the decoded bytes. It is shown once.
// Pure: no clock, no database, no network.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SECRET_PREFIX = 'whsec_';
export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export function newSigningSecret(): string {
  return SECRET_PREFIX + randomBytes(32).toString('base64');
}

function keyOf(secret: string): Buffer | null {
  if (!secret.startsWith(SECRET_PREFIX)) return null;
  const key = Buffer.from(secret.slice(SECRET_PREFIX.length), 'base64');
  return key.length >= 24 && key.length <= 64 ? key : null;
}

export function signatureOf(secret: string, id: string, timestamp: number, body: string): string {
  const key = keyOf(secret);
  if (key === null) throw new Error('not a signing secret');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`, 'utf8').digest('base64')}`;
}

// a type, not an interface, so that it can be passed where any header record is expected
export type SignedHeaders = {
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
};

export function signedHeaders(secret: string, id: string, now: Date, body: string): SignedHeaders {
  const timestamp = Math.floor(now.getTime() / 1000);
  return { 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': signatureOf(secret, id, timestamp, body) };
}

/**
 * What a RECEIVER does (the example receiver in examples/webhook-receiver uses the same steps; the tests use this to
 * prove that what we send can be checked): the timestamp is recent, and one of the signatures in the header (it may
 * hold several, separated by spaces) matches, compared in constant time.
 */
export function verifySignature(secret: string, headers: Readonly<Record<string, string | undefined>>, body: string, now: Date): boolean {
  const key = keyOf(secret);
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const given = headers['webhook-signature'];
  if (key === null || id === undefined || timestamp === undefined || given === undefined || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(createHmac('sha256', key).update(`${id}.${timestamp}.${body}`, 'utf8').digest('base64'));
  return given.split(' ').some((part) => {
    const [version, value] = part.split(',', 2);
    if (version !== 'v1' || value === undefined) return false;
    const candidate = Buffer.from(value);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
}
