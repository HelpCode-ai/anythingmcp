import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { parseOAuthBody } from './oauth-body.util';

/**
 * Token request parameters that OAuth defines as single string values
 * (RFC 6749 §3.2, §4.1.3, §6; RFC 7636 §4.5; RFC 8707 §2).
 */
export const TOKEN_STRING_PARAMS = [
  'grant_type',
  'refresh_token',
  'client_id',
  'client_secret',
  'code',
  'code_verifier',
  'redirect_uri',
  'resource',
  'scope',
] as const;

/**
 * Refuses a POST /token request whose OAuth parameters are not plain strings,
 * with `400 invalid_request` (RFC 6749 §5.2).
 *
 * `main.ts` parses JSON and extended form-urlencoded bodies, so a parameter can
 * arrive as an array (`{"refresh_token":["…"]}`, `refresh_token[]=…`, or the
 * same key repeated) or as an object (`refresh_token[a]=…`). The middlewares
 * that follow on this route only act on string values and leave anything else
 * to the upstream @rekog/mcp-nest-auth controller, which coerces values with
 * `String(…)`. Checking the shape once, here, keeps every step of the chain
 * reading the same value.
 *
 * Registered first on the /token route (app.module.ts). A missing parameter is
 * not this middleware's concern: it passes through and the later steps report
 * it as before. Never reads the raw request stream (see `parseOAuthBody`).
 */
@Injectable()
export class TokenRequestShapeMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    if (req.method !== 'POST') return next();

    const body = parseOAuthBody(req);
    const invalid = TOKEN_STRING_PARAMS.find(
      (name) =>
        Object.prototype.hasOwnProperty.call(body, name) &&
        body[name] !== undefined &&
        typeof body[name] !== 'string',
    );
    if (!invalid) return next();

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    return res.status(400).json({
      error: 'invalid_request',
      error_description: `The ${invalid} parameter must be a single string value.`,
    });
  }
}
