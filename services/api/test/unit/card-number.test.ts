import { describe, expect, it } from 'vitest';
import {
  dammCheckDigit, dammValid, formatCardNumber, generateCardNumber, isValidCardNumber, luhnValid, maskCardNumber, normalizeCardNumber,
} from '../../src/modules/identity-access/index.ts';

describe('Damm check digit', () => {
  it('matches the published example (572 -> 4)', () => {
    expect(dammCheckDigit('572')).toBe('4');
    expect(dammValid('5724')).toBe(true);
  });

  it('rejects anything that is not digits', () => {
    expect(dammValid('57a4')).toBe(false);
    expect(dammValid('')).toBe(false);
    expect(() => dammCheckDigit('12x')).toThrow();
  });

  it('detects EVERY single-digit error in 200 generated card numbers (200 x 16 x 9 = 28,800 mutations)', () => {
    let mutations = 0;
    for (let n = 0; n < 200; n += 1) {
      const card = generateCardNumber();
      for (let pos = 0; pos < card.length; pos += 1) {
        for (let d = 0; d <= 9; d += 1) {
          if (String(d) === card[pos]) continue;
          const wrong = card.slice(0, pos) + String(d) + card.slice(pos + 1);
          mutations += 1;
          expect(dammValid(wrong), `single-digit error not detected: ${card} -> ${wrong}`).toBe(false);
        }
      }
    }
    expect(mutations).toBe(200 * 16 * 9);
  });

  it('detects EVERY swap of two different adjacent digits, for all 100 digit pairs at every position', () => {
    // Exhaustive over the pair being swapped: prefix x a b x suffix for every a != b.
    let swaps = 0;
    for (const prefix of ['', '7', '0412', '99999999']) {
      for (let a = 0; a <= 9; a += 1) {
        for (let b = 0; b <= 9; b += 1) {
          if (a === b) continue;
          const body = `${prefix}${a}${b}31`;
          const valid = body + dammCheckDigit(body);
          const swappedBody = `${prefix}${b}${a}31`;
          const swapped = swappedBody + valid.slice(-1);
          swaps += 1;
          expect(dammValid(valid)).toBe(true);
          expect(dammValid(swapped), `transposition not detected: ${valid} -> ${swapped}`).toBe(false);
        }
      }
    }
    expect(swaps).toBe(4 * 90);
  });

  it('shows why Luhn was rejected: it misses the 09 <-> 90 swap, Damm does not', () => {
    const a = '4000000000000902';
    const b = '4000000000009002';
    expect(luhnValid(a)).toBe(luhnValid(b)); // Luhn cannot tell them apart
    const body = '400000000000090';
    const good = body + dammCheckDigit(body);
    const swapped = `400000000000900${good.slice(-1)}`;
    expect(dammValid(good)).toBe(true);
    expect(dammValid(swapped)).toBe(false);
  });
});

describe('card number generation', () => {
  it('produces 16 digits with a valid check digit', () => {
    for (let i = 0; i < 500; i += 1) {
      const n = generateCardNumber();
      expect(n).toMatch(/^[0-9]{16}$/);
      expect(isValidCardNumber(n)).toBe(true);
    }
  });

  it('never produces a number that passes the payment-card (Luhn) check - 20,000 samples', () => {
    for (let i = 0; i < 20_000; i += 1) {
      expect(luhnValid(generateCardNumber())).toBe(false);
    }
  });

  it('is not sequential and does not repeat in 20,000 samples', () => {
    const seen = new Set<string>();
    let previous = 0n;
    let increasingRuns = 0;
    for (let i = 0; i < 20_000; i += 1) {
      const n = generateCardNumber();
      expect(seen.has(n)).toBe(false);
      seen.add(n);
      if (BigInt(n) === previous + 1n) increasingRuns += 1;
      previous = BigInt(n);
    }
    expect(increasingRuns).toBe(0);
  });

  it('uses the random source it is given, digit by digit, and refuses a broken source', () => {
    const digits = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1, 2, 3, 4, 6];
    let i = 0;
    const n = generateCardNumber(() => digits[i++ % digits.length] as number);
    expect(n.slice(0, 15)).toBe('123456789012346');
    expect(() => generateCardNumber(() => 10)).toThrow();
    expect(() => generateCardNumber(() => Number.NaN)).toThrow();
    expect(() => generateCardNumber(() => 0.5)).toThrow();
  });

  it('first digits are spread across 0-9 (rough uniformity check)', () => {
    const counts = new Array<number>(10).fill(0);
    for (let i = 0; i < 20_000; i += 1) counts[Number(generateCardNumber()[0])]! += 1;
    for (const c of counts) expect(c).toBeGreaterThan(1500); // expected ~2000 each
  });
});

describe('formatting and parsing', () => {
  const n = (() => {
    const body = '482193760152773';
    return body + dammCheckDigit(body);
  })();

  it('displays with the LGY- prefix in groups of four', () => {
    expect(formatCardNumber(n)).toBe(`LGY-4821-9376-0152-773${n[15]}`);
    expect(maskCardNumber(n)).toBe(`LGY-****-****-****-773${n[15]}`);
  });

  it('accepts the number with or without prefix, spaces or dashes', () => {
    for (const typed of [n, formatCardNumber(n), formatCardNumber(n).toLowerCase(), `${n.slice(0, 4)} ${n.slice(4, 8)} ${n.slice(8, 12)} ${n.slice(12)}`, ` ${n} `]) {
      expect(normalizeCardNumber(typed)).toBe(n);
    }
  });

  it('rejects wrong length, wrong check digit and non-strings', () => {
    const wrongCheck = n.slice(0, 15) + String((Number(n[15]) + 1) % 10);
    for (const bad of [wrongCheck, n.slice(0, 15), `${n}1`, '', 'LGY-', null, undefined, 1234, {}, 'x'.repeat(100)]) {
      expect(normalizeCardNumber(bad)).toBeNull();
    }
  });
});
