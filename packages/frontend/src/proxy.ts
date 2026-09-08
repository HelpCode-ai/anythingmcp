import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const PUBLIC_PATHS = ['/login', '/register', '/forgot-password', '/reset-password', '/accept-invite', '/verify-email'];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths, static assets, and backend-proxied routes
  if (
    PUBLIC_PATHS.some((p) => pathname.startsWith(p)) ||
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api') ||
    pathname.startsWith('/health') ||
    pathname.startsWith('/mcp') ||
    // Sign-in entry point and OIDC callback. Both are rewritten to the backend
    // in next.config, but this gate runs on the INCOMING pathname, before the
    // rewrite — without these an unauthenticated sign-in would be bounced to
    // /login, which is the page the user is trying to reach through.
    pathname.startsWith('/sso') ||
    pathname.startsWith('/auth') ||
    pathname.startsWith('/.well-known') ||
    pathname === '/authorize' ||
    pathname === '/token' ||
    pathname.includes('.')
  ) {
    return NextResponse.next();
  }

  // Check for auth token in cookie (set by auth-context on login)
  const token = request.cookies.get('amcp_token')?.value;

  if (!token) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
