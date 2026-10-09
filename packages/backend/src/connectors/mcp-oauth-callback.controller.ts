import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  GoneException,
  HttpCode,
  HttpException,
  Logger,
  Optional,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { McpOAuthService, PendingOAuthFlow, TokenExchangeError } from './mcp-oauth.service';
import { ConnectorsService } from './connectors.service';
import { McpClientEngine } from './engines/mcp-client.engine';
import { PrismaService } from '../common/prisma.service';
import { McpServerService } from '../mcp-server/mcp-server.service';
import { ProductEventService, ProductEvents, scrubProviderMessage } from '../audit/product-event.service';
import type { DiscoveredMcpTool } from './connectors.service';
import { DYNAMIC_CLIENT_KEY } from './mcp-oauth-settings';
import { mcpPathOf } from './mcp-connector-config.util';
import { catalogMcpToolsFor } from '../adapters/mcp-adapter.util';
import { interpolateDeep, interpolateString } from '../common/env-interpolation.util';

/**
 * Connector OAuth: where the provider sends the browser back, and where the
 * dashboard completes the authorization.
 *
 * The two steps are split on purpose. The provider's redirect carries no
 * proof of who is at the keyboard, so the callback only checks that the state
 * is one we issued and forwards code + state to the dashboard. The dashboard
 * then posts them in an authenticated request, and the code is exchanged only
 * if that user is the one who started the flow. Exchanging in the callback,
 * as before, let anyone who started an authorization on their own connector
 * send the consent link to someone else and receive that person's tokens.
 */
@ApiTags('MCP OAuth')
@Controller('api/mcp-oauth')
export class McpOAuthCallbackController {
  private readonly logger = new Logger(McpOAuthCallbackController.name);

  constructor(
    private readonly mcpOAuthService: McpOAuthService,
    private readonly connectorsService: ConnectorsService,
    private readonly mcpClientEngine: McpClientEngine,
    private readonly prisma: PrismaService,
    private readonly mcpServer: McpServerService,
    private readonly configService: ConfigService,
    @Optional() private readonly productEvents?: ProductEventService,
  ) {}

  private frontendUrl(): string {
    return (
      this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000'
    ).replace(/\/+$/, '');
  }

  private completePage(params: Record<string, string>): string {
    return `${this.frontendUrl()}/connectors/oauth/complete?${new URLSearchParams(params).toString()}`;
  }

  @Get('callback')
  @ApiOperation({
    summary: 'OAuth2 redirect target for connector authorization',
    description:
      'Checks the state and forwards the code to the dashboard, which completes ' +
      'the authorization with POST /api/mcp-oauth/complete.',
  })
  async oauthCallback(
    @Query('code') rawCode: unknown,
    @Query('state') rawState: unknown,
    @Query('error') rawError: unknown,
    @Query('error_description') rawErrorDescription: unknown,
    @Res() res: Response,
  ) {
    // A repeated parameter (?state=a&state=b) arrives as an array: take
    // strings only, so nothing below is fed a value of the wrong type.
    const code = singleQueryValue(rawCode);
    const state = singleQueryValue(rawState);
    const providerError = singleQueryValue(rawError);
    const providerErrorDescription = singleQueryValue(rawErrorDescription);
    if (providerError) {
      // The user declined, or the provider refused the request. The attempt
      // is spent either way.
      const record = state ? await this.mcpOAuthService.takePendingFlow(state) : undefined;
      if (record) void this.recordFailure(record.flow, 'provider_refused', providerError.slice(0, 80));
      if (
        record?.flow.dynamicClient &&
        (providerError === 'invalid_client' || providerError === 'unauthorized_client')
      ) {
        await this.forgetDynamicClient(record.flow.connectorId);
      }
      return res.redirect(
        this.completePage({
          error: describeProviderError(providerError, providerErrorDescription),
          ...(record ? { connectorId: record.flow.connectorId } : {}),
        }),
      );
    }

    if (!code || !state) {
      return res.redirect(
        this.completePage({ error: 'The provider came back without an authorization code. Start the authorization again.' }),
      );
    }

    const record = await this.mcpOAuthService.getPendingFlow(state);
    if (!record) {
      this.logger.warn('OAuth callback with an unknown or expired state');
      return res.redirect(
        this.completePage({ error: 'This authorization expired or was already used. Start it again from the connector.' }),
      );
    }

    return res.redirect(this.completePage({ state, code }));
  }

