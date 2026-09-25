import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs/config';

// Internal backend URL for rewrites — never use the public URL here to avoid loops
const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || 'http://localhost:4000';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Allow the Next dev server to be reached through a tunnel (ngrok/cloudflared)
  // from a different origin — otherwise dev assets/HMR misbehave and the page
  // doesn't fully hydrate (login form falls back to a native GET submit).
  allowedDevOrigins: [
    '*.ngrok-free.app',
    '*.ngrok.app',
    '*.trycloudflare.com',
    '49f6-213-164-76-122.ngrok-free.app',
  ],
  // Proxy backend routes so a single port (3000) can serve everything
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${BACKEND_URL}/api/:path*` },
      { source: '/health', destination: `${BACKEND_URL}/health` },
      { source: '/health/:path*', destination: `${BACKEND_URL}/health/:path*` },
      { source: '/mcp', destination: `${BACKEND_URL}/mcp` },
      { source: '/mcp/:path*', destination: `${BACKEND_URL}/mcp/:path*` },
      { source: '/.well-known/:path*', destination: `${BACKEND_URL}/.well-known/:path*` },
      { source: '/auth/:path*', destination: `${BACKEND_URL}/auth/:path*` },
      // SSO entry point. The OIDC callback already arrives under /auth/*.
      { source: '/sso/:path*', destination: `${BACKEND_URL}/sso/:path*` },
      { source: '/authorize', destination: `${BACKEND_URL}/authorize` },
      { source: '/callback', destination: `${BACKEND_URL}/callback` },
      { source: '/token', destination: `${BACKEND_URL}/token` },
      { source: '/register', destination: `${BACKEND_URL}/register` },
      { source: '/userinfo', destination: `${BACKEND_URL}/userinfo` },
    ];
  },
};

// Source maps are uploaded to our Sentry project when the build has a
// SENTRY_AUTH_TOKEN (the Docker publish workflow passes it as a BuildKit
// secret) and deleted from the output either way, so the public image never
// serves them. Self-hosted builds without the token skip the upload. Nothing
// here decides where a running instance reports: that is SENTRY_DSN, read at
// runtime (see components/sentry-config.tsx).
export default withSentryConfig(nextConfig, {
  org: 'helpcodeai-gmbh',
  project: 'anythingmcp-cloud-frontend',
  // The organization is in Sentry's EU region.
  sentryUrl: 'https://de.sentry.io/',
  authToken: process.env.SENTRY_AUTH_TOKEN,
  release: { name: process.env.SENTRY_RELEASE },
  widenClientFileUpload: true,
  sourcemaps: { deleteSourcemapsAfterUpload: true },
  // Browser events go to /monitoring on this origin and are forwarded to
  // Sentry, so ad blockers do not hide them. Exempted in proxy.ts.
  tunnelRoute: '/monitoring',
  telemetry: false,
  // Always log: a silent failed upload only shows up later as unreadable
  // stack traces.
  silent: false,
});
