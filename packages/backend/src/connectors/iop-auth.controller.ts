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
  IOP_CALLBACK_PATH,
  IopApp,
  IopTokenService,
  buildIopAuthorizationUrl,
  describeIopError,
  iopAppFrom,
  iopError,
  isIopAuth,
} from './engines/iop-token.service';

/** The pending-flow provider of an IOP seller authorization. */
export const IOP_PROVIDER = 'iop';

/** What the dashboard says when an IOP authorization is no longer pending. */
export const IOP_EXPIRED_MESSAGE = 'This authorization expired or was already used. Start it again from the connector.';

/**
 * Authorizing a seller at an Alibaba IOP gateway (Lazada, Miravia,
 * AliExpress seller) from the connector page ("Authorize with Provider").
 *
 * The gateways' "code for token" flow is OAuth-like, but the code is
 * exchanged with a call signed by the app secret (iop-token.service.ts), and
 * the gateway sends the browser back to the one callback URL set on the app,
 * so the state travels as a query parameter. Three steps, kept apart from the
 * generic OAuth callback, which is not touched:
 *
 *   1. POST /api/iop-auth/connectors/:id/authorize (signed in, owner or
 *      admin of the connector's workspace): stores a pending attempt (the
 *      same encrypted, single-use store the OAuth flows use) bound to the
 *      connector and the user, and returns the gateway's authorize link.
 *   2. GET /api/iop-auth/callback: the gateway's redirect. Only checks that
 *      the state is one we issued for this provider and forwards the code to
 *      the dashboard, like the OAuth callback does.
 *   3. POST /api/iop-auth/complete (signed in): exchanges the code, but only
 *      for the user who started the attempt, in the connector's workspace,
 *      and stores the tokens.
 *
 * The same on Cloud and self-hosted: the callback is SERVER_URL +
 * /api/iop-auth/callback, which the seller registers on the app.
 */
@ApiTags('IOP seller authorization')
@Controller('api/iop-auth')
export class IopAuthController {
  private readonly logger = new Logger(IopAuthController.name);
  private readonly encryptionKey: string;

  constructor(
    private readonly connectorsService: ConnectorsService,
    private readonly oauthFlows: McpOAuthService,
    private readonly iopTokens: IopTokenService,
    private readonly mcpServer: McpServerService,
    private readonly configService: ConfigService,
  ) {
    this.encryptionKey = getRequiredSecret('ENCRYPTION_KEY', this.configService.get<string>('ENCRYPTION_KEY'));
  }

  private serverUrl(): string {
    return (this.configService.get<string>('SERVER_URL') || 'http://localhost:4000').replace(/\/+$/, '');
  }

  /** The callback URL to set on the seller's app at the gateway. */
  private redirectUrl(): string {
    return `${this.serverUrl()}${IOP_CALLBACK_PATH}`;
  }