  @Post('complete')
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(200)
  @ApiOperation({
    summary: 'Complete a connector authorization (dashboard, authenticated)',
    description:
      'Exchanges the authorization code, but only for the user who started the flow.',
  })
  async complete(
    @Req() req: any,
    @Body() body: { state?: string; code?: string },
  ): Promise<{ connectorId: string; toolsImported: number; returnTo?: string }> {
    const record = await this.mcpOAuthService.takePendingFlow(String(body?.state || ''));
    if (!record) {
      throw new GoneException('This authorization expired or was already used. Start it again from the connector.');
    }
    const { flow, returnTo } = record;
    if (flow.userId !== req.user?.sub) {
      // Consumed above on purpose: a link someone else started is dead now.
      this.logger.warn(
        `Refused OAuth completion: connector ${flow.connectorId} was authorized by another user`,
      );
      throw new ForbiddenException(
        'This authorization was started by another account. Sign in as that account, or start it again yourself.',
      );
    }
    if (!body?.code) {
      throw new GoneException('The provider came back without an authorization code. Start the authorization again.');
    }

    let toolsImported: number;
    try {
      toolsImported = await this.exchangeAndStore(flow, String(body.code));
    } catch (err: any) {
      void this.recordFailure(flow, 'token_exchange', err?.message, [flow.clientSecret, String(body.code)]);
      if (err instanceof TokenExchangeError) {
        throw refusedExchange(err, flow, [flow.clientSecret, String(body.code)], await this.connectorName(flow.connectorId));
      }
      throw err;
    }
    return { connectorId: flow.connectorId, toolsImported, ...(returnTo ? { returnTo } : {}) };
  }

  /**
   * A sign-in that did not complete, as a product event: which connector and
   * adapter, and why. Best-effort; never stands in the way of the redirect.
   */
  private async recordFailure(
    flow: PendingOAuthFlow,
    kind: 'provider_refused' | 'token_exchange',
    error: unknown,
    secrets: unknown[] = [],
  ): Promise<void> {
    if (!this.productEvents) return;
    try {
      const connector = await this.prisma.connector.findUnique({
        where: { id: flow.connectorId },
        select: { organizationId: true, config: true },
      });
      await this.productEvents.log({
        event: ProductEvents.OAUTH_FAILED,
        userId: flow.userId,
        organizationId: connector?.organizationId ?? null,
        metadata: {
          connectorId: flow.connectorId,
          kind,
          ...((connector?.config as { adapterSlug?: string } | null)?.adapterSlug
            ? { adapterSlug: (connector!.config as { adapterSlug: string }).adapterSlug }
            : {}),
          error: scrubProviderMessage(error, secrets),
        },
      });
    } catch (err: any) {
      this.logger.warn(`oauth_failed not recorded: ${err?.message ?? err}`);
    }
  }

  /** The connector's name for a message, or undefined if it cannot be read. */
  private async connectorName(connectorId: string): Promise<string | undefined> {
    try {
      const row = await this.prisma.connector.findUnique({
        where: { id: connectorId },
        select: { name: true },
      });
      return row?.name || undefined;
    } catch {
      return undefined;
    }
  }

