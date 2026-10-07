import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { RestEngine } from './rest.engine';
import {
  ResponseBodyError,
  assertNoResponseBodyError,
  describeErrorWhenProblems,
} from './response-error.util';
import { classifyToolExecutionError } from '../connector-error.util';
import { connectorErrorWhen } from '../error-when.util';
import peoplehr from '../../adapters/gb/peoplehr.json';
import koreaLaw from '../../adapters/intl/korea-law.json';

const PEOPLEHR_RULES = (peoplehr.connector as any).config.errorWhen;
const KOREA_RULES = (koreaLaw.connector as any).config.errorWhen;

function thrown(fn: () => void): ResponseBodyError | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof ResponseBodyError) return err;
    throw err;
  }
  return undefined;
}

describe('assertNoResponseBodyError', () => {
  it('does nothing without rules, whatever the body says', () => {
    const body = { isError: true, Status: 5, Message: 'Access Denied.' };
    expect(() => assertNoResponseBodyError(body, undefined)).not.toThrow();
    expect(() => assertNoResponseBodyError(body, [])).not.toThrow();
    expect(() => assertNoResponseBodyError(body, null)).not.toThrow();
  });

  it('matches equals, compares scalars as text, and takes the message from messagePath', () => {
    const rule = { path: 'isError', equals: true, messagePath: 'Message', status: 401 };
    const err = thrown(() => assertNoResponseBodyError({ isError: true, Message: 'Invalid API key' }, rule));
    expect(err?.status).toBe(401);
    expect(err?.message).toContain('Invalid API key');
    expect(thrown(() => assertNoResponseBodyError({ isError: 'true', Message: 'x' }, rule))).toBeDefined();
    expect(thrown(() => assertNoResponseBodyError({ isError: false, Message: 'x' }, rule))).toBeUndefined();
  });

  it('defaults to status 400 and to the value at path as the message', () => {
    const err = thrown(() => assertNoResponseBodyError({ error: 'Something broke' }, { path: 'error' }));
    expect(err?.status).toBe(400);
    expect(err?.message).toContain('Something broke');
  });

  it('a bare path only matches a value that says something', () => {
    for (const quiet of [null, false, '', 0]) {
      expect(thrown(() => assertNoResponseBodyError({ error: quiet }, { path: 'error' }))).toBeUndefined();
    }
    expect(thrown(() => assertNoResponseBodyError({}, { path: 'error' }))).toBeUndefined();
  });

  it('reads nested and indexed paths and joins several message paths', () => {
    const body = { errors: [{ code: 'E1', text: 'first', hint: 'do this' }] };
    const err = thrown(() =>
      assertNoResponseBodyError(body, {
        path: 'errors[0].code',
        in: ['E1', 'E2'],
        messagePath: ['errors[0].text', 'errors[0].hint'],
      }),
    );
    expect(err?.message).toContain('first do this');
  });

  it('checks rules in order and skips one whose messageMatches does not match', () => {
    const rules = [
      { path: 'Status', equals: 5, messagePath: 'Message', messageMatches: 'access denied', status: 401 },
      { path: 'Status', equals: 5, messagePath: 'Message', status: 400 },
    ];
    expect(thrown(() => assertNoResponseBodyError({ Status: 5, Message: 'Access Denied.' }, rules))?.status).toBe(401);
    expect(thrown(() => assertNoResponseBodyError({ Status: 5, Message: 'Date is invalid' }, rules))?.status).toBe(400);
  });

  it('never reads the prototype chain and ignores non-object bodies', () => {
    expect(thrown(() => assertNoResponseBodyError({}, { path: 'constructor' }))).toBeUndefined();
    expect(thrown(() => assertNoResponseBodyError('text', { path: 'length' }))).toBeUndefined();
  });
});

describe('describeErrorWhenProblems', () => {
  it('accepts the catalog rules', () => {
    expect(describeErrorWhenProblems(PEOPLEHR_RULES)).toEqual([]);
    expect(describeErrorWhenProblems(KOREA_RULES)).toEqual([]);
    expect(describeErrorWhenProblems(undefined)).toEqual([]);
  });

  it('names what is wrong', () => {
    expect(
      describeErrorWhenProblems([
        { equals: 1 },
        { path: 'a', matches: '(' },
        { path: 'a', status: 200 },
        { path: 'a', typo: true },
      ]),
    ).toEqual([
      'errorWhen[0].path must be a non-empty string',
      'errorWhen[1].matches is not a valid regular expression',
      'errorWhen[2].status must be an HTTP error status (400-599)',
      'errorWhen[3].typo is not a known field',
    ]);
  });
});

