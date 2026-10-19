import {
  emailLookupWhere,
  findUserByEmail,
  findUsersByEmail,
  normalizeEmail,
  pickEmailMatch,
  sameEmail,
} from './email.util';

describe('normalizeEmail', () => {
  it('trims and lower-cases', () => {
    expect(normalizeEmail('  Name@Example.COM ')).toBe('name@example.com');
  });

  it('leaves an already normalised address alone', () => {
    expect(normalizeEmail('name@example.com')).toBe('name@example.com');
  });
});

describe('sameEmail', () => {
  it('ignores case and surrounding spaces', () => {
    expect(sameEmail('NAME@example.com', ' name@EXAMPLE.com')).toBe(true);
  });

  it('is false for different addresses, empty values and non-strings', () => {
    expect(sameEmail('a@example.com', 'b@example.com')).toBe(false);
    expect(sameEmail('', '')).toBe(false);
    expect(sameEmail(null, 'a@example.com')).toBe(false);
    expect(sameEmail('a@example.com', undefined)).toBe(false);
  });
});

describe('emailLookupWhere', () => {
  it('matches the exact spellings and the address in any case', () => {
    expect(emailLookupWhere(' Name@Example.com')).toEqual({
      OR: [
        { email: { in: ['Name@Example.com', 'name@example.com'] } },
        { email: { equals: 'name@example.com', mode: 'insensitive' } },
      ],
    });
  });

  it('escapes LIKE wildcards, which Prisma passes to ILIKE as they are', () => {
    const where = emailLookupWhere('a_b%c\\d@example.com');
    expect(where.OR[1]).toEqual({
      email: { equals: 'a\\_b\\%c\\\\d@example.com', mode: 'insensitive' },
    });
  });
});

describe('pickEmailMatch', () => {
  const older = { id: 'old', email: 'NAME@example.com', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-02-01') };
  const newer = { id: 'new', email: 'name@example.com', createdAt: new Date('2026-03-01'), updatedAt: new Date('2026-03-01') };
  const touched = { id: 'touched', email: 'Name@Example.com', createdAt: new Date('2025-12-01'), updatedAt: new Date('2026-04-01') };

  it('returns null for no rows and the row for one', () => {
    expect(pickEmailMatch([], 'x@example.com')).toBeNull();
    expect(pickEmailMatch([older], 'name@example.com')).toBe(older);
  });

  it('prefers the row spelled exactly as typed', () => {
    expect(pickEmailMatch([older, newer, touched], 'NAME@example.com')).toBe(older);
    expect(pickEmailMatch([older, newer, touched], ' name@example.com ')).toBe(newer);
  });

  it('otherwise takes the most recently updated row', () => {
    expect(pickEmailMatch([older, newer, touched], 'nAmE@example.com')).toBe(touched);
  });

  it('breaks an updatedAt tie on createdAt', () => {
    const a = { id: 'a', email: 'X@example.com', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-05-01') };
    const b = { id: 'b', email: 'x@EXAMPLE.com', createdAt: new Date('2026-02-01'), updatedAt: new Date('2026-05-01') };
    expect(pickEmailMatch([a, b], 'x@example.COM')?.id).toBe('b');
  });
});

describe('findUsersByEmail / findUserByEmail', () => {
  const db = (rows: Array<Record<string, unknown>>) => ({ user: { findMany: jest.fn().mockResolvedValue(rows) } });

  it('finds a row stored with capitals from a lower-case address', async () => {
    const prisma = db([{ id: 'u1', email: 'Name@Example.com' }]);
    const user = await findUserByEmail<any>(prisma, 'name@example.com');
    expect(user?.id).toBe('u1');
    expect(prisma.user.findMany).toHaveBeenCalledWith({ where: emailLookupWhere('name@example.com') });
  });

  it('drops rows that are not the same address (a wildcard match)', async () => {
    const prisma = db([
      { id: 'u1', email: 'a_b@example.com' },
      { id: 'u2', email: 'axb@example.com' },
    ]);
    const rows = await findUsersByEmail<any>(prisma, 'A_B@example.com');
    expect(rows.map((r) => r.id)).toEqual(['u1']);
  });

  it('adds the columns the tie-break needs to a narrow select', async () => {
    const prisma = db([]);
    await findUsersByEmail(prisma, 'a@example.com', { name: true });
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: emailLookupWhere('a@example.com'),
      select: { name: true, id: true, email: true, createdAt: true, updatedAt: true },
    });
  });

  it('does not query for an empty or missing address', async () => {
    const prisma = db([{ id: 'u1', email: 'a@example.com' }]);
    expect(await findUserByEmail(prisma, '   ')).toBeNull();
    expect(await findUserByEmail(prisma, undefined)).toBeNull();
    expect(await findUserByEmail(prisma, null)).toBeNull();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('picks the exact spelling among legacy duplicates', async () => {
    const prisma = db([
      { id: 'upper', email: 'NAME@example.com', updatedAt: new Date('2026-01-01') },
      { id: 'lower', email: 'name@example.com', updatedAt: new Date('2026-02-01') },
    ]);
    expect((await findUserByEmail<any>(prisma, 'NAME@example.com'))?.id).toBe('upper');
    expect((await findUserByEmail<any>(prisma, 'Name@Example.com'))?.id).toBe('lower');
  });
});
