import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  GoneException,
  HttpCode,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiBearerAuth, ApiBody, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { ConnectorsService } from './connectors.service';
import { McpOAuthService } from './mcp-oauth.service';
import { McpServerService } from '../mcp-server/mcp-server.service';
import { getAdapter } from '../adapters/catalog';
import { decrypt } from '../common/crypto/encryption.util';
import { getRequiredSecret } from '../common/secrets.util';
import { rebuildCatalogCredentials } from './catalog-env-rebuild.util';
import { BearerTokenRenewalService } from './engines/bearer-token-renewal.service';
import { MetaInstagramAccount, MetaLoginError, MetaLoginService } from './engines/meta-login.service';
import {
  META_LOGIN_ACCOUNT_VAR,
  META_LOGIN_TOKEN_VAR,
  MetaLoginFlavour,
  buildMetaLoginUrl,
  metaLoginAppOf,
  metaLoginFlavourOf,
  metaLoginOwnAppVars,
  metaLoginPlatformApp,
  metaLoginProviderName,
} from './engines/meta-login.util';

const EXPIRED = 'This authorization expired or was already used. Start it again from the connector.';

interface ConnectorRow {
  id: string;
  organizationId: string;
  userId: string;
  authType: string;
  authConfig: string | null;
  baseUrl: string;
  headers?: unknown;
  envVars?: unknown;
  config?: unknown;
}

/**
 * "Authorize with Facebook" / "Authorize with Instagram" for the Instagram
 * connectors (catalog adapters `instagram` and `instagram-login`).
 *
 * Both are BEARER_TOKEN connectors that take a pasted token; this flow gets
 * the token by signing in instead, writes it where a pasted one goes
 * (INSTAGRAM_ACCESS_TOKEN, plus the account id in INSTAGRAM_ACCOUNT_ID) and
 * hands its expiry to the bearer token renewal, which keeps it fresh. Meta's
 * logins are OAuth 2 but issue no refresh token and need extra exchanges, so
 * the flow has its own three steps, like Shopee and TikTok Shop:
 *
 *   1. POST /api/meta/connectors/:id/authorize (signed in, owner or admin):
 *      stores a pending attempt (the encrypted, single-use store the OAuth
 *      flows use) and returns the login dialog's address.
 *   2. GET /api/meta/callback: Meta's redirect. Checks that the state is one
 *      we issued and forwards the code to the dashboard.
 *   3. POST /api/meta/complete (signed in): exchanges the code for a
 *      long-lived token, only for the user who started the attempt, finds
 *      the Instagram account and stores both.
 *
 * With several Instagram accounts behind one Facebook login, step 3 stores
 * the token and returns the accounts; POST /api/meta/connectors/:id/account
 * stores the one the user picks.
 *
 * The app: the connector's own (META_APP_ID / META_APP_SECRET, or
 * INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET), else the server's
 * (META_PLATFORM_APP_* / INSTAGRAM_PLATFORM_APP_*) when it has one. The same
 * on Cloud and self-hosted; the redirect URI to register on the app is
 * <SERVER_URL>/api/meta/callback for both flavours.
 */
@ApiTags('Meta')
@Controller('api/meta')
export class MetaAuthController {
  private readonly logger = new Logger(MetaAuthController.name);
  private readonly encryptionKey: string;

  constructor(
    private readonly connectorsService: ConnectorsService,
    private readonly oauthFlows: McpOAuthService,
    private readonly metaLogin: MetaLoginService,
    private readonly bearerTokens: BearerTokenRenewalService,
    private readonly mcpServer: McpServerService,
    private readonly configService: ConfigService,
  ) {
    this.encryptionKey = getRequiredSecret('ENCRYPTION_KEY', this.configService.get<string>('ENCRYPTION_KEY'));
  }

  private serverUrl(): string {
    return (this.configService.get<string>('SERVER_URL') || 'http://localhost:4000').replace(/\/+$/, '');
  }

  /** The redirect URI to register on the Meta app, for both logins. */
  private redirectUrl(): string {
    return `${this.serverUrl()}/api/meta/callback`;
  }

