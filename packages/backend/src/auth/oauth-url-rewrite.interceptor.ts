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

    // If the external URL matches the internal URL, no rewrite needed
    if (externalUrl === internalUrl) {
      return next.handle();
    }

    return next.handle().pipe(
      map((data) => {
        if (!data || typeof data !== 'object') return data;
        return JSON.parse(
          JSON.stringify(data).replaceAll(internalUrl, externalUrl),
        );
      }),
    );
  }
}
