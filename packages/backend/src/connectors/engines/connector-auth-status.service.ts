import { Injectable, Logger, Optional } from '@nestjs/common';
import { pbkdf2Sync } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { EmailService } from '../../settings/email.service';

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
 *   expiring      a warning: the token works, but stops at tokenExpiresAt
 *
 * Nothing here is ever a secret: `ref` is a truncated SHA-256.
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

/** The credential a status is recorded against: the refresh token, else the pasted token. */
export function authCredentialRef(authConfig: Record<string, unknown> | undefined): string | undefined {
  return credentialRef(authConfig?.refreshToken) ?? credentialRef(authConfig?.token);
}

@Injectable()
export class ConnectorAuthStatusService {
  private readonly logger = new Logger(ConnectorAuthStatusService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly email?: EmailService,
  ) {}

  /**
   * Record an issue. A repeat of the stored one (same status, code and
   * credential) writes nothing, so a burst of failing calls costs one read
   * each at most. The first time a connector needs a new sign-in, its
   * workspace owner is emailed.
   */
  async mark(connectorId: string, issue: AuthIssue): Promise<void> {
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
    const row = await this.prisma.connector
      .findUnique({
        where: { id: connectorId },
        select: {
          authStatus: true,
          authStatusCode: true,
          authStatusMessage: true,
          authStatusRef: true,
          authStatusAt: true,
        },
      })
      .catch(() => null);
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
}
