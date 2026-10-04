// A QR code drawn in the browser: no server call, no outside service, and - as the content-security
// policy demands - no inline style or script (an SVG with one path).
import qrcode from 'qrcode-generator';

/** The modules of the QR code for a text (true = dark), error-correction level M, size chosen automatically. */
export function qrModules(text: string): boolean[][] {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => qr.isDark(row, col)));
}

const QUIET = 4; // the empty border a reader needs, in modules (the standard asks for four)

/** One SVG path that draws every dark module as a 1x1 square. */
export function qrPath(modules: boolean[][]): string {
  const parts: string[] = [];
  modules.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) parts.push(`M${x + QUIET} ${y + QUIET}h1v1h-1z`);
  }));
  return parts.join('');
}

export function QrCode({ text, label }: { text: string; label: string }) {
  const modules = qrModules(text);
  const side = modules.length + 2 * QUIET;
  return (
    <svg className="qr" role="img" aria-label={label} viewBox={`0 0 ${side} ${side}`} shapeRendering="crispEdges">
      <rect className="qr-light" width={side} height={side} />
      <path className="qr-dark" d={qrPath(modules)} />
    </svg>
  );
}
