import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';
import { decrypt, encrypt } from '../common/crypto/encryption.util';
import { getRequiredSecret } from '../common/secrets.util';
import { connectorConnectUrl } from '../common/url.util';
import { userCredentialKey } from '../common/credential-key.util';
import { EditionService } from '../ee/licensing/edition.service';
import { OAuth2TokenService } from './engines/oauth2-token.service';
import { mergeUserCredential, pickUserTokens } from './user-credential.util';

/** The feature name in the 403 the dashboard shows without an Enterprise licence. */
export const USER_CREDENTIALS_FEATURE = 'Per-user sign-in for connectors';

/**
 * A call on a per-user connector that cannot carry the caller's own
 * credential. Its message is for the model and the user: what happened, that
 * nothing was sent, and what to do.
 */
export class UserCredentialError extends Error {
  constructor(
    message: string,
    readonly code: 'no_user' | 'not_licensed' | 'not_connected',
  ) {
    super(message);
  }
}

/** What the dashboard shows a user about their own sign-in to a connector. */
export interface UserCredentialStatus {
  connected: boolean;
  authorizedAt?: string;
  authStatus?: string | null;
  authStatusMessage?: string | null;
}

/**
 * Each user's own sign-in to connectors whose `credentialScope` is USER
 * (see user-credential.util). Enterprise only: without an Enterprise licence
 * no call carries a user's credential, and none falls back to the connector's
 * own either, so a lapsed licence stops the calls instead of widening them.
 */
@Injectable()
export class UserCredentialsService {
  private readonly logger = new Logger(UserCredentialsService.name);
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly edition: EditionService,
    private readonly oauth2Tokens: OAuth2TokenService,
    configService: ConfigService,
  ) {
    this.encryptionKey = getRequiredSecret('ENCRYPTION_KEY', configService.get<string>('ENCRYPTION_KEY'));
  }

  /**
   * The auth config and engine key a call by `userId` carries: the
   * connector's client with that user's tokens. Throws UserCredentialError
   * when there is no caller, no licence or no sign-in, before anything is sent.
   */
  async resolveForCall(input: {
    connectorId: string;
    connectorName: string;
    organizationId: string;
    userId?: string;
    connectorAuthConfig?: Record<string, unknown>;
  }): Promise<{ authConfig: Record<string, unknown>; credentialKey: string }> {
    const page = connectorConnectUrl(input.connectorId);
    const name = `"${input.connectorName.slice(0, 80)}"`;
    if (!input.userId) {
      throw new UserCredentialError(
        `The connector ${name} signs every user in with their own account, and this call does not ` +
          'come from a signed-in user (an API key or a job without one). No request was sent to the API. ' +
          'Call it from a client signed in as a user of this workspace.',
        'no_user',
      );
    }
    if (!(await this.edition.hasEnterprise(input.organizationId))) {
      throw new UserCredentialError(
        `The connector ${name} signs every user in with their own account, which is available with ` +
          'AnythingMCP Enterprise. No request was sent to the API. A workspace administrator can renew ' +
          'the Enterprise licence, or switch the connector back to a shared sign-in.',
        'not_licensed',
      );
    }
    const tokens = await this.getTokens(input.connectorId, input.organizationId, input.userId);
    if (!tokens) {
      throw new UserCredentialError(
        `You have not connected your own account to the connector ${name} yet. No request was sent to ` +
          `the API. ${page ? `Open ${page}` : 'Open the connector in AnythingMCP'} and click ` +
          '"Connect my account"; the provider then answers with what your own account may see.',
        'not_connected',
      );
    }
    return {
      authConfig: mergeUserCredential(input.connectorAuthConfig, tokens),
      credentialKey: userCredentialKey(input.connectorId, input.userId),
    };
  }

  /** The user's decrypted tokens for a connector, or null when not signed in. */
  async getTokens(
    connectorId: string,
    organizationId: string,
    userId: string,
  ): Promise<Record<string, unknown> | null> {
    const row = await this.prisma.userConnectorCredential.findFirst({
      where: { connectorId, userId, organizationId },
      select: { authConfig: true },
    });
    if (!row) return null;
    try {
      return JSON.parse(decrypt(row.authConfig, this.encryptionKey));
    } catch (err: any) {
      this.logger.warn(`Unreadable user credential for connector ${connectorId}: ${err?.message ?? err}`);
      return null;
    }
  }

  /**
   * Store what a user's authorization returned. A new sign-in replaces the
   * old one and clears its status, and the engines forget the token they
   * had cached for that user.
   */
  async store(
    connector: { id: string; organizationId: string },
    userId: string,
    tokens: Record<string, unknown>,
  ): Promise<void> {
    const authConfig = encrypt(JSON.stringify(pickUserTokens(tokens)), this.encryptionKey);
    const clearedStatus = {
      authStatus: null,
      authStatusCode: null,
      authStatusMessage: null,
      authStatusAt: null,
      authStatusRef: null,
      authNotifiedAt: null,
    };
    await this.prisma.userConnectorCredential.upsert({
      where: { connectorId_userId: { connectorId: connector.id, userId } },
      create: {
        connectorId: connector.id,
        userId,
        organizationId: connector.organizationId,
        authConfig,
      },
      update: { authConfig, ...clearedStatus },
    });
    this.oauth2Tokens.forget(userCredentialKey(connector.id, userId));
  }

  /** The user's own sign-in, as the dashboard shows it. No token ever leaves. */
  async status(connectorId: string, organizationId: string, userId: string): Promise<UserCredentialStatus> {
    const row = await this.prisma.userConnectorCredential.findFirst({
      where: { connectorId, userId, organizationId },
      select: { authConfig: true, authStatus: true, authStatusMessage: true },
    });
    if (!row) return { connected: false };
    let authorizedAt: string | undefined;
    try {
      const tokens = JSON.parse(decrypt(row.authConfig, this.encryptionKey));
      if (typeof tokens.authorizedAt === 'string') authorizedAt = tokens.authorizedAt;
    } catch {
      // Shown as connected without a date.
    }
    return {
      connected: true,
      ...(authorizedAt ? { authorizedAt } : {}),
      authStatus: row.authStatus,
      authStatusMessage: row.authStatusMessage,
    };
  }

  /** Sign one user out of a connector. True when there was a sign-in to remove. */
  async remove(connectorId: string, organizationId: string, userId: string): Promise<boolean> {
    const res = await this.prisma.userConnectorCredential.deleteMany({
      where: { connectorId, userId, organizationId },
    });
    this.oauth2Tokens.forget(userCredentialKey(connectorId, userId));
    return res.count > 0;
  }

  /**
   * Sign every user out of a connector: when it goes back to a shared
   * credential, the users' tokens have no use left and are not kept.
   */
  async removeAll(connectorId: string, organizationId: string): Promise<number> {
    const rows = await this.prisma.userConnectorCredential.findMany({
      where: { connectorId, organizationId },
      select: { userId: true },
    });
    await this.prisma.userConnectorCredential.deleteMany({ where: { connectorId, organizationId } });
    for (const { userId } of rows) this.oauth2Tokens.forget(userCredentialKey(connectorId, userId));
    return rows.length;
  }
}
