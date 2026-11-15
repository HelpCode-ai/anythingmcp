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
import { decrypt } from '../common/crypto/encryption.util';
import { getRequiredSecret } from '../common/secrets.util';
import { interpolateDeep } from '../common/env-interpolation.util';
import {
  SHEIN_CALLBACK_PATH,
  SheinApp,
  SheinTokenService,
  buildSheinAuthorizationUrl,
  describeSheinError,
  isSheinAuth,
  sheinAppFrom,
  sheinError,
} from './engines/shein-token.service';

/** The pending-flow provider of a SHEIN store authorization. */
export const SHEIN_PROVIDER = 'shein';

/** What the dashboard says when a SHEIN authorization is no longer pending. */
export const SHEIN_EXPIRED_MESSAGE = 'This authorization expired or was already used. Start it again from the connector.';

/**
 * Authorizing a SHEIN shop from the connector page ("Authorize with
 * Provider"), as SHEIN's "Store Authorization Application Manual" describes
 * it.
 *
 * SHEIN sends the browser back to the redirect URL the authorization link
 * named, with `appid`, `tempToken` and our `state`; the tempToken is
 * exchanged with a call signed by the app's id and secret
 * (shein-token.service.ts). Three steps, kept apart from the generic OAuth
 * callback, which is not touched:
 *
 *   1. POST /api/shein-auth/connectors/:id/authorize (signed in, owner or
 *      admin of the connector's workspace): stores a pending attempt (the
 *      same encrypted, single-use store the OAuth flows use) bound to the
 *      connector and the user, and returns SHEIN's authorize link.
 *   2. GET /api/shein-auth/callback: SHEIN's redirect. Only checks that the
 *      state is one we issued for this provider and forwards the tempToken to
 *      the dashboard, like the OAuth callback does with a code.
 *   3. POST /api/shein-auth/complete (signed in): exchanges the tempToken,
 *      but only for the user who started the attempt, in the connector's
 *      workspace, and stores the shop's keys.
 *
 * The same on Cloud and self-hosted: the redirect URL is SERVER_URL +
 * /api/shein-auth/callback.
 */
@ApiTags('SHEIN')
@Controller('api/shein-auth')
export class SheinAuthController {
  private readonly logger = new Logger(SheinAuthController.name);
  private readonly encryptionKey: string;

  constructor(
    private readonly connectorsService: ConnectorsService,
    private readonly oauthFlows: McpOAuthService,
    private readonly sheinTokens: SheinTokenService,
    private readonly mcpServer: McpServerService,
    private readonly configService: ConfigService,
  ) {
    this.encryptionKey = getRequiredSecret('ENCRYPTION_KEY', this.configService.get<string>('ENCRYPTION_KEY'));
  }

  private serverUrl(): string {
    return (this.configService.get<string>('SERVER_URL') || 'http://localhost:4000').replace(/\/+$/, '');
  }

  /** The redirect URL the authorization link names (and the app's settings show). */
  private redirectUrl(): string {
    return `${this.serverUrl()}${SHEIN_CALLBACK_PATH}`;
  }

