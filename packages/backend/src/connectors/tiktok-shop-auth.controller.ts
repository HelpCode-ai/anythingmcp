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
import { getRequiredSecret } from '../common/secrets.util';
import {
  TIKTOK_SHOP_AUTH_HOST,
  TIKTOK_SHOP_TOKEN_GET_PATH,
  TikTokShopTokenService,
  buildTikTokShopAuthorizationUrl,
  describeTikTokShopError,
  tiktokShopAppOfConnector,
  tiktokShopError,
  tiktokShopPlatformApp,
} from './engines/tiktok-shop-token.service';

/** The connector variable that names the shop to use when the seller authorizes several. */
export const TIKTOK_SHOP_SHOP_VAR = 'TIKTOK_SHOP_SHOP_ID';
/** The connector variable that sends US sellers to TikTok Shop's US authorization domain. */
export const TIKTOK_SHOP_MARKET_VAR = 'TIKTOK_SHOP_MARKET';
/** The pending-flow provider of a TikTok Shop App Store install (no state of ours). */
export const TIKTOK_SHOP_INSTALL_PROVIDER = 'tiktok-shop-install';
/** How long a store install waits for the seller to sign in or sign up. A TikTok code lives 30 minutes. */
export const TIKTOK_SHOP_INSTALL_TTL_MS = 30 * 60 * 1000;
/** What the dashboard says when a TikTok Shop authorization is no longer pending. */
export const TIKTOK_SHOP_EXPIRED_MESSAGE =
  'This authorization expired or was already used. Start it again from the connector.';

/**
 * The exception for a refused or failed code exchange, as the dashboard
 * shows it: a TikTok 5xx is "try again", anything else names what to check.
 * A connector on the server's app has no app keys of its own to check.
 */
