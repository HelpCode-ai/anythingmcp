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
  SHOPEE_TOKEN_GET_PATH,
  ShopeeApp,
  ShopeeTokenService,
  buildShopeeAuthorizationUrl,
  describeShopeeError,
  isShopeeAuth,
  shopeeAppFrom,
  shopeeError,
} from './engines/shopee-token.service';

/**
 * Authorizing a Shopee shop from the connector page ("Authorize with Provider").
 *
 * Shopee's shop authorization is not OAuth 2: the link is signed with the
 * partner key, and Shopee sends the browser back with `code` and `shop_id`
 * (no `state`). So it has its own three steps here, kept apart from the
 * generic OAuth callback, which is not touched:
 *
 *   1. POST /api/shopee/connectors/:id/authorize (signed in, owner or admin):
 *      stores a pending attempt (the same encrypted, single-use store the
 *      OAuth flows use) and returns the signed auth_partner link, whose
 *      redirect carries the attempt's state in its path.
 *   2. GET /api/shopee/callback/:state: Shopee's redirect. Only checks that
 *      the state is one we issued and forwards code and shop_id to the
 *      dashboard, like the OAuth callback does.
 *   3. POST /api/shopee/complete (signed in): exchanges the code, but only
 *      for the user who started the attempt, and stores the tokens.
 */
@ApiTags('Shopee')
@Controller('api/shopee')
export class ShopeeAuthController {
  private readonly logger = new Logger(ShopeeAuthController.name);
  private readonly encryptionKey: string;

  constructor(
    private readonly connectorsService: ConnectorsService,
    private readonly oauthFlows: McpOAuthService,
    private readonly shopeeTokens: ShopeeTokenService,
    private readonly mcpServer: McpServerService,
    private readonly configService: ConfigService,
  ) {
    this.encryptionKey = getRequiredSecret('ENCRYPTION_KEY', this.configService.get<string>('ENCRYPTION_KEY'));
  }

  private serverUrl(): string {
    return (this.configService.get<string>('SERVER_URL') || 'http://localhost:4000').replace(/\/+$/, '');
  }