  private completePage(params: Record<string, string>): string {
    const base = (this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000').replace(/\/+$/, '');
    return `${base}/connectors/oauth/complete?${new URLSearchParams(params).toString()}`;
  }

  private assertCanModify(connector: ConnectorRow, req: any): void {
    if (connector.organizationId !== req.user?.organizationId) throw new ForbiddenException('Resource not found');
    if (req.user.role === 'VIEWER') throw new ForbiddenException('Viewers cannot modify connectors');
    if (connector.userId !== req.user.sub && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('Only the connector owner or an admin can modify this connector');
    }
  }

  private envOf(connector: ConnectorRow): Record<string, string> {
    return (connector.envVars as Record<string, string> | null) ?? {};
  }

  @Get('platform')
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({
    summary: 'Whether this server has its own Meta apps, and the redirect URI to set on an app of your own',
    description:
      '`facebook`: a server app for Instagram API with Facebook Login (connector `instagram`); `instagram`: one ' +
      'for Instagram API with Instagram Login (`instagram-login`). With one, the setup page does not ask for an ' +
      'app id and secret.',
  })
  platform(): { facebook: boolean; instagram: boolean; redirectUrl: string } {
    return {
      facebook: !!metaLoginPlatformApp('facebook'),
      instagram: !!metaLoginPlatformApp('instagram'),
      redirectUrl: this.redirectUrl(),
    };
  }

  @Post('connectors/:id/authorize')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Start the Facebook or Instagram sign-in of an Instagram connector',
    description:
      'Returns the Meta login dialog where the user signs in and approves the app, and `redirectUrl`, the ' +
      'redirect URI an app of your own must list. Without an app (the connector\'s META_APP_ID and ' +
      'META_APP_SECRET, or INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET, or the server\'s), or for a connector ' +
      'that is not an Instagram one, the answer is `{ "error": "…" }`. Dashboard session only; the connector ' +
      'owner or an admin, never a VIEWER.',
  })
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      properties: {
        returnTo: {
          type: 'string',
          maxLength: 500,
          description: 'Dashboard path to come back to when the authorization is done; only a path on this site is kept.',
        },
      },
    },
    examples: { default: { summary: 'Come back to the connector page', value: {} } },
  })
  async authorize(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body?: { returnTo?: string },
  ): Promise<{ authorizationUrl?: string; redirectUrl?: string; error?: string }> {
    const connector = (await this.connectorsService.findById(id)) as ConnectorRow;
    this.assertCanModify(connector, req);
    const flavour = metaLoginFlavourOf(connector);
    if (!flavour || connector.authType !== 'BEARER_TOKEN') {
      return { error: 'This connector does not sign in with Facebook or Instagram.' };
    }
    const { app, missing } = metaLoginAppOf(flavour, this.envOf(connector));
    if (!app) {
      return {
        error:
          `Set ${missing.join(' and ')} in this connector's environment variables first ` +
          `(${appWhere(flavour)}), and add ${this.redirectUrl()} to the app's valid OAuth redirect URIs.`,
        redirectUrl: this.redirectUrl(),
      };
    }
    const state = this.oauthFlows.generateState();
    await this.oauthFlows.storePendingFlow(
      state,
      {
        provider: 'meta',
        connectorId: connector.id,
        userId: req.user.sub,
        redirectUri: this.redirectUrl(),
        clientId: app.appId,
        tokenUrl:
          flavour === 'instagram'
            ? 'https://api.instagram.com/oauth/access_token'
            : 'https://graph.facebook.com/oauth/access_token',
        createdAt: Date.now(),
      },
      { returnTo: body?.returnTo },
    );
    return {
      authorizationUrl: buildMetaLoginUrl(flavour, app.appId, this.redirectUrl(), state),
      redirectUrl: this.redirectUrl(),
    };
  }

  @Get('callback')
  // Unauthenticated: keep it tight.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: "Meta's redirect after a Facebook or Instagram sign-in; forwards to the dashboard" })
  async callback(
    @Query('state') rawState: unknown,
    @Query('code') rawCode: unknown,
    @Query('error') rawError: unknown,
    @Res() res: Response,
    @Query('error_reason') rawReason?: unknown,
  ) {
    const state = typeof rawState === 'string' ? rawState : '';
    const code = typeof rawCode === 'string' && rawCode.trim() ? rawCode.trim() : undefined;
    const record = state ? await this.oauthFlows.getPendingFlow(state) : undefined;
    if (!record || record.flow.provider !== 'meta') {
      return res.redirect(this.completePage({ error: EXPIRED }));
    }
    const connectorId = record.flow.connectorId;
    if (!code) {
      await this.oauthFlows.deletePendingFlow(state);
      const denied = rawError === 'access_denied' || rawReason === 'user_denied';
      return res.redirect(
        this.completePage({
          error: denied
            ? 'The sign-in was cancelled or the permissions were declined. Start it again from the connector and approve the app.'
            : 'Meta came back without an authorization code. Start the authorization again from the connector.',
          connectorId,
        }),
      );
    }
    return res.redirect(this.completePage({ provider: 'meta', state, code }));
  }

  // Called by the dashboard's completion page; not an API to drive by hand.
  @Post('complete')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(200)
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Complete a Facebook or Instagram sign-in (dashboard, signed in)' })
  async complete(
    @Req() req: any,
    @Body() body: { state?: string; code?: string },
  ): Promise<{
    connectorId: string;
    toolsImported: number;
    returnTo?: string;
    account?: MetaInstagramAccount;
    accounts?: MetaInstagramAccount[];
  }> {
    const state = String(body?.state || '');
    // Check who started the flow before consuming it: another signed-in user
    // holding the state must not be able to burn the owner's authorization.
    const pending = await this.oauthFlows.getPendingFlow(state);
    if (!pending || pending.flow.provider !== 'meta') throw new GoneException(EXPIRED);
    if (pending.flow.userId !== req.user?.sub) {
      this.logger.warn(`Refused Meta completion: connector ${pending.flow.connectorId} was authorized by another user`);
      throw new ForbiddenException(
        'This authorization was started by another account. Sign in as that account, or start it again yourself.',
      );
    }
    // Single use: a second request racing this one finds nothing to take.
    const record = await this.oauthFlows.takePendingFlow(state);
    if (!record || record.flow.provider !== 'meta' || record.flow.userId !== req.user?.sub) {
      throw new GoneException(EXPIRED);
    }
    const { flow, returnTo } = record;
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!code) throw new GoneException('Meta came back without a code. Start the authorization again.');

    const connector = (await this.connectorsService.findByIdInternal(flow.connectorId)) as ConnectorRow;
    const flavour = metaLoginFlavourOf(connector);
    if (!flavour) {
      throw new BadRequestException({ message: 'This connector does not sign in with Facebook or Instagram.', connectorId: flow.connectorId });
    }
    const { app, usesPlatformApp, missing } = metaLoginAppOf(flavour, this.envOf(connector));
    if (!app) {
      throw new BadRequestException({
        message: `The connector has no Meta app any more (${missing.join(', ')}). Set it and authorize again.`,
        connectorId: flow.connectorId,
      });
    }

    let result;
    try {
      result = await this.metaLogin.exchangeCode({ flavour, app, code, redirectUri: flow.redirectUri });
    } catch (err) {
      throw this.exchangeException(err, flavour, flow.connectorId, usesPlatformApp);
    }
    if (result.accounts.length === 0) {
      throw new BadRequestException({
        message:
          flavour === 'facebook'
            ? 'The sign-in worked, but none of the Facebook Pages you manage has an Instagram business or creator ' +
              'account linked to it. Link the Instagram account to a Page (Instagram app: Settings, Account type ' +
              'and tools; or the Page settings, Linked accounts), then authorize again and select that Page.'
            : 'The sign-in worked, but Instagram did not return the account. Check that it is a business or ' +
              'creator account, then authorize again.',
        connectorId: flow.connectorId,
      });
    }

    // Keep an account already set when the login still reaches it; take the
    // only one otherwise; with several and none set, the user picks.
    const env = this.envOf(connector);
    const current = (env[META_LOGIN_ACCOUNT_VAR] ?? '').trim();
    const account =
      result.accounts.find((a) => a.id === current) ?? (result.accounts.length === 1 ? result.accounts[0] : undefined);

    await this.storeVariables(connector, {
      [META_LOGIN_TOKEN_VAR]: result.token,
      ...(account ? { [META_LOGIN_ACCOUNT_VAR]: account.id } : {}),
    });
    await this.bearerTokens.seed(flow.connectorId, result.token, {
      expiresAt: result.expiresAt,
      viaPlatformApp: usesPlatformApp && flavour === 'facebook',
    });
    await this.reload(flow.connectorId);
    this.logger.log(
      `Connector ${flow.connectorId}: ${metaLoginProviderName(flavour)} sign-in stored` +
        (account ? '' : `, ${result.accounts.length} accounts to choose from`),
    );
    return {
      connectorId: flow.connectorId,
      toolsImported: 0,
      ...(returnTo ? { returnTo } : {}),
      ...(account ? { account } : { accounts: result.accounts }),
    };
  }

  @Post('connectors/:id/account')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Choose the Instagram account of a connector signed in with Facebook',
    description:
      'After a Facebook sign-in that reaches several Instagram accounts: stores the one to use in ' +
      'INSTAGRAM_ACCOUNT_ID. Only an account the stored token reaches is accepted. The connector owner or an ' +
      'admin, never a VIEWER.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['accountId'],
      properties: { accountId: { type: 'string', pattern: '^[0-9]{5,25}$', description: 'Instagram professional account id' } },
    },
  })
  async chooseAccount(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: { accountId?: string },
  ): Promise<{ connectorId: string; account: MetaInstagramAccount }> {
    const connector = (await this.connectorsService.findById(id)) as ConnectorRow;
    this.assertCanModify(connector, req);
    if (metaLoginFlavourOf(connector) !== 'facebook') {
      throw new BadRequestException('Only an Instagram connector signed in with Facebook has accounts to choose from.');
    }
    const accountId = typeof body?.accountId === 'string' ? body.accountId.trim() : '';
    if (!/^\d{5,25}$/.test(accountId)) throw new BadRequestException('accountId must be an Instagram account id (digits).');
    const token = (this.envOf(connector)[META_LOGIN_TOKEN_VAR] ?? '').trim();
    if (!token || /\{\{/.test(token)) {
      throw new BadRequestException('The connector has no token yet. Authorize with Facebook first.');
    }
    let accounts: MetaInstagramAccount[];
    try {
      accounts = await this.metaLogin.facebookAccounts(token);
    } catch (err) {
      const e = err instanceof MetaLoginError ? err : new MetaLoginError('network error');
      throw new BadGatewayException(`Facebook did not list the accounts (${e.message}). Authorize again.`);
    }
    const account = accounts.find((a) => a.id === accountId);
    if (!account) {
      throw new BadRequestException(
        'The signed-in Facebook user cannot reach this Instagram account. Pick one from the list, or authorize again with another user.',
      );
    }
    await this.storeVariables(connector, { [META_LOGIN_ACCOUNT_VAR]: account.id });
    await this.reload(id);
    return { connectorId: id, account };
  }

  /**
   * Store variables the way the variable editor does for a catalog
   * connector: the values, and every credential field built from them (the
   * bearer token in authConfig is resolved at install and kept resolved).
   */
  private async storeVariables(connector: ConnectorRow, vars: Record<string, string>): Promise<void> {
    const fresh = (await this.connectorsService.findByIdInternal(connector.id)) as ConnectorRow;
    const previousEnvVars = this.envOf(fresh);
    const nextEnvVars = { ...previousEnvVars, ...vars };
    const slug = (fresh.config as { adapterSlug?: unknown } | null)?.adapterSlug;
    const adapter = typeof slug === 'string' ? getAdapter(slug) : undefined;
    const update: Parameters<ConnectorsService['update']>[1] = { envVars: nextEnvVars };
    if (adapter) {
      const rebuilt = rebuildCatalogCredentials({
        adapter,
        connectorAuthType: fresh.authType,
        storedAuthConfig: this.readAuthConfig(fresh.authConfig),
        storedBaseUrl: fresh.baseUrl,
        storedHeaders: (fresh.headers as Record<string, string> | null) ?? null,
        previousEnvVars,
        nextEnvVars,
      });
      if (rebuilt.authConfig) update.authConfig = rebuilt.authConfig;
      if (rebuilt.baseUrl !== undefined) update.baseUrl = rebuilt.baseUrl;
      if (rebuilt.headers) update.headers = rebuilt.headers;
    }
    await this.connectorsService.update(connector.id, update);
  }

  private readAuthConfig(value: string | null): Record<string, unknown> | null {
    if (!value) return null;
    try {
      return JSON.parse(decrypt(value, this.encryptionKey)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private async reload(connectorId: string): Promise<void> {
    try {
      await this.mcpServer.reloadConnectorTools(connectorId);
    } catch (err: any) {
      this.logger.warn(`Failed to reload tools after the Meta sign-in of ${connectorId}: ${err?.message}`);
    }
  }

  private exchangeException(
    err: unknown,
    flavour: MetaLoginFlavour,
    connectorId: string,
    usesPlatformApp: boolean,
  ): BadGatewayException | BadRequestException {
    const e = err instanceof MetaLoginError ? err : new MetaLoginError('network error');
    this.logger.warn(`Meta code exchange failed for connector ${connectorId}: ${e.message}`);
    const provider = metaLoginProviderName(flavour);
    const unavailable = e.status === undefined || e.status >= 500;
    const vars = metaLoginOwnAppVars(flavour);
    const message = unavailable
      ? `${provider} could not complete the sign-in (${e.message}). Try again in a few minutes.`
      : usesPlatformApp
        ? `${provider} refused the sign-in (${e.message}). Authorize again from the connector: a code works once ` +
          'and only for a short time.'
        : `${provider} refused the sign-in (${e.message}). Check that ${vars.appId} and ${vars.appSecret} belong to ` +
          `the same app (${appWhere(flavour)}), that ${this.redirectUrl()} is one of its valid OAuth redirect URIs, ` +
          'and authorize again: a code works once and only for a short time.';
    const payload = { message, connectorId };
    return unavailable ? new BadGatewayException(payload) : new BadRequestException(payload);
  }
}

/** Where the app id and secret are shown in the Meta App Dashboard. */
function appWhere(flavour: MetaLoginFlavour): string {
  return flavour === 'instagram'
    ? 'Meta App Dashboard, Instagram, API setup with Instagram login, Business login settings: Instagram app ID and secret'
    : 'Meta App Dashboard, App settings, Basic: App ID and App secret';
}
