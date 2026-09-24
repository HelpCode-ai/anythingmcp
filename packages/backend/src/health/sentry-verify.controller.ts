import { Controller, Get, Headers, NotFoundException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { timingSafeEqual } from 'node:crypto';

/**
 * Throws a deliberate error so an operator can confirm, end to end, that
 * backend errors reach Sentry with readable stack traces and no request data.
 *
 * Off unless SENTRY_VERIFY_TOKEN is set on the server, and then it only fires
 * for a request carrying that token in `x-sentry-verify`. Everyone else,
 * self-hosted installations included, gets a 404. Unset the variable once the
 * check is done.
 */
@ApiExcludeController()
@Controller('health')
export class SentryVerifyController {
  @Get('sentry-verify')
  verify(@Headers('x-sentry-verify') presented?: string): never {
    const expected = process.env.SENTRY_VERIFY_TOKEN;
    if (!expected || !presented || !sameSecret(presented, expected)) {
      throw new NotFoundException();
    }
    throw new Error('Sentry verification (backend)');
  }
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
