// The address a card's QR code holds, and reading it back. The two directions are tested against each other, and the
// card-number pattern is compared with the API contract's, so the web app cannot drift from what the API issues.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CARD_NUMBER_PATTERN, cardNumberFromFragment, dropCardFragment, isCardNumber, signInAddress } from './cardLink.ts';

const CARD = 'LGY-1234-5678-9012-3456';
const ORIGIN = 'https://app.legacyai.test';

describe('the address in the QR code', () => {
  it('is made only for something shaped like a card number, and never holds anything else', () => {
    expect(signInAddress(ORIGIN, CARD)).toBe(`${ORIGIN}/#card=${CARD}`);
    expect(signInAddress(ORIGIN, 'not a card')).toBeNull();
    expect(signInAddress(ORIGIN, `${CARD}&sc=123`)).toBeNull();
    expect(isCardNumber(CARD)).toBe(true);
  });

  it('what is written is what is read back (both directions, against each other)', () => {
    for (const card of [CARD, 'LGY-0000-0000-0000-0000', 'LGY-9999-9999-9999-9999']) {
      const address = signInAddress(ORIGIN, card);
      expect(address).not.toBeNull();
      expect(cardNumberFromFragment(new URL(address as string).hash)).toBe(card);
    }
  });

  it('a fragment is read only when it is exactly "#card=<card number>"', () => {
    expect(cardNumberFromFragment(`#card=${CARD}`)).toBe(CARD);
    for (const bad of ['', '#', `#card=${CARD}&sc=123`, `#Card=${CARD}`, '#card=LGY-1234', `#card=${CARD} `, '#card=<script>alert(1)</script>',
      `#other=${CARD}`, `#card=${'9'.repeat(500)}`, `?card=${CARD}`]) {
      expect(cardNumberFromFragment(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('uses the card-number pattern of the API contract, character for character', () => {
    // the tests run with web/ as the working directory (as `npm test` and CI do)
    const contract = readFileSync(path.resolve(process.cwd(), '..', 'services', 'api', 'openapi.yaml'), 'utf8');
    expect(contract).toContain(`pattern: ${CARD_NUMBER_PATTERN}\n`);
  });

  it('a card-number fragment is taken out of the address bar; any other fragment is left alone', () => {
    const history = { replaceState: vi.fn() };
    dropCardFragment({ hash: `#card=${CARD}`, pathname: '/knowledge', search: '?x=1' }, history);
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/knowledge?x=1');
    history.replaceState.mockClear();
    for (const hash of ['', '#main', '#card=nope']) dropCardFragment({ hash, pathname: '/', search: '' }, history);
    expect(history.replaceState).not.toHaveBeenCalled();
  });
});