describe('PeopleHR errorWhen rules (documented Status codes)', () => {
  const kindOf = (body: unknown) => {
    const err = thrown(() => assertNoResponseBodyError(body, PEOPLEHR_RULES));
    if (!err) return 'ok';
    return classifyToolExecutionError({ status: err.status, authType: 'NONE', message: err.message }).kind;
  };

  it('lets success and "no record found" through', () => {
    expect(kindOf({ isError: false, Status: 0, Message: 'Success.', Result: [] })).toBe('ok');
    expect(kindOf({ isError: false, Status: 10, Message: 'No records found.', Result: null })).toBe('ok');
  });

  it('reports an unknown or malformed key, and a missing grant, as auth_failed', () => {
    expect(kindOf({ isError: true, Status: 5, Message: 'API Key does not exists.', Result: null })).toBe('auth_failed');
    expect(kindOf({ isError: true, Status: 2, Message: 'Invalid API Key.', Result: null })).toBe('auth_failed');
    expect(kindOf({ isError: true, Status: 1, Message: 'APIKey not supplied.', Result: null })).toBe('auth_failed');
    expect(kindOf({ isError: true, Status: 5, Message: 'Access Denied.', Result: null })).toBe('auth_failed');
  });

  it('reports validation errors as bad_request, throttling and server errors by their kind', () => {
    expect(kindOf({ isError: true, Status: 5, Message: 'Invalid Start Date.', Result: null })).toBe('bad_request');
    expect(kindOf({ isError: true, Status: 9, Message: 'Invalid JSON data.', Result: null })).toBe('bad_request');
    expect(
      kindOf({ isError: true, Status: 5, Message: 'API calls will be limited to a 60 per minute', Result: null }),
    ).toBe('rate_limited');
    expect(kindOf({ isError: true, Status: 6, Message: 'Error occurred.', Result: null })).toBe('upstream_error');
  });
});

describe('Korea law errorWhen rules (live answers of www.law.go.kr, Oct 2026)', () => {
  it('reports an unknown OC or unregistered server as auth_failed with both texts', () => {
    const err = thrown(() =>
      assertNoResponseBodyError(
        {
          result: '사용자 정보 검증에 실패하였습니다.',
          msg: 'OPEN API 호출 시 사용자 검증을 위하여 정확한 서버장비의 IP주소 및 도메인주소를 등록해 주세요.',
        },
        KOREA_RULES,
      ),
    );
    expect(err?.status).toBe(401);
    expect(err?.message).toContain('사용자 정보 검증에 실패하였습니다. OPEN API 호출 시');
  });

  it('reports a missing required value as bad_request', () => {
    const err = thrown(() =>
      assertNoResponseBodyError(
        { result: '필수입력요소 검증에 실패하였습니다.', msg: '필수 입력값이 존재하지 않습니다. 요청 URL을 확인해 주세요.' },
        KOREA_RULES,
      ),
    );
    expect(err?.status).toBe(400);
  });

  it('lets search results through', () => {
    expect(() =>
      assertNoResponseBodyError({ LawSearch: { totalCnt: '1', law: [{ 법령명한글: '민법' }] } }, KOREA_RULES),
    ).not.toThrow();
  });
});

describe('connectorErrorWhen', () => {
  it("uses the connector's own rules, an empty list included", () => {
    expect(connectorErrorWhen({ adapterSlug: 'peoplehr', errorWhen: [] })).toEqual([]);
    expect(connectorErrorWhen({ errorWhen: { path: 'x' } })).toEqual({ path: 'x' });
  });

  it("falls back to the catalog adapter's rules for an older install", () => {
    expect(connectorErrorWhen({ adapterSlug: 'peoplehr' })).toEqual(PEOPLEHR_RULES);
  });

  it('is undefined for connectors without rules', () => {
    expect(connectorErrorWhen(undefined)).toBeUndefined();
    expect(connectorErrorWhen({})).toBeUndefined();
    expect(connectorErrorWhen({ adapterSlug: 'no-such-adapter' })).toBeUndefined();
  });
});

describe('RestEngine with errorWhen', () => {
  let server: Server;
  let baseUrl: string;
  let reply: unknown;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(reply));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const engine = new RestEngine({} as any, {} as any);
  const call = (errorWhen?: unknown) =>
    engine.execute(
      { baseUrl, authType: 'NONE', errorWhen },
      { method: 'POST', path: '/Employee', bodyMapping: { Action: 'GetCompanyInformation' } },
      {},
    );

  it('rejects a 200 that the rules read as an error, with the status the rule gives', async () => {
    reply = { isError: true, Status: 5, Message: 'API Key does not exists.', Result: null };
    const err: any = await call(PEOPLEHR_RULES).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResponseBodyError);
    expect(err.status).toBe(401);
    expect(err.responseBody).toEqual(reply);
  });

  it('returns the same body unchanged without rules, as before', async () => {
    reply = { isError: true, Status: 5, Message: 'API Key does not exists.', Result: null };
    await expect(call()).resolves.toEqual(reply);
  });

  it('returns a successful body unchanged with rules', async () => {
    reply = { isError: false, Status: 0, Message: 'Success.', Result: { CompanyName: 'Acme' } };
    await expect(call(PEOPLEHR_RULES)).resolves.toEqual(reply);
  });
});
