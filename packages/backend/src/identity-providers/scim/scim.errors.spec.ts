import { HttpException, NotFoundException } from '@nestjs/common';
import { ScimError, ScimExceptionFilter, SCIM_ERROR_SCHEMA } from './scim.errors';

/**
 * Entra parses the SCIM error document, not Nest's default body. A 409 it
 * cannot read as `uniqueness` becomes a quarantined user instead of a
 * GET-then-PATCH retry, so the shape is load-bearing.
 */
describe('ScimExceptionFilter', () => {
  let res: any;
  let filter: ScimExceptionFilter;
  const host = () => ({ switchToHttp: () => ({ getResponse: () => res }) }) as any;

  beforeEach(() => {
    res = {
      headers: {} as Record<string, string>,
      statusCode: 0,
      body: undefined as unknown,
      setHeader(k: string, v: string) { this.headers[k] = v; },
      status(c: number) { this.statusCode = c; return this; },
      json(b: unknown) { this.body = b; return this; },
    };
    filter = new ScimExceptionFilter();
  });

  it('emits a ScimError as-is, with the SCIM content type', () => {
    filter.catch(new ScimError(409, 'dup', 'uniqueness'), host());
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ schemas: [SCIM_ERROR_SCHEMA], status: '409', scimType: 'uniqueness', detail: 'dup' });
    expect(res.headers['Content-Type']).toContain('application/scim+json');
  });

  it('adds WWW-Authenticate on 401', () => {
    filter.catch(new ScimError(401, 'nope'), host());
    expect(res.headers['WWW-Authenticate']).toBe('Bearer realm="scim"');
  });

  it('maps a Prisma unique violation to 409 uniqueness', () => {
    filter.catch({ code: 'P2002', message: 'Unique constraint failed on users.email' }, host());
    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ scimType: 'uniqueness' });
    // Never the Prisma text: it names tables and columns.
    expect(JSON.stringify(res.body)).not.toContain('users.email');
  });

  it('wraps other HttpExceptions (e.g. the self-hosted-only 404) in the SCIM shape', () => {
    filter.catch(new NotFoundException('Not found'), host());
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ schemas: [SCIM_ERROR_SCHEMA], status: '404', detail: 'Not found' });
  });

  it('never leaks an internal error message', () => {
    filter.catch(new Error('connect ECONNREFUSED 10.0.0.5:5432'), host());
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
  });

  it('ScimError is an HttpException carrying the SCIM body', () => {
    const e = new ScimError(400, 'bad', 'invalidValue');
    expect(e).toBeInstanceOf(HttpException);
    expect(e.getStatus()).toBe(400);
    expect(e.getResponse()).toMatchObject({ schemas: [SCIM_ERROR_SCHEMA], scimType: 'invalidValue' });
  });
});
