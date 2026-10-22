// SCIM 2.0 (RFC 7643/7644) for people, the part a company directory needs to provision and de-provision them
// (feature 16, part B; docs/phase4/07-sso-scim.md, decision D34). Everything here is pure: what a directory sends,
// turned into what a person is, and back.
//
// What a SCIM "User" is here:
//   id           the person's id
//   userName     the directory's name for the person (unique in the company, not case-sensitive)
//   externalId   the directory's own id for the person (optional)
//   displayName  the person's name as shown (else name.formatted, else given + family name, else userName)
//   emails       one address is kept: the primary one, else the first
//   active       false = the person has left: their cards are revoked
// Nothing else is stored; other attributes a directory sends (phone numbers, groups, the enterprise extension, ...)
// are ignored and not echoed. Groups are not supported: roles are given by an administrator, never by the directory.

export const SCIM_USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_LIST_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_PATCH_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

/** What the directory may set on a person. */
export interface ScimState {
  userName: string;
  displayName: string;
  email: string | null;
  active: boolean;
  externalId: string | null;
}

export interface ScimPersonRow {
  id: string;
  display_name: string;
  email: string | null;
  status: 'active' | 'departed';
  scim_user_name: string;
  external_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export const SCIM_PERSON_COLUMNS = 'people.id, people.display_name, people.email, people.status, people.scim_user_name, people.external_id, people.created_at, people.updated_at';

export function toScimUser(row: ScimPersonRow, location: string): Record<string, unknown> {
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: row.id,
    ...(row.external_id === null ? {} : { externalId: row.external_id }),
    userName: row.scim_user_name,
    displayName: row.display_name,
    emails: row.email === null ? [] : [{ value: row.email, primary: true }],
    active: row.status === 'active',
    meta: { resourceType: 'User', created: row.created_at.toISOString(), lastModified: row.updated_at.toISOString(), location },
  };
}

export class ScimInputError extends Error {}

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  // control characters (C0, DEL, C1) and line/paragraph separators are replaced, never stored
  const t = v.replace(/[\p{Cc}\u2028\u2029]/gu, ' ').trim();
  return t.length === 0 ? null : t.slice(0, max);
};

/** SCIM booleans as directories send them: true/false, and - from one large directory - "True"/"False". */
function bool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string' && /^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  throw new ScimInputError('active must be true or false');
}

function emailOf(emails: unknown): string | null {
  if (!Array.isArray(emails) || emails.length === 0) return null;
  const all = emails.filter((e): e is { value: unknown; primary?: unknown } => e !== null && typeof e === 'object');
  const chosen = all.find((e) => e.primary === true || e.primary === 'true') ?? all[0];
  const value = text(chosen?.value, 254);
  if (value === null) return null;
  const lower = value.toLowerCase();
  if (lower.length < 3 || !/^[^\s@]+@[^\s@]+$/.test(lower)) throw new ScimInputError('emails: not an e-mail address');
  return lower;
}

function displayNameOf(body: Record<string, unknown>, userName: string): string {
  const name = (body.name !== null && typeof body.name === 'object' ? body.name : {}) as Record<string, unknown>;
  const given = text(name.givenName, 100);
  const family = text(name.familyName, 100);
  return text(body.displayName, 200) ?? text(name.formatted, 200) ?? (given || family ? [given, family].filter(Boolean).join(' ').slice(0, 200) : null) ?? userName.slice(0, 200);
}

/** A whole User, as POST and PUT send it. Throws ScimInputError for what cannot be stored. */
export function scimStateOf(body: Record<string, unknown>): ScimState {
  const userName = text(body.userName, 256);
  if (userName === null) throw new ScimInputError('userName is required');
  return {
    userName,
    displayName: displayNameOf(body, userName),
    email: emailOf(body.emails),
    active: body.active === undefined ? true : bool(body.active),
    externalId: body.externalId === undefined || body.externalId === null ? null : text(body.externalId, 256),
  };
}

export function stateOfRow(row: ScimPersonRow): ScimState {
  return { userName: row.scim_user_name, displayName: row.display_name, email: row.email, active: row.status === 'active', externalId: row.external_id };
}

export interface PatchOperation { op: string; path?: string; value?: unknown }

/**
 * PATCH (RFC 7644 3.5.2) on the attributes above. Supported: add / replace / remove of active, displayName, userName,
 * externalId, name.formatted / givenName / familyName, emails (and emails[...].value, the way directories address the
 * work address); a replace without a path carrying an object of those attributes. Attributes that are not stored here
 * are ignored, as POST and PUT ignore them; ones that would give or prove access (groups, roles, entitlements,
 * certificates, a password) throw, so that the directory hears that it was not done instead of believing it was.
 */
