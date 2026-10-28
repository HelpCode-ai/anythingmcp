import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { pbkdf2Sync } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { connectorPageUrl } from '../../common/url.util';
import { EmailService } from '../../settings/email.service';
import { parseCredentialKey } from '../../common/credential-key.util';

/**
 * Credential health of a connector, kept on the connector row
 * (`auth_status*`, `token_expires_at`).
 *
 * WHY. A provider that refuses a credential for good keeps refusing it: on
 * 17 Oct 2026 Google revoked a workspace's refresh token (its OAuth app was
 * in "Testing", which caps refresh tokens at 7 days), and the workspace's
 * scheduled job then asked Google for a new token 18 times an hour, every
 * hour, each time getting the same invalid_grant, while nobody was told.
 * Recording the refusal lets calls fail fast with the fix, the dashboard show
 * it next to the connector, and the owner get one email.
 *
 * Statuses:
 *   needs_reauth  blocking: calls fail at once with `message` until the
 *                 credential changes (`ref` is a hash of the one refused)
 *   expiring      a warning: the token works, but stops at tokenExpiresAt;
 *                 once that time has passed it becomes needs_reauth
 *                 (token_expired), on the next call or the hourly sweep
 *
 * Nothing here is ever a secret: `ref` is a truncated SHA-256.
 *
 * The key of a user's own credential (credential-key.util) keeps its status on
 * that user's `UserConnectorCredential` row instead, and the email goes to
 * that user: one user's revoked sign-in neither blocks nor concerns the others.
 */
export type AuthStatus = 'needs_reauth' | 'expiring';

export interface AuthIssue {
  status: AuthStatus;
  /** e.g. refresh_refused, google_testing_7d, meta_logged_out */
  code: string;
  /** What to do, for the user and the model. */
  message: string;
  /** credentialRef() of the credential this applies to. */
  ref?: string;
}

/** Memo of credentialRef: it runs on every call of a renewable bearer connector. */
const refMemo = new Map<string, string>();
const REF_MEMO_MAX = 5_000;

/**
 * A short, non-reversible handle on a credential, to tell one from another
 * (PBKDF2, so the stored handle is no shortcut to guessing the credential).
 */
export function credentialRef(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const known = refMemo.get(value);
  if (known) return known;
  const ref = pbkdf2Sync(value, 'amcp:credential-ref', 1_000, 8, 'sha256').toString('hex');
  if (refMemo.size >= REF_MEMO_MAX) refMemo.clear();
  refMemo.set(value, ref);
  return ref;
}

/** How often connectors whose token expired while still marked `expiring` are looked for. */
const EXPIRY_SWEEP_MS = 60 * 60 * 1000;
/** First sweep after boot: late enough to stay out of the startup work. */
const EXPIRY_SWEEP_FIRST_MS = 2 * 60 * 1000;
/** Connectors handled per sweep; the rest wait for the next one. */
const EXPIRY_SWEEP_BATCH = 200;

/** The status message of a token past its expiry that nothing could renew. */
export function expiredTokenHint(expiresAt: Date, connectorId: string): string {
  const when = expiresAt.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const page = connectorPageUrl(connectorId);
  return (
    `The access token expired on ${when} and could not be renewed; retrying will not help. ` +
    `Paste a new token into the connector's variables in AnythingMCP${page ? ` (${page})` : ''}. ` +
    'For Meta, a System User token with expiry Never does not expire, and a user token is renewed ' +
    'automatically when the app id and secret are set.'
  );
}

/** The credential a status is recorded against: the refresh token, else the pasted token. */
export function authCredentialRef(authConfig: Record<string, unknown> | undefined): string | undefined {
  return credentialRef(authConfig?.refreshToken) ?? credentialRef(authConfig?.token);
}

