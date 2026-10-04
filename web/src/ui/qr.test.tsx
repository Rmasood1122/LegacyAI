// The QR code of a card: what it holds is proved by reading it back with an independent decoder (jsQR,
// a test-only package), not by trusting the encoder.
import { render, screen } from '@testing-library/react';
import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { signInAddress } from '../navigation/cardLink.ts';
import { QrCode, qrModules, qrPath } from './qr.tsx';

const CARD = 'LGY-1234-5678-9012-3456';
const ORIGIN = 'https://app.legacyai.test';

/** Paints the modules as an image (8 pixels a module, 4 modules of white border) and reads it back. */
function decode(modules: boolean[][]): string | null {
  const scale = 8;
  const quiet = 4;
  const side = (modules.length + 2 * quiet) * scale;
  const pixels = new Uint8ClampedArray(side * side * 4).fill(255);
  modules.forEach((row, y) => row.forEach((dark, x) => {
    if (!dark) return;
    for (let dy = 0; dy < scale; dy += 1) {
      for (let dx = 0; dx < scale; dx += 1) {
        const at = (((y + quiet) * scale + dy) * side + (x + quiet) * scale + dx) * 4;
        pixels[at] = 0;
        pixels[at + 1] = 0;
        pixels[at + 2] = 0;
      }
    }
  }));
  return jsQR(pixels, side, side)?.data ?? null;
}

describe('the QR code of a card', () => {
  it('holds exactly the sign-in address with the card number in the fragment - read back by an independent decoder', () => {
    const address = signInAddress(ORIGIN, CARD);
    expect(address).toBe('https://app.legacyai.test/#card=LGY-1234-5678-9012-3456');
    expect(decode(qrModules(address as string))).toBe(address);
  });

  it('reads back other texts too, so the check above is not a coincidence', () => {
    for (const text of ['a', 'http://localhost:8787/#card=LGY-0000-0000-0000-0000', 'Synthetic text with spaces, punctuation: ? & = % and a longer tail to force a bigger code.']) {
      expect(decode(qrModules(text))).toBe(text);
    }
  });

  it('is a square with the three finder patterns, drawn as one path inside a labelled picture', () => {
    const modules = qrModules(signInAddress(ORIGIN, CARD) as string);
    expect(modules.every((row) => row.length === modules.length)).toBe(true);
    const corner = (r: number, c: number): boolean => [0, 6].every((d) => modules[r + d]?.[c] === true && modules[r]?.[c + d] === true);
    expect(corner(0, 0) && corner(0, modules.length - 7) && corner(modules.length - 7, 0)).toBe(true);
    expect(qrPath([[true, false], [false, true]])).toBe('M4 4h1v1h-1zM5 5h1v1h-1z');
    render(<QrCode text="x" label="QR code for a synthetic card" />);
    const picture = screen.getByRole('img', { name: 'QR code for a synthetic card' });
    expect(picture.querySelector('path')?.getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/);
    expect(picture.getAttribute('style')).toBeNull();
  });
});
