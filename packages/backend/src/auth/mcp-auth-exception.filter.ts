import {
  Catch,
  ExceptionFilter,
  ArgumentsHost,
  UnauthorizedException,
} from '@nestjs/common';
import { Request, Response } from 'express';

/**
 * Exception filter that intercepts UnauthorizedException on MCP routes
 * and adds the required WWW-Authenticate header for MCP OAuth discovery.
 *
 * The MCP spec (RFC 9728) requires the server to respond with:
 *   401 + WWW-Authenticate: Bearer resource_metadata="<url>"
 *
 * Without this header, MCP clients (e.g. Claude Desktop) cannot discover
 * the authorization server and fail with a generic connection error.
 *
 * This filter is needed because @rekog/mcp-nest's McpAuthJwtGuard throws
 * a plain UnauthorizedException without setting the header.
 */
@Catch(UnauthorizedException)
export class McpAuthExceptionFilter implements ExceptionFilter {
  catch(exception: UnauthorizedException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    if (response.headersSent) return;

    // Only modify behavior for MCP routes
    if (request.path === '/mcp' || request.path.startsWith('/mcp/')) {
      const proto =
        (request.headers['x-forwarded-proto'] as string) ||
        (request.secure ? 'https' : 'http');
      const host =
        (request.headers['x-forwarded-host'] as string) ||
        request.headers.host;
      const baseUrl = host
        ? `${proto}://${host}`
        : process.env.SERVER_URL || 'http://localhost:4000';

      const resourceMetadataUrl = `${baseUrl}/.well-known/oauth-protected-resource`;

      response.setHeader(
        'WWW-Authenticate',
        `Bearer resource_metadata="${resourceMetadataUrl}"`,
      );
      response.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Authentication required.' },
        id: null,
      });
    } else {
      // Default NestJS behavior for non-MCP routes
      const status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      response.status(status).json(exceptionResponse);
    }
  }
}
