import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Request } from 'express';

/**
 * Intercepts responses from OAuth well-known endpoints and rewrites
 * the internal SERVER_URL to match the actual request origin.
 *
 * This ensures that when the server is behind a reverse proxy or tunnel
 * (e.g. ngrok), the OAuth metadata contains externally reachable URLs.
 */
@Injectable()
export class OAuthUrlRewriteInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest<Request>();
    const path = request.path;

    // Only apply to well-known OAuth endpoints
    if (!path.startsWith('/.well-known/oauth')) {
      return next.handle();
    }

    const internalUrl =
      process.env.SERVER_URL || `http://localhost:${process.env.PORT || 4000}`;

    // Determine the external URL from the request
    const proto =
      (request.headers['x-forwarded-proto'] as string) ||
      (request.secure ? 'https' : 'http');
    const host =
      (request.headers['x-forwarded-host'] as string) || request.headers.host;

    if (!host) {
      return next.handle();
    }

    const externalUrl = `${proto}://${host}`;

    return next.handle().pipe(
      map((data) => {
        if (!data || typeof data !== 'object') return data;
        const rewritten =
          externalUrl === internalUrl
            ? data
            : JSON.parse(
                JSON.stringify(data).replaceAll(internalUrl, externalUrl),
              );
        return alignAuthorizationMetadata(rewritten, path);
      }),
    );
  }
}

/**
 * Brings the ROOT discovery documents — which @rekog/mcp-nest builds itself —
 * in line with what this server actually does.
 *
 * WellKnownOAuthController only owns the per-server variants
 * (`/.well-known/oauth-authorization-server/mcp/:id` and friends). The root
 * documents come from upstream, and most clients discover those first. Without
 * this, the two disagree: the root one would still advertise `plain` PKCE that
 * AuthorizePkceMiddleware refuses, and `offline_access` that the MCP
 * 2026-07-28 spec says a resource should not list — so a client would follow
 * the advertised contract and get a 400.
 */
export function alignAuthorizationMetadata(data: any, path: string): any {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;

  const out = { ...data };

  if (Array.isArray(out.code_challenge_methods_supported)) {
    // We require S256; advertising `plain` would promise what we reject.
    out.code_challenge_methods_supported = ['S256'];
  }

  // Refresh tokens are a client concern, not a requirement of the resource.
  if (Array.isArray(out.scopes_supported)) {
    out.scopes_supported = out.scopes_supported.filter(
      (s: unknown) => s !== 'offline_access',
    );
  }

  // RFC 9207. Only claim this on an authorization-SERVER document, and only
  // because AuthorizationIssuerMiddleware really does append `iss`: a client
  // that reads this flag and then sees a response without `iss` MUST reject it.
  if (path.startsWith('/.well-known/oauth-authorization-server')) {
    out.authorization_response_iss_parameter_supported = true;
  }

  return out;
}
