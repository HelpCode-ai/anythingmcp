import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../common/prisma.service';
import type {
  IOAuthStore,
  OAuthClient,
  AuthorizationCode,
  ClientRegistrationDto,
} from '@rekog/mcp-nest';
import type { OAuthSession, OAuthUserProfile } from '@rekog/mcp-nest';

@Injectable()
export class PrismaOAuthStore implements IOAuthStore {
  private readonly logger = new Logger(PrismaOAuthStore.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Client Management ─────────────────────────────────────────────────

  async storeClient(client: OAuthClient): Promise<OAuthClient> {
    const record = await this.prisma.oAuthClient.create({
      data: {
        clientId: client.client_id,
        clientSecret: client.client_secret,
        clientName: client.client_name,
        clientDescription: client.client_description,
        logoUri: client.logo_uri,
        clientUri: client.client_uri,
        developerName: client.developer_name,
        developerEmail: client.developer_email,
        redirectUris: client.redirect_uris,
        grantTypes: client.grant_types,
        responseTypes: client.response_types,
        tokenEndpointAuthMethod: client.token_endpoint_auth_method,
      },
    });
    return this.toOAuthClient(record);
  }

  async getClient(client_id: string): Promise<OAuthClient | undefined> {
    const record = await this.prisma.oAuthClient.findUnique({
      where: { clientId: client_id },
    });
    return record ? this.toOAuthClient(record) : undefined;
  }

  async findClient(client_name: string): Promise<OAuthClient | undefined> {
    const record = await this.prisma.oAuthClient.findFirst({
      where: { clientName: client_name },
    });
    return record ? this.toOAuthClient(record) : undefined;
  }

  generateClientId(client: OAuthClient): string {
    const input = `${client.client_name}:${Date.now()}:${Math.random()}`;
    return createHash('sha256').update(input).digest('hex').slice(0, 32);
  }

  // ── Authorization Code Management ─────────────────────────────────────

  async storeAuthCode(code: AuthorizationCode): Promise<void> {
    await this.prisma.oAuthAuthorizationCode.create({
      data: {
        code: code.code,
        userId: code.user_id,
        clientId: code.client_id,
        redirectUri: code.redirect_uri,
        codeChallenge: code.code_challenge,
        codeChallengeMethod: code.code_challenge_method,
        resource: code.resource,
        scope: code.scope,
        expiresAt: BigInt(code.expires_at),
        userProfileId: code.user_profile_id,
      },
    });
  }

  async getAuthCode(code: string): Promise<AuthorizationCode | undefined> {
    const record = await this.prisma.oAuthAuthorizationCode.findUnique({
      where: { code },
    });
    if (!record) return undefined;

    // Single-use: delete after retrieval
    await this.prisma.oAuthAuthorizationCode.delete({ where: { code } });

    return {
      code: record.code,
      user_id: record.userId,
      client_id: record.clientId,
      redirect_uri: record.redirectUri,
      code_challenge: record.codeChallenge,
      code_challenge_method: record.codeChallengeMethod,
      resource: record.resource ?? undefined,
      scope: record.scope ?? undefined,
      expires_at: Number(record.expiresAt),
      user_profile_id: record.userProfileId ?? undefined,
    };
  }

  async removeAuthCode(code: string): Promise<void> {
    await this.prisma.oAuthAuthorizationCode
      .delete({ where: { code } })
      .catch(() => {});
  }

  // ── OAuth Session Management ──────────────────────────────────────────

  async storeOAuthSession(
    sessionId: string,
    session: OAuthSession,
  ): Promise<void> {
    await this.prisma.oAuthSession.upsert({
      where: { sessionId },
      create: {
        sessionId,
        state: session.state,
        clientId: session.clientId,
        redirectUri: session.redirectUri,
        codeChallenge: session.codeChallenge,
        codeChallengeMethod: session.codeChallengeMethod,
        oauthState: session.oauthState,
        scope: session.scope,
        resource: session.resource,
        expiresAt: BigInt(session.expiresAt),
      },
      update: {
        state: session.state,
        clientId: session.clientId,
        redirectUri: session.redirectUri,
        codeChallenge: session.codeChallenge,
        codeChallengeMethod: session.codeChallengeMethod,
        oauthState: session.oauthState,
        scope: session.scope,
        resource: session.resource,
        expiresAt: BigInt(session.expiresAt),
      },
    });
  }

  async getOAuthSession(
    sessionId: string,
  ): Promise<OAuthSession | undefined> {
    const record = await this.prisma.oAuthSession.findUnique({
      where: { sessionId },
    });
    if (!record) return undefined;

    // Check expiration
    if (Number(record.expiresAt) < Date.now()) {
      await this.removeOAuthSession(sessionId);
      return undefined;
    }

    return {
      sessionId: record.sessionId,
      state: record.state,
      clientId: record.clientId ?? undefined,
      redirectUri: record.redirectUri ?? undefined,
      codeChallenge: record.codeChallenge ?? undefined,
      codeChallengeMethod: record.codeChallengeMethod ?? undefined,
      oauthState: record.oauthState ?? undefined,
      scope: record.scope ?? undefined,
      resource: record.resource ?? undefined,
      expiresAt: Number(record.expiresAt),
    };
  }

  async removeOAuthSession(sessionId: string): Promise<void> {
    await this.prisma.oAuthSession
      .delete({ where: { sessionId } })
      .catch(() => {});
  }

  // ── User Profile Management ───────────────────────────────────────────

  async upsertUserProfile(
    profile: OAuthUserProfile,
    provider: string,
  ): Promise<string> {
    const record = await this.prisma.oAuthUserProfile.upsert({
      where: {
        provider_externalId: {
          provider,
          externalId: profile.id,
        },
      },
      create: {
        profileId: `${provider}:${profile.id}`,
        provider,
        externalId: profile.id,
        username: profile.username,
        email: profile.email,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        raw: profile.raw ?? undefined,
      },
      update: {
        username: profile.username,
        email: profile.email,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        raw: profile.raw ?? undefined,
      },
    });

    return record.profileId;
  }

  async getUserProfileById(
    profileId: string,
  ): Promise<
    | (OAuthUserProfile & { profile_id: string; provider: string })
    | undefined
  > {
    const record = await this.prisma.oAuthUserProfile.findUnique({
      where: { profileId },
    });
    if (!record) return undefined;

    return {
      id: record.externalId,
      username: record.username,
      email: record.email ?? undefined,
      displayName: record.displayName ?? undefined,
      avatarUrl: record.avatarUrl ?? undefined,
      raw: record.raw ?? undefined,
      profile_id: record.profileId,
      provider: record.provider,
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private toOAuthClient(record: any): OAuthClient {
    return {
      client_id: record.clientId,
      client_secret: record.clientSecret ?? undefined,
      client_name: record.clientName,
      client_description: record.clientDescription ?? undefined,
      logo_uri: record.logoUri ?? undefined,
      client_uri: record.clientUri ?? undefined,
      developer_name: record.developerName ?? undefined,
      developer_email: record.developerEmail ?? undefined,
      redirect_uris: record.redirectUris,
      grant_types: record.grantTypes,
      response_types: record.responseTypes,
      token_endpoint_auth_method: record.tokenEndpointAuthMethod,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    };
  }
}
