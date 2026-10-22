// SCIM (feature 16, part B; D34): what a directory sends, turned into what a person is, and back - the rules that need
// no database. The endpoints against the database are in test/integration/scim.test.ts. Synthetic people only.
import { describe, expect, it } from 'vitest';
import { applyPatch, parseScimFilter, ScimInputError, scimStateOf, toScimUser, type ScimState } from '../../src/modules/identity-access/index.ts';

const jane: ScimState = { userName: 'jane.doe@example.test', displayName: 'Jane Doe', email: 'jane.doe@example.test', active: true, externalId: 'ext-1' };

describe('a User as directories send it', () => {
  it('keeps userName, a display name, one e-mail address (the primary one), active and externalId', () => {
    expect(scimStateOf({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'Jane.Doe@Example.test', externalId: 'ext-1',
      name: { givenName: 'Jane', familyName: 'Doe' }, emails: [{ value: 'other@example.test' }, { value: 'Jane.Doe@Example.test', primary: true, type: 'work' }],
      active: true, phoneNumbers: [{ value: '+00 000' }], 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': { department: 'x' },
    })).toEqual({ userName: 'Jane.Doe@Example.test', displayName: 'Jane Doe', email: 'jane.doe@example.test', active: true, externalId: 'ext-1' });
  });

  it('the display name: displayName, else name.formatted, else given + family name, else userName', () => {
    expect(scimStateOf({ userName: 'u', displayName: 'Shown', name: { formatted: 'Formatted' } }).displayName).toBe('Shown');
    expect(scimStateOf({ userName: 'u', name: { formatted: 'Formatted', givenName: 'G' } }).displayName).toBe('Formatted');
    expect(scimStateOf({ userName: 'u', name: { familyName: 'Family' } }).displayName).toBe('Family');
    expect(scimStateOf({ userName: 'only-user-name' }).displayName).toBe('only-user-name');
  });

  it('active defaults to true and accepts the strings "True"/"False" one large directory sends', () => {
    expect(scimStateOf({ userName: 'u' }).active).toBe(true);
    expect(scimStateOf({ userName: 'u', active: 'False' }).active).toBe(false);
    expect(scimStateOf({ userName: 'u', active: 'true' }).active).toBe(true);
  });

  it.each([
    ['no userName', {}],
    ['a blank userName', { userName: '   ' }],
    ['active that is not a boolean', { userName: 'u', active: 'maybe' }],
    ['an e-mail address that is not one', { userName: 'u', emails: [{ value: 'not-an-address' }] }],
  ])('refused: %s', (_name, body) => {
    expect(() => scimStateOf(body as Record<string, unknown>)).toThrow(ScimInputError);
  });

  it('control characters never reach the database', () => {
    expect(scimStateOf({ userName: 'u', displayName: 'Jane\u0000\nDoe' }).displayName).toBe('Jane  Doe');
  });
});

describe('PATCH', () => {
  it('de-provisioning the way directories do it: replace active with false (also as the string "False", also without a path)', () => {
    expect(applyPatch(jane, [{ op: 'replace', path: 'active', value: false }]).active).toBe(false);
    expect(applyPatch(jane, [{ op: 'Replace', path: 'active', value: 'False' }]).active).toBe(false);
    expect(applyPatch(jane, [{ op: 'replace', value: { active: false } }]).active).toBe(false);
  });

  it('names, user name, external id and the work address', () => {
    const next = applyPatch(jane, [
      { op: 'replace', path: 'name.givenName', value: 'Janet' }, { op: 'replace', path: 'name.familyName', value: 'Roe' },
      { op: 'replace', path: 'userName', value: 'janet.roe@example.test' }, { op: 'remove', path: 'externalId' },
      { op: 'replace', path: 'emails[type eq "work"].value', value: 'Janet.Roe@example.test' },
    ]);
    expect(next).toEqual({ userName: 'janet.roe@example.test', displayName: 'Janet Roe', email: 'janet.roe@example.test', active: true, externalId: null });
    expect(applyPatch(jane, [{ op: 'remove', path: 'emails' }]).email).toBeNull();
    expect(applyPatch(jane, [{ op: 'replace', path: 'displayName', value: 'J. Doe' }]).displayName).toBe('J. Doe');
  });

  it('attributes it does not store are ignored, as a directory\'s usual update carries them (title, phone, the enterprise extension)', () => {
    expect(applyPatch(jane, [
      { op: 'replace', path: 'title', value: 'x' }, { op: 'Add', path: 'phoneNumbers[type eq "work"].value', value: '+00 000' },
      { op: 'replace', path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department', value: 'Ops' },
      { op: 'Replace', path: 'active', value: 'False' },
    ])).toEqual({ ...jane, active: false });
  });

  it('a display name built from long given and family names fits the 200 characters a person\'s name may have', () => {
    expect(scimStateOf({ userName: 'u', name: { givenName: 'G'.repeat(100), familyName: 'F'.repeat(100) } }).displayName).toHaveLength(200);
    expect(scimStateOf({ userName: 'a\u0085b\u2028c' }).userName).toBe('a b c');
  });

  it.each([
    ['groups (roles are given by an administrator, never by the directory)', [{ op: 'add', path: 'groups', value: [{ value: 'admins' }] }]],
    ['roles', [{ op: 'add', path: 'roles', value: [{ value: 'admin' }] }]],
    ['a password', [{ op: 'replace', path: 'password', value: 'x' }]],
    ['an unknown op', [{ op: 'move', path: 'active', value: true }]],
    ['removing userName', [{ op: 'remove', path: 'userName' }]],
    ['removing active', [{ op: 'remove', path: 'active' }]],
    ['remove without a path', [{ op: 'remove' }]],
  ])('refused: %s', (_name, ops) => {
    expect(() => applyPatch(jane, ops)).toThrow(ScimInputError);
  });
});

describe('filter', () => {
  it('finds by userName or externalId, the one filter directories need', () => {
    expect(parseScimFilter('userName eq "jane.doe@example.test"')).toEqual({ attribute: 'userName', value: 'jane.doe@example.test' });
    expect(parseScimFilter('USERNAME EQ "a\\"b"')).toEqual({ attribute: 'userName', value: 'a"b' });
    expect(parseScimFilter('externalId eq "ext-1"')).toEqual({ attribute: 'externalId', value: 'ext-1' });
    expect(parseScimFilter(undefined)).toBeNull();
    expect(parseScimFilter('')).toBeNull();
  });

  it.each(['userName co "jane"', 'displayName eq "x"', 'userName eq "a" or userName eq "b"', 'userName eq jane'])('refused: %s', (f) => {
    expect(() => parseScimFilter(f)).toThrow(ScimInputError);
  });
});

describe('what the directory is shown', () => {
  it('only the attributes stored here, and no internal detail of the person', () => {
    const user = toScimUser({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', display_name: 'Jane Doe', email: null, status: 'departed', scim_user_name: 'jane', external_id: null,
      created_at: new Date('2026-10-01T00:00:00Z'), updated_at: new Date('2026-10-02T00:00:00Z'),
    }, '/v1/scim/v2/Users/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    expect(user).toEqual({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', userName: 'jane', displayName: 'Jane Doe',
      emails: [], active: false,
      meta: { resourceType: 'User', created: '2026-10-01T00:00:00.000Z', lastModified: '2026-10-02T00:00:00.000Z', location: '/v1/scim/v2/Users/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
    });
  });
});
