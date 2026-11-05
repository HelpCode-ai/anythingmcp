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
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { ConnectorsService } from './connectors.service';
import { McpOAuthService } from './mcp-oauth.service';
import { McpServerService } from '../mcp-server/mcp-server.service';
import { decrypt } from '../common/crypto/encryption.util';
import { getRequiredSecret } from '../common/secrets.util';
import { interpolateDeep, interpolateString } from '../common/env-interpolation.util';
import {
  TIKTOK_SHOP_AUTH_HOST,
  TIKTOK_SHOP_TOKEN_GET_PATH,
  TikTokShopApp,
  TikTokShopTokenService,
  buildTikTokShopAuthorizationUrl,
  describeTikTokShopError,
  isTikTokShopAuth,
  tiktokShopAppFrom,
  tiktokShopError,
} from './engines/tiktok-shop-token.service';

/** The connector variable that names the shop to use when the seller authorizes several. */
export const TIKTOK_SHOP_SHOP_VAR = 'TIKTOK_SHOP_SHOP_ID';
/** The connector variable that sends US sellers to TikTok Shop's US authorization domain. */
export const TIKTOK_SHOP_MARKET_VAR = 'TIKTOK_SHOP_MARKET';

/**
 * Authorizing a TikTok shop from the connector page ("Authorize with Provider").
 *
 * TikTok Shop's seller authorization is OAuth-like but not OAuth 2: the link
 * carries the app's `service_id`, TikTok sends the browser back to the one
 * Redirect URL set on the app in Partner Center (so the state travels as a
 * query parameter, not in the path), and the code is exchanged with a GET
 * that carries the app key and secret. So it has its own three steps here,
 * kept apart from the generic OAuth callback, which is not touched:
 *
 *   1. POST /api/tiktok-shop/connectors/:id/authorize (signed in, owner or
 *      admin): stores a pending attempt (the same encrypted, single-use
 *      store the OAuth flows use) and returns the authorization link.
 *   2. GET /api/tiktok-shop/callback: TikTok's redirect. Only checks that the
 *      state is one we issued and forwards the code to the dashboard, like
 *      the OAuth callback does.
 *   3. POST /api/tiktok-shop/complete (signed in): exchanges the code, but
 *      only for the user who started the attempt, and stores the tokens.
 */
@ApiTags('TikTok Shop')
@Controller('api/tiktok-shop')
export class TikTokShopAuthController {
  private readonly logger = new Logger(TikTokShopAuthController.name);
  private readonly encryptionKey: string;

  constructor(
    private readonly connectorsService: ConnectorsService,
    private readonly oauthFlows: McpOAuthService,
    private readonly tiktokShopTokens: TikTokShopTokenService,
    private readonly mcpServer: McpServerService,
    private readonly configService: ConfigService,
  ) {
    this.encryptionKey = getRequiredSecret('ENCRYPTION_KEY', this.configService.get<string>('ENCRYPTION_KEY'));
  }

  private serverUrl(): string {
    return (this.configService.get<string>('SERVER_URL') || 'http://localhost:4000').replace(/\/+$/, '');
  }

  /** The Redirect URL to set on the TikTok Shop app in Partner Center. */
  private redirectUrl(): string {
    return `${this.serverUrl()}/api/tiktok-shop/callback`;
  }

