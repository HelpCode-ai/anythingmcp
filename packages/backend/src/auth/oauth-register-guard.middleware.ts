import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { validateRedirectUris } from './redirect-uri.util';

/** Largest registration body accepted, in bytes. Real clients send well under 2 KB. */
export const REGISTER_MAX_BODY_BYTES = 16 * 1024;

/**
 * Field caps for a registration. Strings: maximum length. Arrays: maximum
 * entries and the maximum length of each entry. A field that is present must
 * have the listed type. `tos_uri`, `policy_uri` and `contacts` are not stored,
 * but are checked like the rest so the whole body stays small and well formed.
 */
const STRING_FIELDS: Record<string, number> = {
  client_name: 200,
  client_description: 2048,
  client_uri: 2048,
  logo_uri: 2048,
  tos_uri: 2048,
  policy_uri: 2048,
  developer_name: 200,
  developer_email: 320,
};
const ARRAY_FIELDS: Record<string, { maxItems: number; maxLength: number }> = {
  redirect_uris: { maxItems: 10, maxLength: 2048 },
  contacts: { maxItems: 5, maxLength: 320 },
  grant_types: { maxItems: 10, maxLength: 100 },
  response_types: { maxItems: 10, maxLength: 100 },
};

/**
 * The first field of a registration body that breaks the caps above, as a
 * sentence for `error_description`, or null when every field fits.
 */
export function registrationFieldProblem(body: Record<string, unknown>): string | null {
  for (const [field, max] of Object.entries(STRING_FIELDS)) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') return `${field} must be a string.`;
    if (value.length > max) return `${field} must be at most ${max} characters.`;
  }
  for (const [field, cap] of Object.entries(ARRAY_FIELDS)) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) return `${field} must be an array of strings.`;
    if (value.length > cap.maxItems) return `${field} must have at most ${cap.maxItems} entries.`;
    for (const entry of value) {
      if (typeof entry !== 'string') return `${field} must be an array of strings.`;
      if (entry.length > cap.maxLength) return `each ${field} entry must be at most ${cap.maxLength} characters.`;
    }
  }
  return null;
}

/** Size of the request body in bytes: Content-Length when sent, else the parsed body re-encoded. */
function bodyBytes(req: Request, body: unknown): number {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > 0) return declared;
  try {
    return Buffer.byteLength(JSON.stringify(body) ?? '', 'utf8');
  } catch {
    return Infinity;
  }
}

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

    // The global JSON parser allows 10 MB for other routes; a registration
    // is a few hundred bytes.
    if (bodyBytes(req, body) > REGISTER_MAX_BODY_BYTES) {
      res
        .status(413)
        .header('Content-Type', 'application/json')
        .json({
          error: 'invalid_client_metadata',
          error_description: `The registration body must be at most ${REGISTER_MAX_BODY_BYTES} bytes.`,
        });
      return;
    }
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

    const fieldProblem = registrationFieldProblem(body as Record<string, unknown>);
    if (fieldProblem) {
      res
        .status(400)
        .header('Content-Type', 'application/json')
        .json({ error: 'invalid_client_metadata', error_description: fieldProblem });
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
