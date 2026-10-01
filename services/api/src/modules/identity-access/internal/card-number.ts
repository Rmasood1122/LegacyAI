// Card numbers: 15 random digits + 1 Damm check digit.
//
// The card number is an IDENTIFIER, not a secret. The check digit catches typing
// mistakes only - it is NOT a security control (anyone can compute one).
import { randomInt } from 'node:crypto';

// Damm's totally anti-symmetric quasigroup of order 10 (H. M. Damm, 2004).
// Detects every single-digit error and every swap of two adjacent digits.
const DAMM: ReadonlyArray<ReadonlyArray<number>> = [
  [0, 3, 1, 7, 5, 9, 8, 6, 4, 2],
  [7, 0, 9, 2, 1, 5, 4, 8, 6, 3],
  [4, 2, 0, 6, 8, 7, 1, 3, 5, 9],
  [1, 7, 5, 0, 9, 8, 3, 4, 2, 6],
  [6, 1, 2, 3, 0, 4, 5, 9, 7, 8],
  [3, 6, 7, 4, 2, 0, 9, 5, 8, 1],
  [5, 8, 6, 9, 7, 2, 0, 1, 3, 4],
  [8, 9, 4, 5, 3, 6, 2, 0, 1, 7],
  [9, 4, 3, 8, 6, 1, 7, 2, 0, 5],
  [2, 5, 8, 1, 4, 3, 6, 7, 9, 0],
];

const DIGITS_ONLY = /^[0-9]+$/;

function dammInterim(digits: string): number {
  if (!DIGITS_ONLY.test(digits)) throw new Error('damm: input must be digits only');
  let interim = 0;
  for (const ch of digits) {
    interim = (DAMM[interim] as ReadonlyArray<number>)[ch.charCodeAt(0) - 48] as number;
  }
  return interim;
}

/** The digit that, appended to `digits`, makes the whole string valid. */
export function dammCheckDigit(digits: string): string {
  return String(dammInterim(digits));
}

/** True when `digits` (including its last, check digit) is consistent. */
export function dammValid(digits: string): boolean {
  return DIGITS_ONLY.test(digits) && dammInterim(digits) === 0;
}

/** The payment-card (Luhn) check. Used only to make sure we NEVER issue a number that passes it. */
export function luhnValid(digits: string): boolean {
  if (!DIGITS_ONLY.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export const CARD_NUMBER_LENGTH = 16;

export function isValidCardNumber(digits: string): boolean {
  return digits.length === CARD_NUMBER_LENGTH && dammValid(digits);
}

/**
 * Generates a card number from the operating system's CSPRNG. Never sequential.
 * Numbers that would also pass the payment-card (Luhn) check are discarded, so a
 * LegacyAI card number can never validate as a bank card number.
 */
export function generateCardNumber(randomDigit: () => number = () => randomInt(0, 10)): string {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    let body = '';
    for (let i = 0; i < CARD_NUMBER_LENGTH - 1; i += 1) {
      const d = randomDigit();
      if (!Number.isInteger(d) || d < 0 || d > 9) throw new Error('card number: random source returned a non-digit');
      body += String(d);
    }
    const full = body + dammCheckDigit(body);
    if (!luhnValid(full)) return full;
  }
  throw new Error('card number: random source keeps producing unusable numbers');
}

/**
 * Accepts what a person might type - "LGY-1234-5678-9012-3456", "1234 5678 9012 3456",
 * "1234567890123456" - and returns the 16 digits, or null if it is not a well-formed,
 * check-digit-valid card number.
 */
export function normalizeCardNumber(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 40) return null;
  const digits = input.trim().replace(/^lgy/i, '').replace(/[\s-]/g, '');
  return isValidCardNumber(digits) ? digits : null;
}

/** The one display format: LGY-1234-5678-9012-3456. */
export function formatCardNumber(digits: string): string {
  return `LGY-${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8, 12)}-${digits.slice(12, 16)}`;
}

export function maskCardNumber(digits: string): string {
  return `LGY-****-****-****-${digits.slice(12, 16)}`;
}