  private completePage(params: Record<string, string>): string {
    const base = (this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000').replace(/\/+$/, '');
    return `${base}/connectors/oauth/complete?${new URLSearchParams(params).toString()}`;
  }

  /** The connector's Shopee app settings, resolved from its variables. */
  private shopeeApp(connector: {
    authType: string;
    authConfig: string | null;
    baseUrl: string;
    envVars?: unknown;
  }): { app?: ShopeeApp; isShopee: boolean } {
    let authConfig: Record<string, unknown> = {};
    try {
      authConfig = connector.authConfig ? JSON.parse(decrypt(connector.authConfig, this.encryptionKey)) : {};
    } catch {
      authConfig = {};
    }
    if (!isShopeeAuth(connector.authType, authConfig)) return { isShopee: false };
    const envVars = (connector.envVars as Record<string, string> | null) ?? {};
    return {
      isShopee: true,
      app: shopeeAppFrom(interpolateDeep(authConfig, envVars), interpolateString(connector.baseUrl, envVars)),
    };
  }

  @Post('connectors/:id/authorize')
  @UseGuards(AuthGuard('jwt'))
  @ApiOperation({ summary: 'Start the authorization of a Shopee shop for a connector' })
  async authorize(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body?: { returnTo?: string },
  ): Promise<{ authorizationUrl?: string; error?: string }> {
    const connector = await this.connectorsService.findById(id);
    if (connector.organizationId !== req.user?.organizationId) throw new ForbiddenException('Resource not found');
    if (req.user.role === 'VIEWER') throw new ForbiddenException('Viewers cannot modify connectors');
    if (connector.userId !== req.user.sub && req.user.role !== 'ADMIN') {
      throw new ForbiddenException('Only the connector owner or an admin can modify this connector');
    }
    const { app, isShopee } = this.shopeeApp(connector);
    if (!isShopee) return { error: 'This connector does not authorize a Shopee shop.' };
    if (!app) {
      return {
        error:
          "Set SHOPEE_PARTNER_ID and SHOPEE_PARTNER_KEY in this connector's environment variables first, " +
          'and check that SHOPEE_HOST is a URL such as https://partner.shopeemobile.com.',
      };
    }
    const state = this.oauthFlows.generateState();
    const redirect = `${this.serverUrl()}/api/shopee/callback/${state}`;
    await this.oauthFlows.storePendingFlow(
      state,
      {
        provider: 'shopee',
        connectorId: connector.id,
        userId: req.user.sub,
        redirectUri: redirect,
        clientId: app.partnerId,
        tokenUrl: `${app.host}${SHOPEE_TOKEN_GET_PATH}`,
        createdAt: Date.now(),
      },
      { returnTo: body?.returnTo },
    );
    return { authorizationUrl: buildShopeeAuthorizationUrl(app, redirect) };
  }

  @Get('callback/:state')
  @ApiOperation({ summary: "Shopee's redirect after a shop authorization; forwards to the dashboard" })
  async callback(
    @Param('state') state: string,
    @Query('code') rawCode: unknown,
    @Query('shop_id') rawShopId: unknown,
    @Query('main_account_id') rawMainAccount: unknown,
    @Res() res: Response,
  ) {
    const code = typeof rawCode === 'string' ? rawCode : undefined;
    const shopId = typeof rawShopId === 'string' ? rawShopId : undefined;
    const record = await this.oauthFlows.getPendingFlow(String(state || ''));
    if (!record || record.flow.provider !== 'shopee') {
      return res.redirect(
        this.completePage({ error: 'This authorization expired or was already used. Start it again from the connector.' }),
      );
    }
    const connectorId = record.flow.connectorId;
    if (!code) {
      await this.oauthFlows.deletePendingFlow(state);
      return res.redirect(
        this.completePage({
          error: 'Shopee came back without an authorization code. The authorization was cancelled or refused; start it again.',
          connectorId,
        }),
      );
    }
    if (!shopId || !/^\d{1,20}$/.test(shopId)) {
      await this.oauthFlows.deletePendingFlow(state);
      return res.redirect(
        this.completePage({
          error:
            typeof rawMainAccount === 'string'
              ? 'Shopee authorized a main (merchant) account. This connector works with one shop: authorize again and sign in with the shop account.'
              : 'Shopee came back without a shop id. Start the authorization again and pick a shop.',
          connectorId,
        }),
      );
    }
    return res.redirect(this.completePage({ provider: 'shopee', state, code, shop_id: shopId }));
  }

  @Post('complete')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(200)
  @ApiOperation({ summary: 'Complete a Shopee shop authorization (dashboard, signed in)' })
  async complete(
    @Req() req: any,
    @Body() body: { state?: string; code?: string; shopId?: string },
  ): Promise<{ connectorId: string; toolsImported: number; returnTo?: string }> {
    const state = String(body?.state || '');
    // Check who started the flow before consuming it: another signed-in user
    // holding the state must not be able to burn the owner's authorization.
    const pending = await this.oauthFlows.getPendingFlow(state);
    if (!pending || pending.flow.provider !== 'shopee') {
      throw new GoneException('This authorization expired or was already used. Start it again from the connector.');
    }
    if (pending.flow.userId !== req.user?.sub) {
      this.logger.warn(`Refused Shopee completion: connector ${pending.flow.connectorId} was authorized by another user`);
      throw new ForbiddenException(
        'This authorization was started by another account. Sign in as that account, or start it again yourself.',
      );
    }
    // Single use: a second request racing this one finds nothing to take.
    const record = await this.oauthFlows.takePendingFlow(state);
    if (!record || record.flow.provider !== 'shopee' || record.flow.userId !== req.user?.sub) {
      throw new GoneException('This authorization expired or was already used. Start it again from the connector.');
    }
    const { flow, returnTo } = record;
    const code = typeof body?.code === 'string' ? body.code : '';
    const shopId = typeof body?.shopId === 'string' ? body.shopId : '';
    if (!code || !/^\d{1,20}$/.test(shopId)) {
      throw new GoneException('Shopee came back without a code or shop id. Start the authorization again.');
    }
    const connector = await this.connectorsService.findByIdInternal(flow.connectorId);
    const { app } = this.shopeeApp(connector as never);
    if (!app) {
      throw new BadRequestException({
        message: 'The connector has no Shopee partner id and key any more. Set them and authorize again.',
        connectorId: flow.connectorId,
      });
    }
    try {
      await this.shopeeTokens.exchangeCode({ connectorId: flow.connectorId, app, code, shopId });
    } catch (err) {
      const said = describeShopeeError(err);
      const status = shopeeError(err)?.status;
      this.logger.warn(`Shopee code exchange failed for connector ${flow.connectorId}: ${said}`);
      const message =
        typeof status === 'number' && status >= 500
          ? `Shopee could not complete the authorization (${said}). Try again in a few minutes.`
          : `Shopee refused the authorization (${said}). Check that SHOPEE_PARTNER_ID and SHOPEE_PARTNER_KEY belong ` +
            'to the same app, that SHOPEE_HOST matches it (live or sandbox), and authorize again: a code works once ' +
            'and only for a few minutes.';
      const payload = { message, connectorId: flow.connectorId };
      throw typeof status === 'number' && status >= 500 ? new BadGatewayException(payload) : new BadRequestException(payload);
    }
    try {
      await this.mcpServer.reloadConnectorTools(flow.connectorId);
    } catch (err: any) {
      this.logger.warn(`Failed to reload tools after the Shopee authorization of ${flow.connectorId}: ${err?.message}`);
    }
    return { connectorId: flow.connectorId, toolsImported: 0, ...(returnTo ? { returnTo } : {}) };
  }
}
