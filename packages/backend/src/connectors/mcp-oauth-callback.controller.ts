import { Controller, Get, Query, Res, Logger } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { McpOAuthService } from './mcp-oauth.service';
import { ConnectorsService } from './connectors.service';
import { McpClientEngine } from './engines/mcp-client.engine';
import { PrismaService } from '../common/prisma.service';
import { McpServerService } from '../mcp-server/mcp-server.service';

/**
 * Separate controller for the OAuth2 callback — no JWT guard.
 * The remote MCP server redirects the user's browser here after login.
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
  ) {}

  @Get('callback')
  @ApiOperation({
    summary: 'OAuth2 callback handler for MCP connector authorization',
    description:
      'Handles the redirect from a remote MCP server after user authorization. ' +
      'Exchanges the auth code for tokens and auto-discovers MCP tools.',
  })
  async oauthCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const frontendUrl =
      this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000';

    if (!code || !state) {
      return res.redirect(
        `${frontendUrl}/connectors?error=${encodeURIComponent('Missing code or state in OAuth callback')}`,
      );
    }

    const flow = this.mcpOAuthService.getPendingFlow(state);
    if (!flow) {
      this.logger.warn(`OAuth callback with unknown state: ${state}`);
      return res.redirect(
        `${frontendUrl}/connectors?error=${encodeURIComponent('OAuth session expired or invalid state')}`,
      );
    }

    try {
      // 1. Exchange auth code for tokens
      const tokens = await this.mcpOAuthService.exchangeCodeForTokens({
        tokenUrl: flow.tokenUrl,
        code,
        redirectUri: flow.redirectUri,
        clientId: flow.clientId,
        clientSecret: flow.clientSecret,
        codeVerifier: flow.codeVerifier,
      });

      this.logger.log(
        `OAuth tokens obtained for connector ${flow.connectorId}`,
      );

      // 2. Store tokens (encrypted) in the connector's authConfig
      await this.connectorsService.update(
        flow.connectorId,
        {
          authConfig: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            tokenUrl: flow.tokenUrl,
            clientId: flow.clientId,
            clientSecret: flow.clientSecret,
            expiresIn: tokens.expiresIn,
            authorizedAt: new Date().toISOString(),
          },
        },
      );

      // 3. Auto-discover tools from the remote MCP server
      let toolsImported = 0;
      try {
        const connector = await this.connectorsService.findByIdInternal(
          flow.connectorId,
        );

        const remoteTools = await this.mcpClientEngine.listTools({
          baseUrl: connector.baseUrl,
          authType: 'OAUTH2',
          authConfig: {
            accessToken: tokens.accessToken,
          },
          headers: connector.headers as Record<string, string>,
        });

        for (const rt of remoteTools) {
          try {
            await this.prisma.mcpTool.create({
              data: {
                connectorId: flow.connectorId,
                name: rt.name,
                description: rt.description || `MCP tool: ${rt.name}`,
                parameters: rt.inputSchema as any,
                endpointMapping: {
                  method: rt.name,
                  path: '/mcp',
                } as any,
              },
            });
            toolsImported++;
          } catch (err: any) {
            // Skip duplicates
            if (err.code !== 'P2002') {
              this.logger.warn(
                `Failed to import tool ${rt.name}: ${err.message}`,
              );
            }
          }
        }

        await this.mcpServer.reloadConnectorTools(flow.connectorId);

        this.logger.log(
          `Auto-discovered ${toolsImported} tools for connector ${flow.connectorId}`,
        );
      } catch (discoverErr: any) {
        this.logger.warn(
          `Tool discovery failed after OAuth (will proceed anyway): ${discoverErr.message}`,
        );
      }

      // 4. Clean up
      this.mcpOAuthService.deletePendingFlow(state);

      // 5. Redirect to frontend
      return res.redirect(
        `${frontendUrl}/connectors/${flow.connectorId}?oauth=success&tools=${toolsImported}`,
      );
    } catch (error: any) {
      this.logger.error(
        `OAuth callback failed for connector ${flow.connectorId}: ${error.message}`,
      );
      this.mcpOAuthService.deletePendingFlow(state);
      return res.redirect(
        `${frontendUrl}/connectors/${flow.connectorId}?oauth=error&message=${encodeURIComponent(error.message)}`,
      );
    }
  }
}