  /** Exchange the code, store the tokens, reload the tools. Throws on failure. */
  private async exchangeAndStore(flow: PendingOAuthFlow, code: string): Promise<number> {
    // 1. Exchange auth code for tokens
    let tokens: Awaited<ReturnType<McpOAuthService['exchangeCodeForTokens']>>;
    try {
      tokens = await this.mcpOAuthService.exchangeCodeForTokens({
        tokenUrl: flow.tokenUrl,
        code,
        redirectUri: flow.redirectUri,
        clientId: flow.clientId,
        clientSecret: flow.clientSecret,
        codeVerifier: flow.codeVerifier,
        tokenAuthMethod: flow.tokenAuthMethod,
        clientAssertion: flow.clientAssertion,
        userAgent: flow.userAgent,
        resource: flow.resource,
      });
    } catch (err: any) {
      if (flow.dynamicClient && /invalid_client|unauthorized_client/i.test(String(err?.message))) {
        await this.forgetDynamicClient(flow.connectorId);
      }
      throw err;
    }

    this.logger.log(`OAuth tokens obtained for connector ${flow.connectorId}`);

    // 2. Store tokens (encrypted) in the connector's authConfig. Merge, don't
    // replace — preserves static config (authorizationUrl, scopes) needed for
    // later re-authorization.
    const clientSettings = flow.persistAuthConfig ?? {
      tokenUrl: flow.tokenUrl,
      clientId: flow.clientId,
      clientSecret: flow.clientSecret,
      tokenAuthMethod: flow.tokenAuthMethod,
      // The refreshes send the same RFC 8707 resource indicator (MCP).
      ...(flow.resource ? { resource: flow.resource } : {}),
    };
    await this.connectorsService.updateAuthConfigMerge(flow.connectorId, {
      ...clientSettings,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      expiresAt: Date.now() + (tokens.expiresIn || 3600) * 1000,
      authorizedAt: new Date().toISOString(),
    });

    // Reload the connector's tools into the in-memory MCP registry so the
    // freshly-stored access token takes effect immediately. The registry
    // caches a snapshot of authConfig (incl. the token) per tool, so without
    // this a just-authorized connector would keep serving with the stale
    // (token-less) snapshot. For REST/GraphQL OAuth connectors this is the
    // ONLY reload — the MCP auto-discovery block below throws for non-MCP
    // servers and never reaches its own reloadConnectorTools() call.
    try {
      await this.mcpServer.reloadConnectorTools(flow.connectorId);
    } catch (reloadErr: any) {
      this.logger.warn(
        `Failed to reload tools after OAuth for connector ${flow.connectorId}: ${reloadErr.message}`,
      );
    }

    // 3. Auto-discover tools from the remote MCP server (MCP connectors only)
    let toolsImported = 0;
    try {
      const connector = await this.connectorsService.findByIdInternal(flow.connectorId);

      // A REST or GraphQL connector already has its tools. Discovery used
      // to run for them too and relied on the host not speaking MCP; Google
      // does (searchconsole.googleapis.com), so authorising the Search
      // Console connector added three MCP tools mapped as REST calls.
      if (connector.type === 'MCP') {
        toolsImported = await this.importRemoteTools(
          flow.connectorId,
          connector,
          tokens.accessToken,
        );
      }
    } catch (discoverErr: any) {
      this.logger.warn(
        `Tool discovery failed after OAuth (will proceed anyway): ${discoverErr.message}`,
      );
    }
    return toolsImported;
  }

  /**
   * Drop a dynamically registered client the provider no longer accepts, so
   * the next "Authorize" registers a fresh one instead of reusing it.
   */
  private async forgetDynamicClient(connectorId: string): Promise<void> {
    try {
      await this.connectorsService.updateAuthConfigMerge(connectorId, {
        [DYNAMIC_CLIENT_KEY]: undefined,
      });
    } catch (err: any) {
      this.logger.warn(`Could not drop the stored OAuth client of ${connectorId}: ${err.message}`);
    }
  }

