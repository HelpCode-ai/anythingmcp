import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { validateRedirectUris } from './redirect-uri.util';

/**
 * Guards the POST /register OAuth Dynamic Client Registration endpoint
 * exposed by @rekog/mcp-nest.
 *
 * In production we observed 17 crashes there with stack
 *
 *   TypeError: Cannot read properties of undefined (reading 'redirect_uris')
 *     at ClientService.registerClient (@rekog/mcp-nest)
 *
 * Two distinct callers trigger this:
 *
 *  - Browsers that navigate to /register expecting a sign-up page. Next.js
 *    has no such page and fires a Server Action POST with content-type
 *    multipart/form-data; that body is parsed as `undefined` by the JSON
 *    middleware and the OAuth controller dereferences `body.redirect_uris`.
 *
 *  - OAuth clients that POST a syntactically broken JSON body (e.g. empty
 *    body, plain text, multipart). RFC 7591 says the request MUST be
 *    application/json — this middleware enforces that and returns 400 with
 *    the error code the spec mandates, instead of the upstream 500.
 *
 * Letting this middleware run before the controller turns the 500 into a
 * deterministic 400 with a stable JSON body (RFC 7591 § 3.2.2 error
 * responses), so `/.well-known` discovery and Sentry stop catching noise.
 */
@Injectable()
export class OAuthRegisterGuardMiddleware implements NestMiddleware {
  private readonly logger = new Logger(OAuthRegisterGuardMiddleware.name);

  use(req: Request, res: Response, next: NextFunction): void {
    if (req.method !== 'POST') {
      return next();
    }

    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    const isJson = contentType.includes('application/json');
    const body = (req as Request & { body?: unknown }).body;
    const isObject =
      body !== null &&
      typeof body === 'object' &&
      !Array.isArray(body);

    if (!isJson || !isObject) {
      this.logger.debug(
        `Rejecting /register: content-type=${contentType || '<none>'} bodyType=${typeof body}`,
      );
      res
        .status(400)
        .header('Content-Type', 'application/json')
        .json({
          error: 'invalid_client_metadata',
          error_description:
            'Dynamic Client Registration requires a JSON body (RFC 7591). ' +
            'Set Content-Type: application/json and POST a JSON object including redirect_uris.',
        });
      return;
    }

    const redirectUris = (body as Record<string, unknown>).redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      res
        .status(400)
        .header('Content-Type', 'application/json')
        .json({
          error: 'invalid_redirect_uri',
          error_description:
            'redirect_uris is required and must be a non-empty array of strings.',
        });
      return;
    }

    // Content validation, not just shape. Registration here is open, so this
    // cannot stop an attacker registering their own host — the consent screen
    // is what does that. It does stop the cases where the URI itself is the
    // weapon: wildcards, path traversal, fragments, and cleartext http to a
    // non-loopback host. See redirect-uri.util.ts.
    const rejections = validateRedirectUris(redirectUris);
    if (rejections.length > 0) {
      this.logger.warn(
        `Rejecting /register: ${rejections
          .map((r) => `'${r.uri}' ${r.reason}`)
          .join('; ')}`,
      );
      res
        .status(400)
        .header('Content-Type', 'application/json')
        .json({
          error: 'invalid_redirect_uri',
          error_description: rejections
            .map((r) => `redirect_uri '${r.uri}': ${r.reason}`)
            .join('; '),
        });
      return;
    }

    // Deliberately NOT audit-logged here: /register is unauthenticated and
    // open, so writing a row per attempt would let anyone flood the security
    // audit table. The detection value for the phishing class lives on the
    // consent decision, which is behind a login.
    next();
  }
}