  private completePage(params: Record<string, string>): string {
    const base = (this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000').replace(/\/+$/, '');
    return `${base}/connectors/oauth/complete?${new URLSearchParams(params).toString()}`;
  }

  /** The connector's TikTok Shop app settings, resolved from its variables. */
  private tiktokShopApp(connector: {
    authType: string;
    authConfig: string | null;
    baseUrl: string;
    envVars?: unknown;
  }): { app?: TikTokShopApp; isTikTokShop: boolean; envVars: Record<string, string> } {
    let authConfig: Record<string, unknown> = {};
    try {
      authConfig = connector.authConfig ? JSON.parse(decrypt(connector.authConfig, this.encryptionKey)) : {};
    } catch {
      authConfig = {};
    }
    const envVars = (connector.envVars as Record<string, string> | null) ?? {};
    if (!isTikTokShopAuth(connector.authType, authConfig)) return { isTikTokShop: false, envVars };
    return {
      isTikTokShop: true,
      envVars,
      app: tiktokShopAppFrom(interpolateDeep(authConfig, envVars), interpolateString(connector.baseUrl, envVars)),
    };
  }

  @Post('connectors/:id/authorize')
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'Start the authorization of a TikTok shop for a connector' })
  async authorize(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body?: { returnTo?: string },
  ): Promise<{ authorizationUrl?: string; redirectUrl?: string; error?: string }> {
    const connector = await this.connectorsService.findById(id);
    if (connector.organizationId !== req.user?.organizationId) throw new ForbiddenException('Resource not found');
    if (req.user.role === 'VIEWER') throw new ForbiddenException('Viewers cannot modify connectors');
    if (connector.userId !== req.user.sub && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('Only the connector owner or an admin can modify this connector');
    }
    const { app, isTikTokShop, envVars } = this.tiktokShopApp(connector);
    if (!isTikTokShop) return { error: 'This connector does not authorize a TikTok shop.' };
    if (!app) {
      return {
        error:
          "Set TIKTOK_SHOP_APP_KEY and TIKTOK_SHOP_APP_SECRET in this connector's environment variables first " +
          '(Partner Center, App & Service, your app).',
      };
    }
    if (!app.serviceId) {
      return {
        error:
          "Set TIKTOK_SHOP_SERVICE_ID in this connector's environment variables first: Partner Center, App & Service, " +
          'your app, Basic Information, Service ID.',
      };
    }
    const state = this.oauthFlows.generateState();
    await this.oauthFlows.storePendingFlow(
      state,
      {
        provider: 'tiktok-shop',
        connectorId: connector.id,
        userId: req.user.sub,
        redirectUri: this.redirectUrl(),
        clientId: app.appKey,
        tokenUrl: `${TIKTOK_SHOP_AUTH_HOST}${TIKTOK_SHOP_TOKEN_GET_PATH}`,
        createdAt: Date.now(),
      },
      { returnTo: body?.returnTo },
    );
    return {
      authorizationUrl: buildTikTokShopAuthorizationUrl(app.serviceId, state, envVars[TIKTOK_SHOP_MARKET_VAR]),
      redirectUrl: this.redirectUrl(),
    };
  }

  @Get('callback')
  @ApiOperation({ summary: "TikTok Shop's redirect after a seller authorization; forwards to the dashboard" })
  async callback(
    @Query('state') rawState: unknown,
    @Query('code') rawCode: unknown,
    @Query('error') rawError: unknown,
    @Res() res: Response,
  ) {
    const state = typeof rawState === 'string' ? rawState : '';
    // TikTok sends `code=null&error=auth_denied` when the seller declines.
    const code = typeof rawCode === 'string' && rawCode && rawCode !== 'null' ? rawCode : undefined;
    const record = state ? await this.oauthFlows.getPendingFlow(state) : undefined;
    if (!record || record.flow.provider !== 'tiktok-shop') {
      return res.redirect(
        this.completePage({ error: 'This authorization expired or was already used. Start it again from the connector.' }),
      );
    }
    const connectorId = record.flow.connectorId;
    if (!code) {
      await this.oauthFlows.deletePendingFlow(state);
      return res.redirect(
        this.completePage({
          error:
            rawError === 'auth_denied'
              ? 'The authorization was declined in TikTok Shop. Start it again from the connector and approve the app.'
              : 'TikTok Shop came back without an authorization code. The authorization was cancelled or refused; start it again.',
          connectorId,
        }),
      );
    }
    return res.redirect(this.completePage({ provider: 'tiktok-shop', state, code }));
  }

  @Post('complete')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(200)
  @ApiOperation({ summary: 'Complete a TikTok Shop seller authorization (dashboard, signed in)' })
  async complete(
    @Req() req: any,
    @Body() body: { state?: string; code?: string },
  ): Promise<{ connectorId: string; toolsImported: number; returnTo?: string }> {
    const state = String(body?.state || '');
    // Check who started the flow before consuming it: another signed-in user
    // holding the state must not be able to burn the owner's authorization.
    const pending = await this.oauthFlows.getPendingFlow(state);
    if (!pending || pending.flow.provider !== 'tiktok-shop') {
      throw new GoneException('This authorization expired or was already used. Start it again from the connector.');
    }
    if (pending.flow.userId !== req.user?.sub) {
      this.logger.warn(`Refused TikTok Shop completion: connector ${pending.flow.connectorId} was authorized by another user`);
      throw new ForbiddenException(
        'This authorization was started by another account. Sign in as that account, or start it again yourself.',
      );
    }
    // Single use: a second request racing this one finds nothing to take.
    const record = await this.oauthFlows.takePendingFlow(state);
    if (!record || record.flow.provider !== 'tiktok-shop' || record.flow.userId !== req.user?.sub) {
      throw new GoneException('This authorization expired or was already used. Start it again from the connector.');
    }
    const { flow, returnTo } = record;
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!code) throw new GoneException('TikTok Shop came back without a code. Start the authorization again.');
    const connector = await this.connectorsService.findByIdInternal(flow.connectorId);
    const { app, envVars } = this.tiktokShopApp(connector as never);
    if (!app) {
      throw new BadRequestException({
        message: 'The connector has no TikTok Shop app key and secret any more. Set them and authorize again.',
        connectorId: flow.connectorId,
      });
    }
    try {
      await this.tiktokShopTokens.exchangeCode({
        connectorId: flow.connectorId,
        app,
        code,
        preferredShop: envVars[TIKTOK_SHOP_SHOP_VAR],
      });
    } catch (err) {
      const said = describeTikTokShopError(err);
      const status = tiktokShopError(err)?.status;
      this.logger.warn(`TikTok Shop code exchange failed for connector ${flow.connectorId}: ${said}`);
      const message =
        typeof status === 'number' && status >= 500
          ? `TikTok Shop could not complete the authorization (${said}). Try again in a few minutes.`
          : `TikTok Shop refused the authorization (${said}). Check that TIKTOK_SHOP_APP_KEY and ` +
            'TIKTOK_SHOP_APP_SECRET belong to the app you authorized, and authorize again: a code works once and ' +
            'only for 30 minutes.';
      const payload = { message, connectorId: flow.connectorId };
      throw typeof status === 'number' && status >= 500 ? new BadGatewayException(payload) : new BadRequestException(payload);
    }
    try {
      await this.mcpServer.reloadConnectorTools(flow.connectorId);
    } catch (err: any) {
      this.logger.warn(`Failed to reload tools after the TikTok Shop authorization of ${flow.connectorId}: ${err?.message}`);
    }
    return { connectorId: flow.connectorId, toolsImported: 0, ...(returnTo ? { returnTo } : {}) };
  }
}
