import {
  coerceActive,
  displayNameOf,
  memberIdFromPath,
  parseExcluded,
  parseFilter,
  parsePagination,
  parsePatch,
  readUser,
} from './scim.parser';
import { ScimError } from './scim.errors';

/**
 * Every shape here was taken from Microsoft's SCIM tutorial or observed from
 * a real Entra tenant. A parser that handles only the RFC's canonical forms
 * fails the first provisioning cycle.
 */
describe('ScimParser', () => {
  describe('parseFilter', () => {
    it('reads the equality filters Entra uses', () => {
      expect(parseFilter('userName eq "a@b.c"')).toEqual({ attr: 'userName', value: 'a@b.c' });
      expect(parseFilter('externalId eq "0f3d"')).toEqual({ attr: 'externalId', value: '0f3d' });
      expect(parseFilter('displayName eq "GB Test"')).toEqual({ attr: 'displayName', value: 'GB Test' });
      expect(parseFilter('emails[type eq "work"].value eq "a@b.c"')).toEqual({ attr: 'emails.value', value: 'a@b.c' });
    });

    it('is case-insensitive on the attribute and the operator, and unescapes quotes', () => {
      expect(parseFilter('  UserName EQ "Team \\"A\\""  ')).toEqual({ attr: 'userName', value: 'Team "A"' });
    });

    it('returns null when absent', () => {
      expect(parseFilter(undefined)).toBeNull();
      expect(parseFilter('')).toBeNull();
    });

    // An ignored filter would return the whole list and Entra would take the
    // first entry as the match — so anything unsupported must be refused.
    it('refuses other operators and unknown attributes', () => {
      expect(() => parseFilter('userName co "a"')).toThrow(ScimError);
      expect(() => parseFilter('title eq "x"')).toThrow(ScimError);
      expect(() => parseFilter('userName eq "a" and active eq true')).toThrow(ScimError);
    });
  });

  describe('parsePagination / parseExcluded', () => {
    it('defaults and clamps', () => {
      expect(parsePagination({})).toEqual({ startIndex: 1, count: 100 });
      expect(parsePagination({ startIndex: '0', count: '5000' })).toEqual({ startIndex: 1, count: 200 });
      expect(parsePagination({ startIndex: 'x', count: '-1' })).toEqual({ startIndex: 1, count: 1 });
    });
    it('reads excludedAttributes', () => {
      expect(parseExcluded({ excludedAttributes: 'members, groups' })).toEqual(new Set(['members', 'groups']));
    });
  });

  describe('parsePatch', () => {
    const wrap = (ops: unknown[]) => ({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: ops });

    it('lower-cases the capitalised ops Entra emits', () => {
      const ops = parsePatch(wrap([
        { op: 'Replace', path: 'active', value: false },
        { op: 'Add', path: 'members', value: [{ value: 'u1' }] },
        { op: 'Remove', path: 'members[value eq "u1"]' },
      ]));
      expect(ops.map((o) => o.op)).toEqual(['replace', 'add', 'remove']);
    });

    it('expands a path-less replace with an object value, including nested name and the enterprise URN', () => {
      const ops = parsePatch(wrap([{
        op: 'replace',
        value: {
          active: 'True',
          displayName: 'Anna',
          name: { givenName: 'Anna', familyName: 'Rossi' },
          'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': { department: 'R&D' },
        },
      }]));
      expect(ops).toEqual([
        { op: 'replace', path: 'active', value: 'True' },
        { op: 'replace', path: 'displayName', value: 'Anna' },
        { op: 'replace', path: 'name.givenName', value: 'Anna' },
        { op: 'replace', path: 'name.familyName', value: 'Rossi' },
        { op: 'replace', path: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department', value: 'R&D' },
      ]);
    });

    it('tolerates a missing schemas array but rejects a wrong one', () => {
      expect(parsePatch({ Operations: [{ op: 'replace', path: 'active', value: true }] })).toHaveLength(1);
      expect(() => parsePatch({ schemas: ['urn:x'], Operations: [{ op: 'replace', path: 'active', value: true }] })).toThrow(ScimError);
    });

    it('rejects empty operations and unknown ops', () => {
      expect(() => parsePatch(wrap([]))).toThrow(ScimError);
      expect(() => parsePatch(wrap([{ op: 'move', path: 'x' }]))).toThrow(ScimError);
      expect(() => parsePatch(wrap([{ op: 'replace', value: 'not-an-object' }]))).toThrow(ScimError);
    });
  });

  describe('coerceActive', () => {
    it('accepts booleans and the string forms', () => {
      expect(coerceActive(true)).toBe(true);
      expect(coerceActive('False')).toBe(false);
      expect(coerceActive('true')).toBe(true);
      expect(() => coerceActive('maybe')).toThrow(ScimError);
      expect(() => coerceActive(1)).toThrow(ScimError);
    });
  });

  describe('readUser', () => {
    it('picks the email by primary, then work, then first — lower-cased', () => {
      const base = { userName: 'U@X.com' };
      expect(readUser({ ...base, emails: [{ value: 'A@x', type: 'home' }, { value: 'B@x', type: 'work' }] }).primaryEmail).toBe('b@x');
      expect(readUser({ ...base, emails: [{ value: 'A@x', type: 'home' }, { value: 'C@x', primary: true }] }).primaryEmail).toBe('c@x');
      expect(readUser({ ...base, emails: [{ value: 'A@x' }] }).primaryEmail).toBe('a@x');
      expect(readUser({ ...base }).primaryEmail).toBeUndefined();
    });

    it('requires userName and defaults active to true', () => {
      expect(() => readUser({ active: true })).toThrow(ScimError);
      expect(readUser({ userName: 'u' }).active).toBe(true);
      expect(readUser({ userName: 'u', active: 'False' }).active).toBe(false);
    });
  });

  it('builds a display name from whatever was sent', () => {
    expect(displayNameOf({ displayName: 'Anna R' })).toBe('Anna R');
    expect(displayNameOf({ formattedName: 'Anna Rossi' })).toBe('Anna Rossi');
    expect(displayNameOf({ givenName: 'Anna', familyName: 'Rossi' })).toBe('Anna Rossi');
    expect(displayNameOf({})).toBeNull();
  });

  it('extracts a member id from a filtered path', () => {
    expect(memberIdFromPath('members[value eq "abc"]')).toBe('abc');
    expect(memberIdFromPath('members')).toBeNull();
    expect(memberIdFromPath(undefined)).toBeNull();
  });
});
