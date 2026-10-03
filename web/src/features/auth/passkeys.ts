// Talking to the device's passkey (fingerprint, face, security key). Behind a small interface so
// the screens can be tested without a real authenticator.
import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';

export interface Passkeys {
  supported(): boolean;
  /** Asks the device to prove it holds the passkey. Returns what the API needs to check it. */
  authenticate(options: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Creates a new passkey on the device. */
  register(options: Record<string, unknown>): Promise<Record<string, unknown>>;
}

type AuthOptions = Parameters<typeof startAuthentication>[0]['optionsJSON'];
type RegOptions = Parameters<typeof startRegistration>[0]['optionsJSON'];

export const browserPasskeys: Passkeys = {
  supported: () => browserSupportsWebAuthn(),
  authenticate: async (options) => ({ ...(await startAuthentication({ optionsJSON: options as unknown as AuthOptions })) }),
  register: async (options) => ({ ...(await startRegistration({ optionsJSON: options as unknown as RegOptions })) }),
};

/** A device refusal ("cancelled", "timed out") in words a person can act on. */
export function passkeyProblem(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'AbortError') return 'The passkey was not used: the request was cancelled or timed out. Try again.';
  if (name === 'InvalidStateError') return 'This device already holds a passkey for this card.';
  return 'This device could not use a passkey. Try again, or use an authenticator app instead.';
}