@Injectable()
export class ConnectorAuthStatusService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConnectorAuthStatusService.name);
  private sweepTimer?: ReturnType<typeof setInterval>;
  private firstSweep?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly email?: EmailService,
  ) {}

  onModuleInit(): void {
    const sweep = () => void this.expireLapsedTokens();
    this.firstSweep = setTimeout(sweep, EXPIRY_SWEEP_FIRST_MS);
    this.firstSweep.unref?.();
    this.sweepTimer = setInterval(sweep, EXPIRY_SWEEP_MS);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.firstSweep) clearTimeout(this.firstSweep);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /**
   * An `expiring` warning whose token has expired is no longer a warning.
   * The next call notices it too (Meta refuses the token, or the renewal
   * service sees the expiry), but a connector nobody calls stayed `expiring`
   * for good and its owner was never told: a meta-ads token that expired on
   * 20 Oct 2026 at 17:00 was still a warning, with no email, a day later.
   * Each one becomes needs_reauth against the same credential, which sends
   * the single owner email like any other refusal. Returns how many moved.
   */
  async expireLapsedTokens(now: Date = new Date()): Promise<number> {
    let rows: Array<{ id: string; authStatusRef: string | null; tokenExpiresAt: Date | null }>;
    try {
      rows = await this.prisma.connector.findMany({
        where: { authStatus: 'expiring', tokenExpiresAt: { lte: now } },
        select: { id: true, authStatusRef: true, tokenExpiresAt: true },
        orderBy: { tokenExpiresAt: 'asc' },
        take: EXPIRY_SWEEP_BATCH,
      });
    } catch (err: any) {
      this.logger.warn(`Could not look for expired connector tokens: ${err?.message ?? err}`);
      return 0;
    }
    for (const row of rows) {
      if (!row.tokenExpiresAt) continue;
      await this.mark(row.id, {
        status: 'needs_reauth',
        code: 'token_expired',
        message: expiredTokenHint(row.tokenExpiresAt, row.id),
        ref: row.authStatusRef ?? undefined,
      });
    }
    return rows.length;
  }

  /**
   * Record an issue. A repeat of the stored one (same status, code and
   * credential) writes nothing, so a burst of failing calls costs one read
   * each at most. The first time a connector needs a new sign-in, its
   * workspace owner is emailed.
   */
  async mark(connectorId: string, issue: AuthIssue): Promise<void> {
    if (parseCredentialKey(connectorId).userId) return this.markUser(connectorId, issue);
    try {
      const current = await this.prisma.connector.findUnique({
        where: { id: connectorId },
        select: { authStatus: true, authStatusCode: true, authStatusRef: true, authStatusMessage: true },
      });
      if (!current) return;
      const same =
        current.authStatus === issue.status &&
        current.authStatusCode === issue.code &&
        (current.authStatusRef ?? null) === (issue.ref ?? null) &&
        current.authStatusMessage === issue.message;
      if (!same) {
        // A new incident (not a repeat): the owner hears about it again.
        const newIncident =
          current.authStatus !== issue.status || (current.authStatusRef ?? null) !== (issue.ref ?? null);
        await this.prisma.connector.update({
          where: { id: connectorId },
          data: {
            authStatus: issue.status,
            authStatusCode: issue.code,
            authStatusMessage: issue.message,
            authStatusRef: issue.ref ?? null,
            ...(newIncident ? { authStatusAt: new Date(), authNotifiedAt: null } : {}),
          },
        });
        this.logger.log(
          `Connector ${connectorId}: credential status ${issue.status} (${issue.code})`,
        );
      }
      // Not awaited: the caller may hold the refresh lock, and SMTP can be slow.
      if (issue.status === 'needs_reauth') {
        void this.notifyOnce(connectorId).catch((err) =>
          this.logger.warn(`Could not email about connector ${connectorId}: ${err?.message ?? err}`),
        );
      }
    } catch (err: any) {
      this.logger.warn(`Could not record the credential status of connector ${connectorId}: ${err?.message ?? err}`);
    }
  }

  /**
   * The credential works again (renewed, re-authorized, replaced). Writes only
   * when something is recorded, so calling it after every renewal is cheap.
   * `onlyCodes` limits it to some reasons (a renewed token clears a renewal
   * warning, but not a logged-out session that a new paste must fix).
   * `exceptRef` keeps a status recorded against that very credential (a
   * token used again after a restart must not lose, and re-send, its email).
   */
  async clear(
    connectorId: string,
    opts: { onlyCodes?: string[]; exceptRef?: string } = {},
  ): Promise<void> {
    const { userId } = parseCredentialKey(connectorId);
    if (userId) return this.clearUser(connectorId, opts);
    try {
      const res = await this.prisma.connector.updateMany({
        where: {
          id: connectorId,
          authStatus: { not: null },
          ...(opts.onlyCodes ? { authStatusCode: { in: opts.onlyCodes } } : {}),
          ...(opts.exceptRef
            ? { OR: [{ authStatusRef: null }, { authStatusRef: { not: opts.exceptRef } }] }
            : {}),
        },
        data: {
          authStatus: null,
          authStatusCode: null,
          authStatusMessage: null,
          authStatusAt: null,
          authStatusRef: null,
          authNotifiedAt: null,
        },
      });
      if (res.count > 0) this.logger.log(`Connector ${connectorId}: credential status cleared`);
    } catch (err: any) {
      this.logger.warn(`Could not clear the credential status of connector ${connectorId}: ${err?.message ?? err}`);
    }
  }

  /** The stored status, or null when the credential is fine. */
  async get(connectorId: string): Promise<(AuthIssue & { at: Date | null }) | null> {
    const { connectorId: id, userId } = parseCredentialKey(connectorId);
    const select = {
      authStatus: true,
      authStatusCode: true,
      authStatusMessage: true,
      authStatusRef: true,
      authStatusAt: true,
    } as const;
    const row = userId
      ? await this.prisma.userConnectorCredential
          .findFirst({ where: { connectorId: id, userId }, select })
          .catch(() => null)
      : await this.prisma.connector.findUnique({ where: { id }, select }).catch(() => null);
    if (!row?.authStatus) return null;
    return {
      status: row.authStatus as AuthStatus,
      code: row.authStatusCode ?? '',
      message: row.authStatusMessage ?? '',
      ref: row.authStatusRef ?? undefined,
      at: row.authStatusAt,
    };
  }

  /** When the connector's pasted token expires (null: never, or unknown). */
  async setTokenExpiry(connectorId: string, expiresAt: Date | null): Promise<void> {
    // Pasted tokens only; a user's own credential is always an OAuth2 sign-in.
    if (parseCredentialKey(connectorId).userId) return;
    try {
      await this.prisma.connector.updateMany({
        where: { id: connectorId },
        data: { tokenExpiresAt: expiresAt },
      });
    } catch (err: any) {
      this.logger.warn(`Could not store the token expiry of connector ${connectorId}: ${err?.message ?? err}`);
    }
  }

  /**
   * Email the workspace owner (its first active admin) once per incident.
   * The claim is a conditional write, so two processes never both send.
   */
  private async notifyOnce(connectorId: string): Promise<void> {
    if (!this.email) return;
    const claimed = await this.prisma.connector.updateMany({
      where: { id: connectorId, authStatus: 'needs_reauth', authNotifiedAt: null },
      data: { authNotifiedAt: new Date() },
    });
    if (claimed.count !== 1) return;

    const connector = await this.prisma.connector.findUnique({
      where: { id: connectorId },
      select: { name: true, organizationId: true, authStatusMessage: true },
    });
    if (!connector) return;
    const owner = await this.prisma.organizationMember.findFirst({
      where: { organizationId: connector.organizationId, role: 'ADMIN', deactivatedAt: null },
      orderBy: { joinedAt: 'asc' },
      select: { user: { select: { email: true, name: true } } },
    });
    if (!owner?.user?.email) return;
    await this.email.sendConnectorAuthEmail(
      owner.user.email,
      {
        name: owner.user.name,
        connectorName: connector.name,
        message: connector.authStatusMessage ?? '',
        connectorPath: `/connectors/${encodeURIComponent(connectorId)}`,
      },
      connector.organizationId,
    );
  }
  /** mark() for one user's own credential: recorded on that user's row. */
  private async markUser(key: string, issue: AuthIssue): Promise<void> {
    const { connectorId, userId } = parseCredentialKey(key);
    const where = { connectorId, userId: userId! };
    try {
      const current = await this.prisma.userConnectorCredential.findFirst({
        where,
        select: { authStatus: true, authStatusCode: true, authStatusRef: true, authStatusMessage: true },
      });
      if (!current) return;
      const same =
        current.authStatus === issue.status &&
        current.authStatusCode === issue.code &&
        (current.authStatusRef ?? null) === (issue.ref ?? null) &&
        current.authStatusMessage === issue.message;
      if (!same) {
        const newIncident =
          current.authStatus !== issue.status || (current.authStatusRef ?? null) !== (issue.ref ?? null);
        await this.prisma.userConnectorCredential.updateMany({
          where,
          data: {
            authStatus: issue.status,
            authStatusCode: issue.code,
            authStatusMessage: issue.message,
            authStatusRef: issue.ref ?? null,
            ...(newIncident ? { authStatusAt: new Date(), authNotifiedAt: null } : {}),
          },
        });
        this.logger.log(
          `Connector ${connectorId}, user ${userId}: credential status ${issue.status} (${issue.code})`,
        );
      }
      if (issue.status === 'needs_reauth') {
        void this.notifyUserOnce(connectorId, userId!).catch((err) =>
          this.logger.warn(`Could not email about connector ${connectorId}: ${err?.message ?? err}`),
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `Could not record the user credential status of connector ${connectorId}: ${err?.message ?? err}`,
      );
    }
  }

  /** clear() for one user's own credential. */
  private async clearUser(
    key: string,
    opts: { onlyCodes?: string[]; exceptRef?: string },
  ): Promise<void> {
    const { connectorId, userId } = parseCredentialKey(key);
    try {
      const res = await this.prisma.userConnectorCredential.updateMany({
        where: {
          connectorId,
          userId: userId!,
          authStatus: { not: null },
          ...(opts.onlyCodes ? { authStatusCode: { in: opts.onlyCodes } } : {}),
          ...(opts.exceptRef
            ? { OR: [{ authStatusRef: null }, { authStatusRef: { not: opts.exceptRef } }] }
            : {}),
        },
        data: {
          authStatus: null,
          authStatusCode: null,
          authStatusMessage: null,
          authStatusAt: null,
          authStatusRef: null,
          authNotifiedAt: null,
        },
      });
      if (res.count > 0) {
        this.logger.log(`Connector ${connectorId}, user ${userId}: credential status cleared`);
      }
    } catch (err: any) {
      this.logger.warn(
        `Could not clear the user credential status of connector ${connectorId}: ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Email the user whose own sign-in needs renewing, once per incident. The
   * workspace owner cannot sign in for them, so the owner is not told.
   */
  private async notifyUserOnce(connectorId: string, userId: string): Promise<void> {
    if (!this.email) return;
    const claimed = await this.prisma.userConnectorCredential.updateMany({
      where: { connectorId, userId, authStatus: 'needs_reauth', authNotifiedAt: null },
      data: { authNotifiedAt: new Date() },
    });
    if (claimed.count !== 1) return;

    const credential = await this.prisma.userConnectorCredential.findFirst({
      where: { connectorId, userId },
      select: {
        authStatusMessage: true,
        organizationId: true,
        connector: { select: { name: true } },
        user: { select: { email: true, name: true } },
      },
    });
    if (!credential?.user?.email) return;
    await this.email.sendConnectorAuthEmail(
      credential.user.email,
      {
        name: credential.user.name,
        connectorName: credential.connector.name,
        message: credential.authStatusMessage ?? '',
        // The page where that user signs in again, reachable also when the
        // dashboard is not (see connectorConnectUrl).
        connectorPath: `/auth/connect/${encodeURIComponent(connectorId)}`,
      },
      credential.organizationId,
    );
  }
}
