// Handing the browser a file to save, and CSV text. Generic browser helpers with no knowledge of any feature: they
// live here so that two features needing them do not each keep a copy (features may not import each other).

/** How long the temporary address of a saved file is kept, so the browser has time to start the download. */
const KEEP_MS = 60_000;

/**
 * Hands the browser a file to save. Nothing leaves the browser: the text is already here.
 * The link is put into the page for the click (some browsers ignore a click on a link that is not in the page), and
 * the temporary address is released later, not at once (releasing it at once can cancel the download).
 */
export function saveAsFile(name: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), KEEP_MS);
}

/** Rows as CSV text: every field quoted, quotes doubled, and a leading = + - @ made harmless for spreadsheets. */
export function toCsv(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number | null>>): string {
  const cell = (v: string | number | null): string => {
    const text = v === null ? '' : String(v);
    const safe = /^[=+\-@\t\r]/.test(text) && typeof v === 'string' ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
