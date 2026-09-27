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
    // OIDC UserInfo: called by relying parties with a bearer token, never by
    // a browser session. Sending it to /login broke ChatGPT's identity check.
    pathname === '/userinfo' ||
    // Licence activation after checkout. The key arrives in the fragment,
    // which this gate never sees: redirecting here sent the browser to /login
    // with the key stranded in the address bar, and `redirect` carries only the
    // pathname, so the key was lost at sign-in (it was lost the same way when
    // it came as `?key=`). The page does its own sign-in redirect after putting
    // the key in sessionStorage, and it holds no data — the API it calls is
    // authenticated.
    pathname === '/settings/license/activate' ||
    // Sentry tunnel (tunnelRoute in next.config.ts). Errors on /login and
    // /register come from signed-out visitors; redirecting them to /login
    // would drop exactly those reports.
    pathname === '/monitoring' ||
    // 404 unless SENTRY_VERIFY_TOKEN is set; see app/sentry-verify.
    pathname === '/sentry-verify' ||
    pathname.includes('.')
  ) {
    return NextResponse.next();
  }

  // Check for auth token in cookie (set by auth-context on login)
  const token = request.cookies.get('amcp_token')?.value;

  if (!token) {
    const loginUrl = new URL('/login', request.url);
    // Keep the query string: install links such as
    // /connectors/store?install=weclapp are shared publicly and opened by
    // signed-out visitors, who would otherwise land on a bare store page.
    loginUrl.searchParams.set('redirect', pathname + request.nextUrl.search);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
