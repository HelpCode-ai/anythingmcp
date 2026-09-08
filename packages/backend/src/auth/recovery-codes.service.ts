import { Injectable, Logger } from '@nestjs/common';
import { randomInt } from 'crypto';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../common/prisma.service';
import {
  SecurityEventService,
  SecurityEvents,
} from '../audit/security-event.service';

/** How many codes a generation produces. */
export const CODE_COUNT = 10;

/**
 * Crockford base32 minus the letters that get misread off a printout: I, L, O
 * and U. These codes are meant to be written down and typed back under
 * pressure, when SSO is already broken.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const GROUP = 5;
const GROUPS = 2;

/**
 * Break-glass credentials.
 *
 * A workspace that disables password sign-in and then loses its identity
 * provider has no way back in. These are that way back in — which is why
 * `enforceSso` cannot be enabled until the acting admin holds unused codes.
 */
@Injectable()
export class RecoveryCodesService {
  private readonly logger = new Logger(RecoveryCodesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly securityEvents: SecurityEventService,
  ) {}

  /**
   * Replaces every code the user holds and returns the new ones in plaintext.
   *
   * The plaintext is returned exactly once. Regenerating invalidates the old
   * set on purpose: two live sets means a code someone printed a year ago
   * still works, which is the opposite of what rotation is for.
   */
  async generate(
    userId: string,
    ctx: { organizationId?: string | null; ip?: string | null; userAgent?: string | null } = {},
  ): Promise<string[]> {
    const codes = Array.from({ length: CODE_COUNT }, () => this.mint());

    // bcrypt at the same cost as passwords: these ARE passwords, and a leaked
    // table of fast hashes over a 50-bit space is worth brute-forcing.
    const rows = await Promise.all(
      codes.map(async (code) => ({
        userId,
        // Hash the NORMALISED form. `consume` strips the dash before comparing
        // — so hashing the display form here means no code would ever verify,
        // and the break-glass path would be silently dead until the day it was
        // needed.
        codeHash: await bcrypt.hash(this.normalise(code), 12),
        label: this.labelFor(code),
      })),
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.recoveryCode.deleteMany({ where: { userId } });
      await tx.recoveryCode.createMany({ data: rows });
    });

    await this.securityEvents.log({
      event: SecurityEvents.RECOVERY_CODES_GENERATED,
      actorType: 'USER',
      organizationId: ctx.organizationId ?? null,
      actorUserId: userId,
      targetUserId: userId,
      metadata: { count: codes.length },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return codes;
  }

  /** Counts only — the codes themselves are never readable again. */
  async status(userId: string) {
    const codes = await this.prisma.recoveryCode.findMany({
      where: { userId },
      select: { usedAt: true, createdAt: true },
    });
    return {
      total: codes.length,
      unused: codes.filter((c) => c.usedAt === null).length,
      generatedAt: codes[0]?.createdAt ?? null,
    };
  }

  /** True when the user could still get in if the directory stopped working. */
  async hasUnused(userId: string): Promise<boolean> {
    const count = await this.prisma.recoveryCode.count({
      where: { userId, usedAt: null },
    });
    return count > 0;
  }

  /**
   * Consumes one code. Returns false for both "wrong code" and "already used",
   * which the caller must report identically — distinguishing them tells an
   * attacker which guesses were once valid.
   */
  async consume(
    userId: string,
    supplied: string,
    ctx: { organizationId?: string | null; ip?: string | null; userAgent?: string | null } = {},
  ): Promise<boolean> {
    const normalised = this.normalise(supplied);
    if (normalised.length !== GROUP * GROUPS) return false;

    const candidates = await this.prisma.recoveryCode.findMany({
      where: { userId, usedAt: null },
      select: { id: true, codeHash: true },
    });

    for (const candidate of candidates) {
      if (!(await bcrypt.compare(normalised, candidate.codeHash))) continue;

      // Conditional update: `usedAt: null` in the WHERE makes the consumption
      // atomic, so two requests racing with the same code cannot both win.
      const claimed = await this.prisma.recoveryCode.updateMany({
        where: { id: candidate.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count !== 1) return false;

      await this.securityEvents.log({
        event: SecurityEvents.RECOVERY_CODE_USED,
        actorType: 'USER',
        organizationId: ctx.organizationId ?? null,
        actorUserId: userId,
        targetUserId: userId,
        metadata: {
          remaining: candidates.length - 1,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return true;
    }

    return false;
  }

  // ── Formatting ────────────────────────────────────────────────────────────

  private mint(): string {
    // randomInt is rejection-sampled, so the alphabet stays uniform. `% 32`
    // over a byte would too, since 32 divides 256 — but only by accident, and
    // the next person to widen the alphabet would inherit a silent bias.
    const chars = Array.from({ length: GROUP * GROUPS }, () =>
      ALPHABET[randomInt(ALPHABET.length)],
    ).join('');
    return `${chars.slice(0, GROUP)}-${chars.slice(GROUP)}`;
  }

  /** Uppercase, strip everything that is not in the alphabet. */
  private normalise(code: string): string {
    return code.toUpperCase().replace(/[^0-9A-Z]/g, '');
  }

  /** First group only: enough to identify a code, useless for using one. */
  private labelFor(code: string): string {
    return `${code.slice(0, GROUP)}-•••••`;
  }
}