export function tiktokShopExchangeException(
  err: unknown,
  connectorId: string,
  usesPlatformApp: boolean,
): BadGatewayException | BadRequestException {
  const said = describeTikTokShopError(err);
  const status = tiktokShopError(err)?.status;
  const unavailable = typeof status === 'number' && status >= 500;
  const message = unavailable
    ? `TikTok Shop could not complete the authorization (${said}). Try again in a few minutes.`
    : usesPlatformApp
      ? `TikTok Shop refused the authorization (${said}). Authorize again from the connector: a code works once ` +
        'and only for 30 minutes.'
      : `TikTok Shop refused the authorization (${said}). Check that TIKTOK_SHOP_APP_KEY and ` +
        'TIKTOK_SHOP_APP_SECRET belong to the app you authorized, and authorize again: a code works once and ' +
        'only for 30 minutes.';
  const payload = { message, connectorId };
  return unavailable ? new BadGatewayException(payload) : new BadRequestException(payload);
}

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
 *
 * A connector with no App key of its own uses the server's TikTok Shop app
 * (TIKTOK_SHOP_PLATFORM_APP_KEY / _APP_SECRET / _SERVICE_ID), when the server
 * has one. Such an app is listed in the TikTok Shop App Store, and an install
 * from there reaches the callback with a code but without a state of ours:
 * the callback keeps it as a single-use install record and sends the seller
 * to the dashboard, where POST /api/tiktok-shop/install
 * (tiktok-shop-install.controller.ts, in the adapters module) adds the
 * connector and exchanges the code once they are signed in.
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

  /** The connector's TikTok Shop app: its own, or the server's when it has no App key. */
  private tiktokShopApp(connector: { authType: string; authConfig: string | null; baseUrl: string; envVars?: unknown }) {
    return tiktokShopAppOfConnector(connector, this.encryptionKey);
  }

  @Get('platform')
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({
    summary: "Whether this server has its own TikTok Shop app, and the Redirect URL to set on a seller's own app",
  })
  platform(): { available: boolean; redirectUrl: string } {
    return { available: !!tiktokShopPlatformApp(), redirectUrl: this.redirectUrl() };
  }

  @Post('connectors/:id/authorize')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Start the authorization of a TikTok shop for a connector',
    description:
      'Returns the TikTok Shop URL where the seller authorizes the app, and `redirectUrl`, the Redirect URL to set ' +
      'on a seller\'s own app. TikTok Shop then sends the browser back to this server. Without the app values ' +
      '(TIKTOK_SHOP_APP_KEY, TIKTOK_SHOP_APP_SECRET, TIKTOK_SHOP_SERVICE_ID) on the connector, or for a connector ' +
      'that is not a TikTok Shop one, the answer is `{ "error": "…" }`. Dashboard session only; ' +
      'the connector owner or an admin, never a VIEWER.',
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
  // Unauthenticated, and a store install writes a pending record: keep it tight.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: "TikTok Shop's redirect after a seller authorization; forwards to the dashboard" })
  async callback(
    @Query('state') rawState: unknown,
    @Query('code') rawCode: unknown,
    @Query('error') rawError: unknown,
    @Res() res: Response,
    @Query('app_key') rawAppKey?: unknown,
    @Query('shop_region') rawShopRegion?: unknown,
  ) {
    const state = typeof rawState === 'string' ? rawState : '';
    // TikTok sends `code=null&error=auth_denied` when the seller declines.
    const code = typeof rawCode === 'string' && rawCode && rawCode !== 'null' ? rawCode : undefined;
    // An install from the TikTok Shop App Store carries no state at all.
    if (!state && code) {
      const installState = await this.storeInstall(code, rawAppKey, rawShopRegion);
      if (installState) {
        return res.redirect(this.completePage({ provider: TIKTOK_SHOP_INSTALL_PROVIDER, state: installState }));
      }
    }
    const record = state ? await this.oauthFlows.getPendingFlow(state) : undefined;
    if (!record || record.flow.provider !== 'tiktok-shop') {
      return res.redirect(this.completePage({ error: TIKTOK_SHOP_EXPIRED_MESSAGE }));
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

  /**
   * Keep a store install's code as a single-use pending record and return
   * its new state; undefined (nothing stored) when the server has no TikTok
   * Shop app, or the install names another app's key. The code stays in the
   * encrypted pending store, not in the dashboard address.
   */
  private async storeInstall(code: string, rawAppKey: unknown, rawShopRegion: unknown): Promise<string | undefined> {
    const platform = tiktokShopPlatformApp();
    if (!platform) return undefined;
    const appKey = typeof rawAppKey === 'string' ? rawAppKey.trim() : '';
    if (appKey && appKey !== platform.appKey) {
      this.logger.warn("Refused a TikTok Shop install without a state: it names another app's key");
      return undefined;
    }
    const region = typeof rawShopRegion === 'string' ? rawShopRegion.trim().toUpperCase() : '';
    const state = this.oauthFlows.generateState();
    await this.oauthFlows.storePendingFlow(
      state,
      {
        provider: TIKTOK_SHOP_INSTALL_PROVIDER,
        connectorId: '',
        userId: '',
        redirectUri: this.redirectUrl(),
        clientId: platform.appKey,
        tokenUrl: `${TIKTOK_SHOP_AUTH_HOST}${TIKTOK_SHOP_TOKEN_GET_PATH}`,
        code,
        ...(/^[A-Z]{2,3}$/.test(region) ? { shopRegion: region } : {}),
        createdAt: Date.now(),
      },
      { ttlMs: TIKTOK_SHOP_INSTALL_TTL_MS },
    );
    this.logger.log('Stored a TikTok Shop App Store install for the dashboard to complete');
    return state;
  }

  // Called by the dashboard's completion page; not an API to drive by hand.
  @Post('complete')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(200)
  @ApiExcludeEndpoint()
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
      throw new GoneException(TIKTOK_SHOP_EXPIRED_MESSAGE);
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
      throw new GoneException(TIKTOK_SHOP_EXPIRED_MESSAGE);
    }
    const { flow, returnTo } = record;
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!code) throw new GoneException('TikTok Shop came back without a code. Start the authorization again.');
    const connector = await this.connectorsService.findByIdInternal(flow.connectorId);
    const { app, envVars, usesPlatformApp } = this.tiktokShopApp(connector as never);
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
      this.logger.warn(`TikTok Shop code exchange failed for connector ${flow.connectorId}: ${describeTikTokShopError(err)}`);
      throw tiktokShopExchangeException(err, flow.connectorId, usesPlatformApp);
    }
    try {
      await this.mcpServer.reloadConnectorTools(flow.connectorId);
    } catch (err: any) {
      this.logger.warn(`Failed to reload tools after the TikTok Shop authorization of ${flow.connectorId}: ${err?.message}`);
    }
    return { connectorId: flow.connectorId, toolsImported: 0, ...(returnTo ? { returnTo } : {}) };
  }
}
