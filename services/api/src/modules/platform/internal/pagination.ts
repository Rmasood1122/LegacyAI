// Cursors of paged lists, in one place. A cursor is opaque to the client; whatever arrives is checked here, so a
// malformed one is a 400 and never reaches a database cast.
import { isUuid } from '../../../shared/crypto.ts';
import { problems } from '../../../shared/errors.ts';

const invalid = (): Error => problems.badRequest([{ path: 'query/cursor', message: 'invalid cursor' }]);

export function encodeCursor(value: string | number): string {
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

/** A cursor made of hex digits and dashes: a record id, or the sequence number of the audit log. */
export function decodeCursor(cursor: unknown): string | null {
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor !== 'string') throw invalid();
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^[0-9a-f-]{1,40}$/.test(text)) throw invalid();
  return text;
}

/** The cursor of a list ordered by record id. Anything that is not such an id is a 400 here, never an error from the database's uuid cast. */
export function decodeIdCursor(cursor: unknown): string | null {
  const value = decodeCursor(cursor);
  if (value !== null && !isUuid(value)) throw invalid();
  return value;
}

/** Longest name a name cursor carries (the limit of a job role's name). */
export const NAME_CURSOR_MAX_CHARS = 120;

/** The cursor of a list ordered by NAME (job roles are names, not records): the last name of the page. */
export function encodeNameCursor(name: string): string {
  return Buffer.from(name, 'utf8').toString('base64url');
}

/**
 * Accepts every name encodeNameCursor() can have produced - also a name stored before today's rules for job-role
 * names, so an old name with a tab in it cannot break the following page. Refused: not text, empty, too long, bytes
 * that are not valid UTF-8 (they decode to U+FFFD) and NUL (the database refuses it with an error).
 */
export function decodeNameCursor(cursor: unknown): string | null {
  if (cursor === undefined || cursor === null) return null;
  if (typeof cursor !== 'string') throw invalid();
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  // counted in characters (code points), as the contract and the database count a name's length
  if (text.length < 1 || [...text].length > NAME_CURSOR_MAX_CHARS || /[\u0000\ufffd]/.test(text)) throw invalid();
  return text;
}

/** One page out of `limit + 1` fetched rows, and the cursor of the next page (null when this was the last). */
export function pageOf<T>(rows: T[], limit: number, cursorOf: (last: T) => string): { items: T[]; next_cursor: string | null } {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, next_cursor: rows.length > limit && last !== undefined ? cursorOf(last) : null };
}
