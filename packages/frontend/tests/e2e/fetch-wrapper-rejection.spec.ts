import { expect, test } from '@playwright/test';
import { ApiError, asApiError } from '../../src/lib/api';
import { beforeSendBrowser, isForeignAuthRejection } from '../../src/lib/sentry-scrub';

/**
 * ANYTHINGMCP-CLOUD-FRONTEND-H: on / in Safari, a saved session's check
 * (/api/users/me) got a 401 and Sentry recorded an unhandled rejection of a
 * plain object `{status: 401, error: true, body: {message}}`, no stack. Our
 * API client throws ApiError, an Error; that shape comes from a script
 * wrapping window.fetch. The client turns such a rejection into an ApiError
 * (so a 401 still signs the session out), and Sentry drops the wrapper's own
 * unawaited rejection.
 */

const USER = {
  id: 'u1',
  email: 'admin@example.com',
  name: 'Admin',
  role: 'ADMIN',
  organizationId: 'o1',
  emailVerified: true,
};

test.describe('a fetch that rejects with a plain object', () => {
  test('becomes an ApiError with the status and message', () => {
    const err = asApiError({ status: 401, error: true, body: { message: 'Unauthorized' } });
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, message: 'Unauthorized', body: { message: 'Unauthorized' } });
    expect((err as ApiError).stack).toBeTruthy();
    expect(asApiError({ status: 503 })).toMatchObject({ status: 503, message: 'API error: 503' });
  });

  test('anything else is passed through untouched', () => {
    const network = new TypeError('Load failed');
    expect(asApiError(network)).toBe(network);
    const noStatus = { error: true };
    expect(asApiError(noStatus)).toBe(noStatus);
    expect(asApiError('x')).toBe('x');
    expect(asApiError(null)).toBeNull();
  });

  test('signs a saved session out and leaves nothing unhandled', async ({ page }) => {
    const origin = test.info().project.use.baseURL ?? 'http://localhost:3100';
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.context().addCookies([{ name: 'amcp_token', value: 't', url: origin }]);
    await page.addInitScript((user) => {
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('amcp_token', 't');
        localStorage.setItem('amcp_user', JSON.stringify(user));
      }
      (window as unknown as { __rejections: unknown[] }).__rejections = [];
      window.addEventListener('unhandledrejection', (e) =>
        (window as unknown as { __rejections: unknown[] }).__rejections.push(e.reason),
      );
      // What the wrapping script does: a 401 rejects instead of resolving.
      const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const res = await original(input, init);
        if (res.status === 401) {
          throw { status: 401, error: true, body: { message: 'Unauthorized' } };
        }
        return res;
      };
    }, USER);
    await page.route(/\/(api|health)\//, async (route) => {
      const p = new URL(route.request().url()).pathname;
      const json = (body: unknown, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (p === '/health/server-info') {
        return json({ deploymentMode: 'cloud', mcpAuthMode: 'oauth', hasUsers: true, registrationEnabled: true, ssoProviders: [] });
      }
      if (p.startsWith('/api/')) return json({ message: 'Unauthorized', statusCode: 401 }, 401);
      return json({});
    });

    await page.goto('/');
    await page.waitForURL(/\/login/);
    await page.waitForLoadState('networkidle');

    expect(await page.evaluate(() => localStorage.getItem('amcp_token'))).toBeNull();
    expect(await page.evaluate(() => (window as unknown as { __rejections: unknown[] }).__rejections)).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});

test.describe('Sentry and a foreign 401 rejection', () => {
  const event = { exception: { values: [{ type: 'UnhandledRejection', value: 'Object captured as promise rejection with keys: body, error, status' }] } };

  test('drops a plain-object 401 rejection', () => {
    const hint = { originalException: { status: 401, error: true, body: { message: 'Unauthorized' } } };
    expect(isForeignAuthRejection(hint)).toBe(true);
    expect(beforeSendBrowser(event, hint)).toBeNull();
  });

  test('keeps our own errors and other rejections', () => {
    expect(isForeignAuthRejection({ originalException: new ApiError('Unauthorized', 401, {}) })).toBe(false);
    expect(isForeignAuthRejection({ originalException: { status: 500, error: true } })).toBe(false);
    expect(isForeignAuthRejection({ originalException: {} })).toBe(false);
    expect(isForeignAuthRejection(undefined)).toBe(false);
    expect(beforeSendBrowser(event, { originalException: {} })).not.toBeNull();
  });
});
