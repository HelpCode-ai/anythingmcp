import { expect, test } from '@playwright/test';
import { NextRequest } from 'next/server';
import { proxy } from '../../src/proxy';

/**
 * The sign-in gate (src/proxy.ts) and the paths the backend owns.
 *
 * Behind a single port every request passes this gate before Next rewrites
 * it to the backend, so a backend path missing from its allow-list is sent
 * to /login for any browser without a dashboard session. An AI client's
 * authorization is exactly that case: the sign-in happens on the backend's
 * own page and leaves no dashboard session. `/callback`, where the
 * authorization finishes after "Allow access", was missing.
 */
const BACKEND_PATHS = [
  '/authorize',
  '/callback',
  '/token',
  '/register',
  '/userinfo',
  '/auth/login',
  '/auth/pending',
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource',
  '/mcp',
];

test.describe('sign-in gate', () => {
  for (const path of BACKEND_PATHS) {
    test(`lets ${path} through without a dashboard session`, () => {
      const response = proxy(new NextRequest(`http://localhost:3000${path}?state=abc`));
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('x-middleware-next')).toBe('1');
    });
  }

  test('still sends a dashboard page to sign-in, and back afterwards', () => {
    const response = proxy(new NextRequest('http://localhost:3000/connectors?tab=mine'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/login?redirect=%2Fconnectors%3Ftab%3Dmine');
  });

  test('does not treat a page that only starts like a backend path as one', () => {
    for (const path of ['/callbacks', '/callback/extra', '/tokens']) {
      const response = proxy(new NextRequest(`http://localhost:3000${path}`));
      expect(response.headers.get('location'), path).toContain('/login?redirect=');
    }
  });

  test('the running server does not redirect /callback to sign-in', async ({ request }) => {
    // No backend runs behind these tests, so the rewrite itself may fail; what
    // matters is that the gate no longer answers with /login.
    const response = await request.get('/callback?state=abc', { maxRedirects: 0, failOnStatusCode: false });
    expect(response.headers()['location'] ?? '').not.toContain('/login');
  });
});
