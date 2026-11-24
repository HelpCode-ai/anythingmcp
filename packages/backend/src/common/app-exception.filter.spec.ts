import { BadRequestException, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { AppExceptionFilter, isClientHttpError } from './app-exception.filter';

/** What `http-errors` (used by the body parser) creates. */
function createError(status: number, message: string, props: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { status, statusCode: status, expose: status < 500, ...props });
}

function makeHost(type = 'http') {
  const response = {};
  return {
    response,
    host: {
      getType: () => type,
      getArgByIndex: (i: number) => (i === 1 ? response : undefined),
    } as any,
  };
}

function makeFilter(headersSent = false) {
  const applicationRef = {
    isHeadersSent: jest.fn(() => headersSent),
    reply: jest.fn(),
    end: jest.fn(),
  };
  const filter = new AppExceptionFilter(applicationRef as any);
  return { filter, applicationRef };
}

describe('isClientHttpError', () => {
  it('matches the body parser client errors', () => {
    const aborted = createError(400, 'request aborted', { code: 'ECONNABORTED', type: 'request.aborted' });
    expect(isClientHttpError(aborted)).toBe(true);
    expect(isClientHttpError(createError(413, 'request entity too large'))).toBe(true);
  });

  it('leaves server errors, Nest exceptions and plain errors alone', () => {
    expect(isClientHttpError(createError(500, 'boom'))).toBe(false);
    expect(isClientHttpError(new BadRequestException('bad'))).toBe(false);
    expect(isClientHttpError(new Error('request aborted'))).toBe(false);
    expect(isClientHttpError({ expose: true, statusCode: 400 })).toBe(false);
    expect(isClientHttpError(null)).toBe(false);
  });
});

describe('AppExceptionFilter', () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let parent: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger, 'error').mockImplementation(() => undefined);
    parent = jest.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('answers an aborted upload with its 400 and logs one warning, not an error', () => {
    const { filter, applicationRef } = makeFilter();
    const { host, response } = makeHost();
    filter.catch(createError(400, 'request aborted', { code: 'ECONNABORTED' }), host);
    expect(applicationRef.reply).toHaveBeenCalledWith(
      response,
      { statusCode: 400, message: 'request aborted' },
      400,
    );
    expect(warn).toHaveBeenCalledWith('Client error 400: request aborted');
    expect(error).not.toHaveBeenCalled();
    // Not passed on: the Sentry filter would report it and Nest log an error.
    expect(parent).not.toHaveBeenCalled();
  });

  it('ends the response when headers were already sent', () => {
    const { filter, applicationRef } = makeFilter(true);
    const { host, response } = makeHost();
    filter.catch(createError(413, 'request entity too large'), host);
    expect(applicationRef.reply).not.toHaveBeenCalled();
    expect(applicationRef.end).toHaveBeenCalledWith(response);
  });

  it('hands every other exception to the Sentry filter', () => {
    const { filter } = makeFilter();
    const { host } = makeHost();
    const boom = new Error('boom');
    filter.catch(boom, host);
    expect(parent).toHaveBeenCalledWith(boom, host);
    expect(warn).not.toHaveBeenCalled();
  });
});
