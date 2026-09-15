import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const SCIM_CONTENT_TYPE = 'application/scim+json; charset=utf-8';

/** RFC 7644 §3.12 `scimType` values we use. */
export type ScimType =
  | 'invalidFilter'
  | 'invalidSyntax'
  | 'invalidValue'
  | 'invalidPath'
  | 'uniqueness'
  | 'mutability'
  | 'noTarget'
  | 'tooMany';

/**
 * A SCIM error. Extends HttpException with the SCIM body already in place, so
 * even a path that escapes the filter answers in the shape Entra expects.
 */
export class ScimError extends HttpException {
  constructor(status: number, detail: string, scimType?: ScimType) {
    super(
      {
        schemas: [SCIM_ERROR_SCHEMA],
        status: String(status),
        ...(scimType ? { scimType } : {}),
        detail,
      },
      status,
    );
  }
}

/**
 * Turns every failure on the SCIM controller into a SCIM error document.
 *
 * Nest's default JSON error body (`{ message, error, statusCode }`) is not
 * what Entra parses; a 409 it cannot read as `uniqueness` becomes a
 * quarantined user instead of a GET-then-PATCH retry.
 */
@Catch()
export class ScimExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ScimExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    res.setHeader('Content-Type', SCIM_CONTENT_TYPE);

    if (exception instanceof ScimError) {
      const status = exception.getStatus();
      if (status === HttpStatus.UNAUTHORIZED) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="scim"');
      }
      return res.status(status).json(exception.getResponse());
    }

    // Prisma unique violation — a concurrent create for the same identity or
    // email. `uniqueness` is the scimType Entra recognises as "already there".
    if (isPrismaError(exception) && exception.code === 'P2002') {
      return res.status(HttpStatus.CONFLICT).json({
        schemas: [SCIM_ERROR_SCHEMA],
        status: '409',
        scimType: 'uniqueness',
        detail: 'A resource with this identifier already exists.',
      });
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status === HttpStatus.UNAUTHORIZED) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="scim"');
      }
      return res.status(status).json({
        schemas: [SCIM_ERROR_SCHEMA],
        status: String(status),
        detail: exception.message,
      });
    }

    // Never leak an internal message to the directory.
    this.logger.error(
      `Unhandled SCIM error: ${exception instanceof Error ? exception.stack ?? exception.message : String(exception)}`,
    );
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      schemas: [SCIM_ERROR_SCHEMA],
      status: '500',
      detail: 'Internal error.',
    });
  }
}

function isPrismaError(e: unknown): e is { code: string } {
  return typeof e === 'object' && e !== null && typeof (e as any).code === 'string';
}
