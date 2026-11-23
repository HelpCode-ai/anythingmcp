import { ThrottlerException } from '@nestjs/throttler';
import { AuthPageThrottleFilter } from './auth-page-throttle.filter';

function host(req: Record<string, unknown>) {
  const res: any = {
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    send(body: string) {
      this.body = body;
      return this;
    },
    json(body: unknown) {
      this.jsonBody = body;
      return this;
    },
  };
  return { res, host: { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as any };
}

describe('AuthPageThrottleFilter', () => {
  const filter = new AuthPageThrottleFilter({ isCloud: () => true } as any);

  it.each([
    ['POST /auth/login', { originalUrl: '/auth/login', headers: { 'content-type': 'application/x-www-form-urlencoded' } }],
    ['POST /auth/verify-email', { originalUrl: '/auth/verify-email', headers: { 'content-type': 'application/x-www-form-urlencoded' } }],
    ['GET /auth/next', { originalUrl: '/auth/next?x=1', headers: {} }],
  ])('answers a person on %s with a page', (_label, req) => {
    const { res, host: h } = host(req);
    filter.catch(new ThrottlerException(), h);
    expect(res.statusCode).toBe(429);
    expect(res.headers['Content-Type']).toContain('text/html');
    expect(res.body).toContain('<h1>Too many attempts</h1>');
    expect(res.body).toContain('Wait a minute, then try again.');
    expect(res.body).toContain('href="/auth/login"');
    expect(res.jsonBody).toBeUndefined();
  });

  it.each([
    ['the app picker', { originalUrl: '/auth/first-app', headers: { 'content-type': 'application/json' } }],
    ['the Telegram status poll', { originalUrl: '/auth/first-app/telegram/status', headers: {} }],
    ['the beacon', { originalUrl: '/auth/beacon', headers: { 'content-type': 'application/x-www-form-urlencoded' } }],
    ['the pending check', { originalUrl: '/auth/pending', headers: {} }],
  ])('keeps the JSON answer for %s', (_label, req) => {
    const { res, host: h } = host(req);
    filter.catch(new ThrottlerException(), h);
    expect(res.statusCode).toBe(429);
    expect(res.jsonBody).toEqual({ statusCode: 429, message: 'ThrottlerException: Too Many Requests' });
    expect(res.body).toBeUndefined();
  });
});