  private completePage(params: Record<string, string>): string {
    const base = (this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000').replace(/\/+$/, '');
    return `${base}/connectors/oauth/complete?${new URLSearchParams(params).toString()}`;
  }

  /** The connector's gateway settings, resolved from its variables. */
  private iopApp(connector: { authType: string; authConfig: string | null; envVars?: unknown }): {
    app?: IopApp;
    isIop: boolean;
  } {
    let authConfig: Record<string, unknown> = {};
    try {
      authConfig = connector.authConfig ? JSON.parse(decrypt(connector.authConfig, this.encryptionKey)) : {};
    } catch {
      authConfig = {};
    }
    if (!isIopAuth(connector.authType, authConfig)) return { isIop: false };
    const envVars = (connector.envVars as Record<string, string> | null) ?? {};
    return { isIop: true, app: iopAppFrom(interpolateDeep(authConfig, envVars)) };
  }

  @Get('redirect-uri')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'The callback URL to register on a Lazada, Miravia or AliExpress seller app',
    description: 'Computed from SERVER_URL: `<SERVER_URL>/api/iop-auth/callback`. Dashboard session only.',
  })
  redirectUri(): { redirectUri: string } {
    return { redirectUri: this.redirectUrl() };
  }

  @Post('connectors/:id/authorize')
  @UseGuards(AuthGuard('jwt'))
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Start the seller authorization of a Lazada, Miravia or AliExpress seller connector',
    description:
      "Returns the gateway's authorize URL, where the seller signs in and approves the app, and `redirectUrl`, the " +
      "callback URL that must be set on the seller's app. The gateway then sends the browser back to this server. " +
      "Without the app key and secret on the connector, or for a connector that does not use the IOP token " +
      'provider, the answer is `{ "error": "…" }`. Dashboard session only; the connector owner or an admin, never a VIEWER.',
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
    const { app, isIop } = this.iopApp(connector);
    if (!isIop) return { error: 'This connector does not authorize a seller at Lazada, Miravia or AliExpress.' };
    if (!app) {
      return {
        error:
          "Set the app key and the app secret in this connector's environment variables first (the App Console of " +
          'the marketplace, your app), then authorize again.',
      };
    }
    const state = this.oauthFlows.generateState();
    await this.oauthFlows.storePendingFlow(
      state,
      {
        provider: IOP_PROVIDER,
        connectorId: connector.id,
        userId: req.user.sub,
        redirectUri: this.redirectUrl(),
        clientId: app.appKey,
        tokenUrl: `${app.tokenBaseUrl}${app.tokenPath}`,
        createdAt: Date.now(),
      },
      { returnTo: body?.returnTo },
    );
    return {
      authorizationUrl: buildIopAuthorizationUrl(app, this.redirectUrl(), state),
      redirectUrl: this.redirectUrl(),
    };
  }

  @Get('callback')
  // Unauthenticated: keep it tight.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: "The IOP gateway's redirect after a seller authorization; forwards to the dashboard" })
  async callback(
    @Query('state') rawState: unknown,
    @Query('code') rawCode: unknown,
    @Res() res: Response,
  ) {
    const state = typeof rawState === 'string' ? rawState : '';
    const code = typeof rawCode === 'string' && rawCode.trim() ? rawCode.trim() : undefined;
    const record = state ? await this.oauthFlows.getPendingFlow(state) : undefined;
    if (!record || record.flow.provider !== IOP_PROVIDER) {
      return res.redirect(this.completePage({ error: IOP_EXPIRED_MESSAGE }));
    }
    const connectorId = record.flow.connectorId;
    if (!code) {
      await this.oauthFlows.deletePendingFlow(state);
      return res.redirect(
        this.completePage({
          error:
            'The marketplace came back without an authorization code. The authorization was cancelled or refused; ' +
            'start it again from the connector.',
          connectorId,
        }),
      );
    }
    return res.redirect(this.completePage({ provider: IOP_PROVIDER, state, code }));
  }

  // Called by the dashboard's completion page; not an API to drive by hand.
  @Post('complete')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(200)
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Complete an IOP seller authorization (dashboard, signed in)' })
  async complete(
    @Req() req: any,
    @Body() body: { state?: string; code?: string },
  ): Promise<{ connectorId: string; toolsImported: number; returnTo?: string }> {
    const state = String(body?.state || '');
    // Check who started the flow before consuming it: another signed-in user
    // holding the state must not be able to burn the owner's authorization.
    const pending = await this.oauthFlows.getPendingFlow(state);
    if (!pending || pending.flow.provider !== IOP_PROVIDER) throw new GoneException(IOP_EXPIRED_MESSAGE);
    if (pending.flow.userId !== req.user?.sub) {
      this.logger.warn(`Refused IOP completion: connector ${pending.flow.connectorId} was authorized by another user`);
      throw new ForbiddenException(
        'This authorization was started by another account. Sign in as that account, or start it again yourself.',
      );
    }
    // Single use: a second request racing this one finds nothing to take.
    const record = await this.oauthFlows.takePendingFlow(state);
    if (!record || record.flow.provider !== IOP_PROVIDER || record.flow.userId !== req.user?.sub) {
      throw new GoneException(IOP_EXPIRED_MESSAGE);
    }
    const { flow, returnTo } = record;
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    if (!code) throw new GoneException('The marketplace came back without a code. Start the authorization again.');
    const connector = await this.connectorsService.findByIdInternal(flow.connectorId);
    // The connector must still be in the workspace of the user completing it.
    if (connector.organizationId !== req.user?.organizationId) {
      this.logger.warn(`Refused IOP completion: connector ${flow.connectorId} is not in the user's workspace`);
      throw new ForbiddenException('Resource not found');
    }
    const { app } = this.iopApp(connector as never);
    if (!app) {
      throw new BadRequestException({
        message: 'The connector has no app key and secret any more. Set them and authorize again.',
        connectorId: flow.connectorId,
      });
    }
    try {
      await this.iopTokens.exchangeCode({ connectorId: flow.connectorId, app, code });
    } catch (err) {
      const said = describeIopError(err);
      const status = iopError(err)?.status;
      this.logger.warn(`IOP code exchange failed for connector ${flow.connectorId}: ${said}`);
      const unavailable = typeof status === 'number' && status >= 500;
      const message = unavailable
        ? `The marketplace could not complete the authorization (${said}). Try again in a few minutes.`
        : `The marketplace refused the authorization (${said}). Check that the app key and the app secret belong to ` +
          `the app you authorized, that its callback URL is ${this.redirectUrl()}, and authorize again: a code works ` +
          'once and only for 30 minutes.';
      const payload = { message, connectorId: flow.connectorId };
      throw unavailable ? new BadGatewayException(payload) : new BadRequestException(payload);
    }
    try {
      await this.mcpServer.reloadConnectorTools(flow.connectorId);
    } catch (err: any) {
      this.logger.warn(`Failed to reload tools after the IOP authorization of ${flow.connectorId}: ${err?.message}`);
    }
    return { connectorId: flow.connectorId, toolsImported: 0, ...(returnTo ? { returnTo } : {}) };
  }
}
