import { Request } from 'express';

/**
 * Reads an OAuth token-endpoint request body, tolerating both JSON and
 * form-urlencoded clients.
 *
 * Shared by every middleware that pre-processes `POST /token`, so they agree on
 * what the request said. `main.ts` installs `json()` and `urlencoded()` app-wide
 * before Nest routing, so in practice `req.body` is already an object; the
 * string branch covers a body parser that handed back the raw payload.
 *
 * SECURITY / CORRECTNESS: this must never read the raw stream. The upstream
 * `@rekog/mcp-nest-auth` token controller has a `captureRawBody` fallback that
 * re-reads the request when the content type is form-urlencoded and `req.body`
 * is empty. A middleware that consumed the stream would leave that path waiting
 * on data that never arrives, hanging the token endpoint.
 */
export function parseOAuthBody(req: Request): Record<string, any> {
  if (req.body && typeof req.body === 'object') {
    return req.body as Record<string, any>;
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
