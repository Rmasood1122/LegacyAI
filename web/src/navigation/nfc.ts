// NFC cards (feature 4, the NFC half) - PREPARED, not tested with real tags or phones (docs/phase4/09-batch-c-prepared.md).
//
// An NFC tag holds exactly what the card's QR code holds: the sign-in address with the CARD NUMBER (cardLink.ts) -
// never the 3-digit code, a token or a session. A phone that taps the tag opens that address by itself (NDEF URI
// record), so nothing is needed to READ a tag. Writing one needs Web NFC, which only Chrome on Android offers today;
// elsewhere the screen says so. A tag is as public as a printed QR code: a card number alone signs nobody in.
import { signInAddress } from './cardLink.ts';

/** The one NDEF message written to a card's tag: a single URL record. Null when the number is not a card number. */
export function nfcMessageFor(origin: string, cardNumber: string): { records: Array<{ recordType: 'url'; data: string }> } | null {
  const address = signInAddress(origin, cardNumber);
  return address === null ? null : { records: [{ recordType: 'url', data: address }] };
}

/** What the card screen needs from the device. A prop of the screen, so that tests use a stand-in. */
export interface NfcWriter {
  supported(): boolean;
  /** Waits for a tag to be held to the phone and writes the message to it. */
  write(message: NonNullable<ReturnType<typeof nfcMessageFor>>): Promise<void>;
}

interface NdefReaderLike {
  write(message: unknown): Promise<void>;
}
type NdefReaderConstructor = new () => NdefReaderLike;

/** Web NFC (https://w3c.github.io/web-nfc/), when the browser has it. */
export const browserNfc: NfcWriter = {
  supported: () => typeof window !== 'undefined' && 'NDEFReader' in window,
  write: async (message) => {
    const Reader = (window as unknown as { NDEFReader: NdefReaderConstructor }).NDEFReader;
    await new Reader().write(message);
  },
};