  /**
   * Import the tools a remote MCP server lists.
   *
   * A connector installed from a catalog adapter goes through the same
   * policy as the install (mcp-adapter.util): tools the catalog switches off
   * arrive switched off, catalog annotations fill what the server leaves out,
   * and the adapter's tool prefix applies. Its catalog tools that are already
   * there (the snapshot installed before the authorization) take the server's
   * description and schema; whether they are switched on stays as it is.
   * Other existing tools are left alone, as before.
   */
  private async importRemoteTools(
    connectorId: string,
    connector: { baseUrl: string; headers: unknown; envVars?: unknown; config?: unknown },
    accessToken: string,
  ): Promise<number> {
    let toolsImported = 0;
    const envVars = (connector.envVars as Record<string, string> | null) ?? {};
    const mcpPath = mcpPathOf(connector.config);
    const remoteTools = await this.mcpClientEngine.listTools({
      baseUrl: interpolateString(connector.baseUrl, envVars),
      authType: 'OAUTH2',
      authConfig: {
        accessToken,
      },
      headers: interpolateDeep(connector.headers as Record<string, string>, envVars),
      mcpPath,
    });

    const discovered: DiscoveredMcpTool[] = remoteTools.map((rt) => ({
      name: rt.name,
      description: rt.description || `MCP tool: ${rt.name}`,
      parameters: (rt.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
      // Default path, not a user choice: resolveMcpEndpointUrl() treats it
      // as unset when the base URL has a path (#501).
      endpointMapping: { method: rt.name, path: mcpPath ?? '/mcp' },
      outputSchema: (rt.outputSchema as Record<string, unknown>) ?? null,
      // The upstream server is authoritative about its own tools.
      annotations: (rt.annotations as Record<string, unknown>) ?? null,
    }));
    const tools = catalogMcpToolsFor(connector.config, discovered);

    const existing =
      (await this.prisma.mcpTool.findMany({
        where: { connectorId },
        select: { id: true, name: true, origin: true, endpointMapping: true },
      })) ?? [];
    const byName = new Map(existing.map((t) => [t.name, t]));
    const byMethod = new Map(
      existing.map((t) => [String((t.endpointMapping as { method?: unknown } | null)?.method ?? ''), t]),
    );

    for (const tool of tools) {
      const method = String(tool.endpointMapping.method);
      const match = byName.get(tool.name) ?? byMethod.get(method);
      if (match) {
        if (tool.origin === 'catalog' && match.origin === 'catalog') {
          await this.prisma.mcpTool.update({
            where: { id: match.id },
            data: {
              description: tool.description,
              parameters: tool.parameters as any,
              endpointMapping: tool.endpointMapping as any,
              ...(tool.outputSchema ? { outputSchema: tool.outputSchema as any } : {}),
            },
          });
        }
        continue;
      }
      try {
        await this.prisma.mcpTool.create({
          data: {
            connectorId,
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters as any,
            endpointMapping: tool.endpointMapping as any,
            outputSchema: (tool.outputSchema ?? null) as any,
            annotations: (tool.annotations ?? null) as any,
            isEnabled: tool.enabled !== false,
            ...(tool.origin ? { origin: tool.origin } : {}),
          },
        });
        toolsImported++;
      } catch (err: any) {
        // Skip duplicates
        if (err.code !== 'P2002') {
          this.logger.warn(
            `Failed to import tool ${tool.name}: ${err.message}`,
          );
        }
      }
    }

    await this.mcpServer.reloadConnectorTools(connectorId);

    this.logger.log(
      `Auto-discovered ${toolsImported} tools for connector ${connectorId}`,
    );
    return toolsImported;
  }
}

function singleQueryValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * A code exchange the provider's token endpoint refused, as an answer the
 * dashboard shows: what the provider said and what to check. A 4xx (502 when
 * the provider itself failed), not a 500: a mistyped client secret is the
 * user's to fix, and the page needs the reason, not "Internal server error".
 */
function refusedExchange(
  err: TokenExchangeError,
  flow: PendingOAuthFlow,
  secrets: unknown[],
  connectorName?: string,
): HttpException {
  const said = scrubProviderMessage(err.message.replace(/^Token exchange failed:\s*/, ''), secrets);
  const detail = said ? ` (${said})` : '';
  let message: string;
  if (err.status >= 500) {
    message = `The provider could not complete the sign-in${detail}. Try again in a few minutes.`;
  } else if (err.providerError === 'invalid_client' || err.providerError === 'unauthorized_client') {
    const where = connectorName ? `the connector "${connectorName.slice(0, 80)}"` : 'this connector';
    message =
      `The client ID or client secret saved in ${where} is wrong or expired: the provider refused it${detail}. ` +
      "Check the credentials in the OAuth settings of your app in the provider's developer console, " +
      "copy both again into the connector's settings, then authorize again.";
  } else if (err.providerError === 'invalid_grant') {
    message =
      `The provider refused the authorization code${detail}. Start the authorization again; ` +
      `if it keeps failing, check that the app's redirect URI is exactly ${flow.redirectUri}.`;
  } else {
    message = `The provider refused the sign-in${detail}. Check the connector's OAuth settings and authorize again.`;
  }
  const body = { message, connectorId: flow.connectorId };
  return err.status >= 500 ? new BadGatewayException(body) : new BadRequestException(body);
}

/** The provider's refusal in words a user can act on. */
function describeProviderError(code: string, description?: string): string {
  const detail = description ? ` (${description.slice(0, 200)})` : '';
  if (code === 'access_denied') {
    return `The authorization was cancelled at the provider${detail}. Nothing was changed; start it again when you are ready.`;
  }
  if (code === 'invalid_scope') {
    return `The provider refused the requested permissions${detail}. Check the scopes in the connector's OAuth settings.`;
  }
  if (code === 'unauthorized_client' || code === 'invalid_client') {
    return `The provider does not accept this app${detail}. Check the client ID and that the redirect URI shown in AnythingMCP is registered in the app.`;
  }
  return `The provider returned an error: ${code.slice(0, 80)}${detail}.`;
}
