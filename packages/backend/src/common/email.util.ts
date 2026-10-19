import { Logger } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';

/**
 * One address, one account.
 *
 * `users.email` used to be stored exactly as typed and looked up the same way,
 * so `Name@Example.com` and `name@example.com` were two different people: a
 * user who registered with capitals and later typed the address in lower case
 * could not sign in, signed up again, and got a second, empty workspace with a
 * second trial, while anything bought on the first one stayed there.
 *
 * Every address is now normalised before it is written, and every lookup by
 * address is case-insensitive, so rows written before the change are still
 * found. Rows that only differ in case already exist in the database; they
 * are left for an operator to merge (see
 * scripts/report-duplicate-emails.sql), and a lookup that meets them picks one
 * deterministically (see `pickEmailMatch`) rather than failing.
 */

/** Trimmed and lower-cased. The only form an address is written in. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Whether two addresses are the same address, ignoring case and surrounding spaces. */
export function sameEmail(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = normalizeEmail(a);
  return left !== '' && left === normalizeEmail(b);
}

/**
 * Prisma's case-insensitive `equals` is `ILIKE` on PostgreSQL, unescaped: an
 * `_` or `%` in the address would act as a wildcard, and `a_b@example.com`
 * would also match `axb@example.com`. Escaped here, and the rows are checked
 * again in code (`findUsersByEmail`), so a match is always the same address.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * `where` for the rows whose `email` column equals `email` in any case (users,
 * invitations). The exact forms are matched by plain equality too, so they are
 * found even if the insensitive branch ever stops treating the escapes as
 * escapes. Callers must still filter the rows with `sameEmail`;
 * `findUsersByEmail` does.
 */
export function emailLookupWhere(email: string): { OR: Array<{ email: Prisma.StringFilter }> } {
  const trimmed = email.trim();
  const normalized = normalizeEmail(email);
  return {
    OR: [
      { email: { in: [...new Set([trimmed, normalized])] } },
      { email: { equals: escapeLikePattern(normalized), mode: 'insensitive' } },
    ],
  };
}

type EmailRow = { email: string; createdAt?: Date | null; updatedAt?: Date | null };

/**
 * The account an address means when several rows share it in different case
 * (written before addresses were normalised): the row spelled exactly as
 * typed, otherwise the most recently updated, then the most recently created.
 * Never null for a non-empty list.
 */
export function pickEmailMatch<T extends EmailRow>(rows: T[], typed: string): T | null {
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];
  const exact = rows.find((r) => r.email === typed.trim());
  if (exact) return exact;
  const time = (d: Date | null | undefined) => (d ? new Date(d).getTime() : 0);
  return [...rows].sort(
    (a, b) => time(b.updatedAt) - time(a.updatedAt) || time(b.createdAt) - time(a.createdAt),
  )[0];
}

/** Anything with a `user.findMany`: PrismaService, or a transaction client. */
type UserFinder = { user: { findMany: (args: any) => Promise<unknown[]> } };

const logger = new Logger('EmailLookup');

/** Every user row whose address is `email`, in any case. */
export async function findUsersByEmail<T extends EmailRow>(
  db: UserFinder,
  email: string,
  select?: Prisma.UserSelect,
): Promise<T[]> {
  if (!normalizeEmail(email)) return [];
  const rows = (await db.user.findMany({
    where: emailLookupWhere(email),
    // The tie-break in pickEmailMatch and the duplicate warning read these.
    ...(select ? { select: { ...select, id: true, email: true, createdAt: true, updatedAt: true } } : {}),
  })) as T[];
  return rows.filter((r) => sameEmail(r.email, email));
}

/**
 * The user an address belongs to, matched case-insensitively, or null. When
 * more than one row matches (legacy duplicates), see `pickEmailMatch`.
 */
export async function findUserByEmail<T extends EmailRow>(
  db: UserFinder,
  email: string | null | undefined,
  select?: Prisma.UserSelect,
): Promise<T | null> {
  if (typeof email !== 'string') return null;
  const rows = await findUsersByEmail<T>(db, email, select);
  if (rows.length > 1) {
    // Ids only: these are accounts an operator should merge by hand.
    const ids = rows.map((r) => (r as { id?: string }).id).filter(Boolean);
    logger.warn(`${rows.length} accounts share one address in different case${ids.length ? ` (${ids.join(', ')})` : ''}`);
  }
  return pickEmailMatch(rows, email);
}
