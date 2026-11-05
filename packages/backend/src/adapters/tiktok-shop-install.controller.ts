import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  GoneException,
  HttpCode,
  Logger,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';
import { getRequiredSecret } from '../common/secrets.util';
import { AdaptersService } from './adapters.service';
import { LicenseGuardService } from '../license/license-guard.service';
import { McpServersService } from '../mcp-servers/mcp-servers.service';
import { McpServerService } from '../mcp-server/mcp-server.service';
import { ConnectorsService } from '../connectors/connectors.service';
import { McpOAuthService } from '../connectors/mcp-oauth.service';
import {
  TikTokShopTokenService,
  describeTikTokShopError,
  tiktokShopAppOfConnector,
  tiktokShopNeedsAuthorization,
  tiktokShopPlatformApp,
  TIKTOK_SHOP_OWN_APP_VARS,
} from '../connectors/engines/tiktok-shop-token.service';
import {
  TIKTOK_SHOP_INSTALL_PROVIDER,
  TIKTOK_SHOP_MARKET_VAR,
  TIKTOK_SHOP_SHOP_VAR,
  tiktokShopExchangeException,
} from '../connectors/tiktok-shop-auth.controller';
import { decrypt } from '../common/crypto/encryption.util';
import { interpolateDeep } from '../common/env-interpolation.util';

/** The catalog adapter a store install adds. */
export const TIKTOK_SHOP_SLUG = 'tiktok-shop';

const INSTALL_EXPIRED =
  'This TikTok Shop installation expired or was already used. Install the app again from the TikTok Shop App Store, ' +
  'or add the TikTok Shop connector in AnythingMCP and click Authorize with Provider.';

/**
 * The second half of a TikTok Shop App Store install. TikTok's redirect had
 * a code but no state of ours, so the callback (tiktok-shop-auth.controller)
 * kept it as a single-use install record and sent the seller here, through
 * the dashboard, to sign in or sign up first.
 *
 * POST /api/tiktok-shop/install (signed in, not a viewer): takes the record,
 * reuses the workspace's most recent TikTok Shop connector that works with
 * the server's app and still waits for an authorization (one the caller may
 * change), else installs the `tiktok-shop` catalog adapter like the catalog
 * does (plan limits, the caller as owner, the default MCP server) with its
 * app variables empty, then exchanges the code with the server's app.
 *
 * Here and not next to the callback: installing goes through AdaptersService,
 * whose module already imports the connectors module.
 */