export function applyPatch(current: ScimState, operations: readonly PatchOperation[]): ScimState {
  let next = { ...current };
  // name parts that arrive one by one are put together at the end
  let given: string | null | undefined;
  let family: string | null | undefined;
  const set = (path: string, value: unknown, remove: boolean): void => {
    const p = path.trim();
    const lower = p.toLowerCase();
    if (lower === 'active') {
      if (remove) throw new ScimInputError('active cannot be removed');
      next.active = bool(value);
    } else if (lower === 'displayname' || lower === 'name.formatted') {
      const v = remove ? null : text(value, 200);
      next.displayName = v ?? next.userName.slice(0, 200);
    } else if (lower === 'username') {
      const v = remove ? null : text(value, 256);
      if (v === null) throw new ScimInputError('userName cannot be removed');
      next.userName = v;
    } else if (lower === 'externalid') {
      next.externalId = remove ? null : text(value, 256);
    } else if (lower === 'name.givenname') {
      given = remove ? null : text(value, 100);
    } else if (lower === 'name.familyname') {
      family = remove ? null : text(value, 100);
    } else if (lower === 'name') {
      if (remove) throw new ScimInputError('name cannot be removed');
      const n = (value ?? {}) as Record<string, unknown>;
      if (n.formatted !== undefined) next.displayName = text(n.formatted, 200) ?? next.displayName;
      if (n.givenName !== undefined) given = text(n.givenName, 100);
      if (n.familyName !== undefined) family = text(n.familyName, 100);
    } else if (lower === 'emails' || /^emails\[.*\]\.value$/.test(lower) || /^emails\[.*\]$/.test(lower)) {
      if (remove) next.email = null;
      else if (lower === 'emails' || /^emails\[.*\]$/.test(lower)) next.email = emailOf(Array.isArray(value) ? value : [value]);
      else next.email = emailOf([{ value, primary: true }]);
    } else if (/^(groups|roles|entitlements|x509certificates|password)\b/.test(lower)) {
      // what would give or prove access is never taken from the directory: it hears that this was not done
      throw new ScimInputError(`this attribute cannot be changed here: ${p.slice(0, 80)}`);
    }
    // anything else (title, phone numbers, addresses, the enterprise extension, ...) is not stored here and is ignored,
    // as POST and PUT ignore it: a directory's usual update must not fail because it also carries those
  };
  for (const operation of operations) {
    const op = typeof operation.op === 'string' ? operation.op.toLowerCase() : '';
    if (op !== 'add' && op !== 'replace' && op !== 'remove') throw new ScimInputError('op must be add, replace or remove');
    if (typeof operation.path === 'string' && operation.path.length > 0) {
      set(operation.path, operation.value, op === 'remove');
    } else {
      if (op === 'remove') throw new ScimInputError('remove needs a path');
      if (operation.value === null || typeof operation.value !== 'object' || Array.isArray(operation.value)) throw new ScimInputError('value must be an object');
      for (const [k, v] of Object.entries(operation.value as Record<string, unknown>)) {
        if (k === 'schemas' || k === 'id' || k === 'meta') continue;
        set(k, v, false);
      }
    }
  }
  if (given !== undefined || family !== undefined) {
    const joined = [given, family].filter((x): x is string => typeof x === 'string' && x.length > 0).join(' ');
    if (joined.length > 0) next.displayName = joined.slice(0, 200);
  }
  next = { ...next, displayName: next.displayName.length > 0 ? next.displayName : next.userName.slice(0, 200) };
  return next;
}

/** The one filter a directory needs: find a person by userName or externalId (`userName eq "jane@example.com"`). */
export type ScimFilter = { attribute: 'userName' | 'externalId'; value: string };

export function parseScimFilter(filter: string | undefined): ScimFilter | null {
  if (filter === undefined || filter.trim() === '') return null;
  const m = /^\s*(userName|externalId)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  if (m === null) throw new ScimInputError('only filters of the form userName eq "..." or externalId eq "..." are supported');
  const attribute = (m[1] as string).toLowerCase() === 'username' ? 'userName' : 'externalId';
  return { attribute, value: (m[2] as string).replace(/\\(.)/g, '$1') };
}

/** What a directory reads first: what this server supports (RFC 7643 section 5). */
export function serviceProviderConfig(documentation: string): Record<string, unknown> {
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: documentation,
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{
      type: 'oauthbearertoken', name: 'Directory key', primary: true,
      description: 'An API key made for the directory (person:scim only), sent as Authorization: Bearer lak1....',
    }],
  };
}
