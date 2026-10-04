// The address a card's QR code holds: the sign-in screen with the CARD NUMBER filled in.
//
// What is in it: the card number only - never the 3-digit code, a token or a session. A card number
// alone signs nobody in (the API demands the 3-digit code AND a passkey or an authenticator code).
// Where it is: in the FRAGMENT (after "#"), which browsers do not send to the server, so it does not
// reach access logs or a Referer header. The sign-in screen reads it once and removes it.

/**
 * The shape of a card number as the API issues it - the same pattern, character for character, as the contract's
 * (services/api/openapi.yaml; a test compares the two). Anything else in a fragment is ignored.
 */
export const CARD_NUMBER_PATTERN = '^LGY-[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{4}$';
const CARD_NUMBER = new RegExp(CARD_NUMBER_PATTERN);
const KEY = 'card';

export const isCardNumber = (value: string): boolean => CARD_NUMBER.test(value);

/** The sign-in address for a card, or null when the number does not have the shape of one. */
export function signInAddress(origin: string, cardNumber: string): string | null {
  return isCardNumber(cardNumber) ? `${origin}/#${KEY}=${cardNumber}` : null;
}

/** The card number a fragment carries ("#card=LGY-…"), or null: wrong key, wrong shape, anything extra. */
export function cardNumberFromFragment(fragment: string): string | null {
  if (fragment.length > 64 || !fragment.startsWith(`#${KEY}=`)) return null;
  const value = fragment.slice(KEY.length + 2);
  return isCardNumber(value) ? value : null;
}

/**
 * Takes a card-number fragment out of the address bar, wherever the visitor is - signed in or not - so the number is
 * not left in the history entry or copied along with the address. Any other fragment is left alone.
 */
export function dropCardFragment(location: Pick<Location, 'hash' | 'pathname' | 'search'>, history: Pick<History, 'replaceState'>): void {
  if (cardNumberFromFragment(location.hash) !== null) history.replaceState(null, '', location.pathname + location.search);
}
