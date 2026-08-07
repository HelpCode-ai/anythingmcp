import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';

export interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  organizationId: string | null;
  mcpRoleId?: string | null;
  /** Marks a token minted for the dashboard API. See `isForeignIssuedToken`. */
  tokenUse?: typeof DASHBOARD_TOKEN_USE;
  /** Standard JWT issued-at (seconds). Set by the signer, read for revocation. */
  iat?: number;
  exp?: number;
}

/** `tokenUse` value stamped on every dashboard (app) token we issue. */
export const DASHBOARD_TOKEN_USE = 'dashboard';

/**
 * Claims that only ever appear on tokens minted by the MCP OAuth authorization
 * server (@rekog/mcp-nest `JwtTokenService`) or by `ClientCredentialsMiddleware`.
 *
 * SECURITY: those tokens are signed with the SAME `JWT_SECRET` as dashboard
 * tokens (app.module.ts passes it straight to McpAuthModule), so the signature
 * alone does not tell the two apart. Until this check existed, the only thing
 * stopping an MCP access token — obtainable by anyone, since Dynamic Client
 * Registration is open — from also authenticating against the whole dashboard
 * API was that the OAuth `sub` happens to be an email, so the `findUnique({ id })`
 * lookup missed. That is an accident, not a control, and it breaks the moment
 * `sub` is normalised to the user's cuid.
 *
 * Every mcp-nest code path sets `type` ('access' | 'refresh' | 'user'), and the
 * access/refresh payloads additionally carry `azp`/`client_id` and `resource`.
 * Dashboard tokens carry none of them, so this is a complete separation with no
 * backward-compatibility window.
 */
const FOREIGN_TOKEN_CLAIMS = [
  'type',
  'azp',
  'client_id',
  'resource',
  'user_data',
  'user_profile_id',
] as const;

/** True when the payload was minted by the MCP OAuth server, not by us. */
export function isForeignIssuedToken(
  payload: Record<string, unknown> | null | undefined,
): boolean {
  if (!payload) return true;
  return FOREIGN_TOKEN_CLAIMS.some((claim) => payload[claim] !== undefined);
}

/**
 * True when a token predates the user's revocation cutover and must be refused.
 *
 * Works on ANY JWT because it reads `iat`, which both our dashboard tokens and
 * the MCP tokens minted by @rekog/mcp-nest carry. That is why revocation is
 * modelled as a timestamp rather than an epoch counter: a counter would have to
 * be echoed back as a claim, and we do not control the MCP token payload.
 *
 * Compared at second granularity, since `iat` is in seconds. A token minted in
 * the same second as the revocation therefore survives — accepted deliberately,
 * because the stricter comparison would reject a legitimate token issued
 * moments after a password change.
 *
 * Fails CLOSED on a token with no `iat`: if we cannot date it, we cannot honour
 * a revocation against it.
 */
export function isTokenRevoked(
  payload: { iat?: number } | null | undefined,
  sessionsValidFrom: Date | null | undefined,
): boolean {
  if (!sessionsValidFrom) return false; // never revoked
  const iat = payload?.iat;
  if (typeof iat !== 'number') return true;
  return iat < Math.floor(sessionsValidFrom.getTime() / 1000);
}

@Injectable()
export class AuthService {
  constructor(private readonly jwtService: JwtService) {}

  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, 12);
  }

  async comparePassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  generateToken(payload: JwtPayload): string {
    // Stamp the positive marker so dashboard tokens are identifiable by what
    // they ARE, not only by what they lack. `JwtStrategy` will be able to
    // require it once every token issued before this change has expired (24h).
    return this.jwtService.sign({ ...payload, tokenUse: DASHBOARD_TOKEN_USE });
  }

  verifyToken(token: string): JwtPayload {
    try {
      return this.jwtService.verify<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }
}
