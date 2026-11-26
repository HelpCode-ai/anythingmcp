import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerRequest } from '@nestjs/throttler';

/** POST /register (OAuth dynamic client registration): requests per minute per address. */
export const REGISTER_LIMIT_PER_MINUTE = 20;

/**
 * The application's throttler guard: the stock `ThrottlerGuard` (one default
 * bucket, 100 a minute, `@Throttle()` per route) plus a stricter cap for
 * `POST /register`. That route is served by the @rekog/mcp-nest controller,
 * which this code cannot decorate with `@Throttle()`, so the cap is applied
 * here by path. The counter key and the client address are the stock ones
 * (`req.ip`, which follows the `TRUST_PROXY` setting in main.ts), exactly as
 * for every other route.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    const req = requestProps.context.switchToHttp().getRequest<{ method?: string; path?: string }>();
    if (isRegisterPost(req)) {
      return super.handleRequest({
        ...requestProps,
        limit: Math.min(requestProps.limit, REGISTER_LIMIT_PER_MINUTE),
        ttl: Math.max(requestProps.ttl, 60_000),
      });
    }
    return super.handleRequest(requestProps);
  }
}

export function isRegisterPost(req: { method?: string; path?: string } | undefined): boolean {
  if (!req || req.method !== 'POST' || typeof req.path !== 'string') return false;
  return req.path.replace(/\/+$/, '') === '/register';
}