@ApiTags('TikTok Shop')
@Controller('api/tiktok-shop')
export class TikTokShopInstallController {
  private readonly logger = new Logger(TikTokShopInstallController.name);
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: AdaptersService,
    private readonly licenseGuard: LicenseGuardService,
    private readonly mcpServers: McpServersService,
    private readonly mcpServer: McpServerService,
    private readonly connectorsService: ConnectorsService,
    private readonly oauthFlows: McpOAuthService,
    private readonly tiktokShopTokens: TikTokShopTokenService,
    private readonly configService: ConfigService,
  ) {
    this.encryptionKey = getRequiredSecret('ENCRYPTION_KEY', this.configService.get<string>('ENCRYPTION_KEY'));
  }

  @Post('install')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(200)
  @ApiOperation({ summary: 'Complete a TikTok Shop App Store install (dashboard, signed in)' })
  async install(
    @Req() req: any,
    @Body() body: { state?: string },
  ): Promise<{ connectorId: string; toolsImported: number; created: boolean }> {
    const userId: string = req.user?.sub;
    const organizationId: string = req.user?.organizationId;
    // Before the record is touched: a viewer must not burn the seller's code.
    if (req.user?.role === 'VIEWER') throw new ForbiddenException('Viewers cannot modify connectors');
    const state = typeof body?.state === 'string' ? body.state : '';
    const pending = await this.oauthFlows.getPendingFlow(state);
    if (!pending || pending.flow.provider !== TIKTOK_SHOP_INSTALL_PROVIDER || !pending.flow.code) {
      throw new GoneException(INSTALL_EXPIRED);
    }
    const platform = tiktokShopPlatformApp();
    if (!platform || platform.appKey !== pending.flow.clientId) {
      throw new BadRequestException({
        message:
          'This server no longer has the TikTok Shop app this installation was for. Add the TikTok Shop connector ' +
          'with your own app instead.',
      });
    }

    const reuse = await this.reusableConnector(organizationId, userId, req.user?.role);
    // Checked before the record is taken: a plan limit leaves the install usable after an upgrade.
    if (!reuse) await this.licenseGuard.checkCanCreateConnector(userId, organizationId);

    // Single use: a second request racing this one finds nothing to take.
    const record = await this.oauthFlows.takePendingFlow(state);
    if (!record || record.flow.provider !== TIKTOK_SHOP_INSTALL_PROVIDER || !record.flow.code) {
      throw new GoneException(INSTALL_EXPIRED);
    }
    const code = record.flow.code;

    let connectorId = reuse;
    const created = !connectorId;
    if (!connectorId) {
      const imported = await this.adapters.importAdapter(TIKTOK_SHOP_SLUG, userId, organizationId, {
        // Saved empty, not left out: an empty App key is what makes the
        // connector use the server's app, and no {{placeholder}} is left.
        [TIKTOK_SHOP_OWN_APP_VARS.appKey]: '',
        [TIKTOK_SHOP_OWN_APP_VARS.appSecret]: '',
        [TIKTOK_SHOP_OWN_APP_VARS.serviceId]: '',
        // A US shop authorizes again on TikTok Shop's US site.
        [TIKTOK_SHOP_MARKET_VAR]: record.flow.shopRegion === 'US' ? 'US' : '',
        [TIKTOK_SHOP_SHOP_VAR]: '',
      });
      connectorId = imported.connectorId;
      await this.mcpServers.attachToDefaultServer(userId, organizationId, connectorId);
      this.logger.log(`TikTok Shop App Store install: added connector ${connectorId}`);
    } else {
      this.logger.log(`TikTok Shop App Store install: reusing connector ${connectorId}`);
    }

    const connector = await this.connectorsService.findByIdInternal(connectorId);
    const { app, envVars, usesPlatformApp } = tiktokShopAppOfConnector(connector as never, this.encryptionKey, platform);
    if (!app || !usesPlatformApp) {
      throw new BadRequestException({
        message: 'The TikTok Shop connector could not use the server app. Open it and click Authorize with Provider.',
        connectorId,
      });
    }
    try {
      await this.tiktokShopTokens.exchangeCode({
        connectorId,
        app,
        code,
        preferredShop: envVars[TIKTOK_SHOP_SHOP_VAR] || undefined,
      });
    } catch (err) {
      this.logger.warn(`TikTok Shop install: code exchange failed for connector ${connectorId}: ${describeTikTokShopError(err)}`);
      throw tiktokShopExchangeException(err, connectorId, true);
    }
    try {
      await this.mcpServer.reloadConnectorTools(connectorId);
    } catch (err: any) {
      this.logger.warn(`Failed to reload tools after the TikTok Shop install of ${connectorId}: ${err?.message}`);
    }
    return { connectorId, toolsImported: 0, created };
  }

  /**
   * The workspace's most recent TikTok Shop catalog connector that uses the
   * server's app and has no shop authorized yet, among those the caller may
   * change (their own, or any for an admin).
   */
  private async reusableConnector(organizationId: string, userId: string, role?: string): Promise<string | undefined> {
    const rows = await this.prisma.connector.findMany({
      where: {
        organizationId,
        authType: 'HMAC',
        config: { path: ['adapterSlug'], equals: TIKTOK_SHOP_SLUG },
        ...(role === 'ADMIN' ? {} : { userId }),
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, authType: true, authConfig: true, baseUrl: true, envVars: true },
    });
    for (const row of rows) {
      const { isTikTokShop, usesPlatformApp } = tiktokShopAppOfConnector(row, this.encryptionKey);
      if (!isTikTokShop || !usesPlatformApp) continue;
      if (tiktokShopNeedsAuthorization(row.authType, this.resolvedAuthConfig(row))) return row.id;
    }
    return undefined;
  }

  private resolvedAuthConfig(row: { authConfig: string | null; envVars: unknown }): Record<string, unknown> {
    try {
      const raw = row.authConfig ? JSON.parse(decrypt(row.authConfig, this.encryptionKey)) : {};
      return interpolateDeep(raw, (row.envVars as Record<string, string> | null) ?? {});
    } catch {
      return {};
    }
  }
}