  private completePage(params: Record<string, string>): string {
    const base = (this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000').replace(/\/+$/, '');
    return `${base}/connectors/oauth/complete?${new URLSearchParams(params).toString()}`;
  }

  /** The connector's SHEIN app settings, resolved from its variables. */
  private sheinApp(connector: { authType: string; authConfig: string | null; envVars?: unknown }): {
    app?: SheinApp;
    isShein: boolean;
  } {
    let authConfig: Record<string, unknown> = {};
    try {
      authConfig = connector.authConfig ? JSON.parse(decrypt(connector.authConfig, this.encryptionKey)) : {};
    } catch {
      authConfig = {};
    }
    if (!isSheinAuth(connector.authType, authConfig)) return { isShein: false };
    const envVars = (connector.envVars as Record<string, string> | null) ?? {};
    return { isShein: true, app: sheinAppFrom(interpolateDeep(authConfig, envVars)) };
  }

  @Get('redirect-uri')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'The redirect URL of a SHEIN store authorization',
    description: 'Computed from SERVER_URL: `<SERVER_URL>/api/shein-auth/callback`. Dashboard session only.',
  })
  redirectUri(): { redirectUri: string } {
    return { redirectUri: this.redirectUrl() };
  }

  @Post('connectors/:id/authorize')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Start the store authorization of a SHEIN connector',
    description:
      "Returns SHEIN's authorize URL, where the seller signs in with the shop's main account and approves the app, and " +
      '`redirectUrl`, the address SHEIN sends the browser back to. Without the App ID and App Secret on the connector, ' +
      'or for a connector that does not use the SHEIN token provider, the answer is `{ "error": "…" }`. Dashboard ' +
      'session only; the connector owner or an admin, never a VIEWER.',
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
    const { app, isShein } = this.sheinApp(connector);
    if (!isShein) return { error: 'This connector does not authorize a SHEIN shop.' };
    if (!app) {
      return {
        error:
          "Set the App ID and the App Secret in this connector's environment variables first (SHEIN Open Platform, " +
          'Application Management, your app), then authorize again.',
      };
    }
    const state = this.oauthFlows.generateState();
    await this.oauthFlows.storePendingFlow(
      state,
      {
        provider: SHEIN_PROVIDER,
        connectorId: connector.id,
        userId: req.user.sub,
        redirectUri: this.redirectUrl(),
        clientId: app.appId,
        tokenUrl: `${app.tokenBaseUrl}${app.tokenPath}`,
        createdAt: Date.now(),
      },
      { returnTo: body?.returnTo },
    );
    return {
      authorizationUrl: buildSheinAuthorizationUrl(app, this.redirectUrl(), state),
      redirectUrl: this.redirectUrl(),
    };
  }

  @Get('callback')
  // Unauthenticated: keep it tight.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: "SHEIN's redirect after a store authorization; forwards to the dashboard" })
  async callback(
    @Query('state') rawState: unknown,
    @Query('tempToken') rawTempToken: unknown,
    @Query('appid') rawAppId: unknown,
    @Res() res: Response,
  ) {
    const state = typeof rawState === 'string' ? rawState : '';
    const tempToken = typeof rawTempToken === 'string' && rawTempToken.trim() ? rawTempToken.trim() : undefined;
    const record = state ? await this.oauthFlows.getPendingFlow(state) : undefined;
    if (!record || record.flow.provider !== SHEIN_PROVIDER) {
      return res.redirect(this.completePage({ error: SHEIN_EXPIRED_MESSAGE }));
    }
    const connectorId = record.flow.connectorId;
    // SHEIN names the app it authorized: it must be the one this attempt started with.
    const appId = typeof rawAppId === 'string' ? rawAppId.trim() : '';
    if (appId && appId !== record.flow.clientId) {
      await this.oauthFlows.deletePendingFlow(state);
      return res.redirect(
        this.completePage({
          error: 'SHEIN came back for another app than the one on this connector. Check the App ID and start again.',
          connectorId,
        }),
      );
    }
    if (!tempToken) {
      await this.oauthFlows.deletePendingFlow(state);
      return res.redirect(
        this.completePage({
          error: 'SHEIN came back without a tempToken. The authorization was cancelled or refused; start it again from the connector.',
          connectorId,
        }),
      );
    }
    // The dashboard's completion page reads the one-time value as `code`, as for every other provider.
    return res.redirect(this.completePage({ provider: SHEIN_PROVIDER, state, code: tempToken }));
  }

  // Called by the dashboard's completion page; not an API to drive by hand.
  @Post('complete')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(200)
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Complete a SHEIN store authorization (dashboard, signed in)' })
  async complete(
    @Req() req: any,
    @Body() body: { state?: string; tempToken?: string },
  ): Promise<{ connectorId: string; toolsImported: number; returnTo?: string }> {
    const state = String(body?.state || '');
    // Check who started the flow before consuming it: another signed-in user
    // holding the state must not be able to burn the owner's authorization.
    const pending = await this.oauthFlows.getPendingFlow(state);
    if (!pending || pending.flow.provider !== SHEIN_PROVIDER) throw new GoneException(SHEIN_EXPIRED_MESSAGE);
    if (pending.flow.userId !== req.user?.sub) {
      this.logger.warn(`Refused SHEIN completion: connector ${pending.flow.connectorId} was authorized by another user`);
      throw new ForbiddenException(
        'This authorization was started by another account. Sign in as that account, or start it again yourself.',
      );
    }
    // Single use: a second request racing this one finds nothing to take.
    const record = await this.oauthFlows.takePendingFlow(state);
    if (!record || record.flow.provider !== SHEIN_PROVIDER || record.flow.userId !== req.user?.sub) {
      throw new GoneException(SHEIN_EXPIRED_MESSAGE);
    }
    const { flow, returnTo } = record;
    const tempToken = typeof body?.tempToken === 'string' ? body.tempToken.trim() : '';
    if (!tempToken) throw new GoneException('SHEIN came back without a tempToken. Start the authorization again.');
    const connector = await this.connectorsService.findByIdInternal(flow.connectorId);
    // The connector must still be in the workspace of the user completing it.
    if (connector.organizationId !== req.user?.organizationId) {
      this.logger.warn(`Refused SHEIN completion: connector ${flow.connectorId} is not in the user's workspace`);
      throw new ForbiddenException('Resource not found');
    }
    const { app } = this.sheinApp(connector as never);
    if (!app) {
      throw new BadRequestException({
        message: 'The connector has no App ID and App Secret any more. Set them and authorize again.',
        connectorId: flow.connectorId,
      });
    }
    try {
      await this.sheinTokens.exchangeTempToken({ connectorId: flow.connectorId, app, tempToken });
    } catch (err) {
      const said = describeSheinError(err);
      const status = sheinError(err)?.status;
      this.logger.warn(`SHEIN tempToken exchange failed for connector ${flow.connectorId}: ${said}`);
      const unavailable = typeof status === 'number' && status >= 500;
      const message = unavailable
        ? `SHEIN could not complete the authorization (${said}). Try again in a few minutes.`
        : `SHEIN refused the authorization (${said}). Check that the App ID and the App Secret belong to the app the ` +
          "shop approved, that this server's outbound address is on the app's IP whitelist, and authorize again: a " +
          'tempToken works once and only for a few minutes.';
      const payload = { message, connectorId: flow.connectorId };
      throw unavailable ? new BadGatewayException(payload) : new BadRequestException(payload);
    }
    try {
      await this.mcpServer.reloadConnectorTools(flow.connectorId);
    } catch (err: any) {
      this.logger.warn(`Failed to reload tools after the SHEIN authorization of ${flow.connectorId}: ${err?.message}`);
    }
    return { connectorId: flow.connectorId, toolsImported: 0, ...(returnTo ? { returnTo } : {}) };
  }
}
