import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { DeploymentService } from '../common/deployment.service';
import { renderAuthPage } from './auth-page';

/** Routes of the authorization pages that a script calls and that answer JSON. */
const JSON_ROUTES = ['/auth/first-app', '/auth/beacon', '/auth/pending', '/auth/file-search/session'];

/**
 * "Too many requests" on the authorization pages.
 *
 * The rate limit answered every route with the framework's JSON, also a form
 * post or a page load a person made: they saw `{"statusCode":429,…}` in the
 * browser. A page request now gets a page that says to wait a minute; the
 * routes scripts call keep the JSON answer. The limits themselves are not
 * changed here.
 */
@Catch(ThrottlerException)
export class AuthPageThrottleFilter implements ExceptionFilter {
  constructor(private readonly deployment: DeploymentService) {}

  catch(_exception: ThrottlerException, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const path = (req.originalUrl || req.url || '').split('?')[0];
    const contentType = String(req.headers['content-type'] ?? '');
    const scripted = JSON_ROUTES.some((r) => path === r || path.startsWith(`${r}/`)) || contentType.includes('application/json');
    res.status(429);
    if (scripted) {
      res.json({ statusCode: 429, message: 'ThrottlerException: Too Many Requests' });
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(
      renderAuthPage({
        title: 'Too many attempts',
        card: `
    <h1>Too many attempts</h1>
    <p class="sub">Wait a minute, then try again. Your connection request stays open for 30 minutes.</p>
    <a class="button" href="/auth/login">Back to the sign-in page</a>`,
        trust: { cloud: this.deployment.isCloud() },
      }),
    );
  }
}
