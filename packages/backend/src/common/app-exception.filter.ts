import { ArgumentsHost, Catch, HttpException, Logger } from '@nestjs/common';
import { SentryGlobalFilter } from '@sentry/nestjs/setup';

/**
 * An error the Node HTTP stack raised because of the client, not of us:
 * `http-errors` objects with `expose: true` and a 4xx status, such as the body
 * parser's "request aborted" (the client hung up while sending a body),
 * "request entity too large" or a JSON body that does not parse.
 */
export function isClientHttpError(
  exception: unknown,
): exception is { statusCode: number; message: string } {
  if (!exception || typeof exception !== 'object') return false;
  if (exception instanceof HttpException) return false;
  const e = exception as { expose?: unknown; statusCode?: unknown; message?: unknown };
  return (
    e.expose === true &&
    typeof e.statusCode === 'number' &&
    e.statusCode >= 400 &&
    e.statusCode < 500 &&
    typeof e.message === 'string'
  );
}

/**
 * SentryGlobalFilter, except for client errors of the HTTP stack. Nest already
 * answered those with their own 4xx status, but logged each one as an error
 * with a stack trace ("ExceptionsHandler: request aborted", 349 lines on Cloud
 * on 23 Nov during a slow hour). They are now answered the same way and logged
 * as one warning line, and they are not sent to Sentry (where `sentry-scrub`
 * dropped them anyway).
 */
@Catch()
export class AppExceptionFilter extends SentryGlobalFilter {
  private readonly clientErrors = new Logger('ExceptionsHandler');

  override catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() === 'http' && isClientHttpError(exception)) {
      const applicationRef = this.applicationRef ?? this.httpAdapterHost?.httpAdapter;
      if (applicationRef) {
        const body = { statusCode: exception.statusCode, message: exception.message };
        const response = host.getArgByIndex(1);
        if (!applicationRef.isHeadersSent(response)) {
          applicationRef.reply(response, body, body.statusCode);
        } else {
          applicationRef.end(response);
        }
        this.clientErrors.warn(`Client error ${body.statusCode}: ${body.message}`);
        return;
      }
    }
    return super.catch(exception, host);
  }
}
