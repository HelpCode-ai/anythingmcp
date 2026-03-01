import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { PrismaOAuthStore } from './prisma-oauth.store';

/**
 * Middleware that intercepts POST /token requests with grant_type=client_credentials.
 *
 * The @rekog/mcp-nest McpAuthModule only handles authorization_code and refresh_token
 * grant types. This middleware adds support for client_credentials (machine-to-machine)
 * by validating the client_id + client_secret and issuing a JWT access token directly.
 *
 * It must be applied BEFORE the McpAuthModule's controller handles the /token route.
 */
@Injectable()
export class ClientCredentialsMiddleware implements NestMiddleware {
  private readonly logger = new Logger(ClientCredentialsMiddleware.name);

  constructor(private readonly store: PrismaOAuthStore) {}

  async use(req: Request, res: Response, next: NextFunction) {
    // Only intercept POST requests to /token
    if (req.method !== 'POST') {
      return next();
    }

    // Parse body (handle both JSON and form-urlencoded)
    const body = this.parseBody(req);
    if (body.grant_type !== 'client_credentials') {
      return next();
    }

    this.logger.debug('Client credentials grant request received');

    try {
      // Extract client credentials
      const credentials = this.extractCredentials(req, body);
      if (!credentials) {
        return res.status(400).json({
          error: 'invalid_request',
          error_description: 'Missing client credentials',
        });
      }

      // Validate client
      const client = await this.store.getClient(credentials.client_id);
      if (!client) {
        return res.status(401).json({
          error: 'invalid_client',
          error_description: 'Unknown client',
        });
      }

      // Check that client supports client_credentials grant
      if (!client.grant_types.includes('client_credentials')) {
        return res.status(400).json({
          error: 'unauthorized_client',
          error_description:
            'Client is not authorized for client_credentials grant',
        });
      }

      // Validate client secret
      if (!client.client_secret || client.client_secret !== credentials.client_secret) {
        return res.status(401).json({
          error: 'invalid_client',
          error_description: 'Invalid client credentials',
        });
      }

      // We need JwtTokenService to generate tokens but it's managed by McpAuthModule.
      // Instead of directly depending on it, we'll let the request continue to the
      // McpAuthModule's token endpoint but with the grant_type changed to a passthrough.
      //
      // Actually, since we can't easily access JwtTokenService here, we'll use a simpler
      // approach: generate a basic JWT ourselves using jsonwebtoken.
      const jwt = await import('jsonwebtoken');
      const jwtSecret = process.env.JWT_SECRET;

      if (!jwtSecret) {
        return res.status(500).json({
          error: 'server_error',
          error_description: 'JWT_SECRET not configured',
        });
      }

      const scope = body.scope || '';
      const resource = process.env.SERVER_URL
        ? `${process.env.SERVER_URL}/mcp`
        : 'http://localhost:4000/mcp';

      const expiresIn = 86400; // 24 hours
      const accessToken = jwt.default.sign(
        {
          sub: `client:${credentials.client_id}`,
          azp: credentials.client_id,
          scope,
          resource,
          type: 'access',
        },
        jwtSecret,
        { expiresIn },
      );

      this.logger.log(
        `Client credentials token issued for client: ${credentials.client_id}`,
      );

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Pragma', 'no-cache');
      return res.status(200).json({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: expiresIn,
        scope,
      });
    } catch (err: any) {
      this.logger.error(`Client credentials error: ${err.message}`);
      return res.status(500).json({
        error: 'server_error',
        error_description: err.message,
      });
    }
  }

  private parseBody(req: Request): Record<string, any> {
    if (req.body && typeof req.body === 'object') {
      return req.body;
    }
    if (typeof req.body === 'string') {
      const params = new URLSearchParams(req.body);
      const result: Record<string, string> = {};
      for (const [key, value] of params.entries()) {
        result[key] = value;
      }
      return result;
    }
    return {};
  }

  private extractCredentials(
    req: Request,
    body: Record<string, any>,
  ): { client_id: string; client_secret: string } | null {
    // Try Basic auth header
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Basic ')) {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString(
        'utf-8',
      );
      const [client_id, client_secret] = decoded.split(':', 2);
      if (client_id && client_secret) {
        return { client_id, client_secret };
      }
    }

    // Try body params
    if (body.client_id && body.client_secret) {
      return {
        client_id: body.client_id,
        client_secret: body.client_secret,
      };
    }

    return null;
  }
}
