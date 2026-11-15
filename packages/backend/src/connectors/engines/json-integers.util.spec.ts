import {
  isBodyIntegerPath,
  isUnsafeIntegerLiteral,
  parseJsonKeepingLargeIntegers,
  stringifyWithIntegerLiterals,
} from './json-integers.util';
import { decodeResponseBody } from '../binary-response.util';

const BIG = '5230236437987443003'; // SHEIN's documented goodsId example

describe('isUnsafeIntegerLiteral', () => {
  it('draws the line at Number.MAX_SAFE_INTEGER, for both signs', () => {
    expect(isUnsafeIntegerLiteral('9007199254740991')).toBe(false);
    expect(isUnsafeIntegerLiteral('-9007199254740991')).toBe(false);
    expect(isUnsafeIntegerLiteral('9007199254740992')).toBe(true);
    expect(isUnsafeIntegerLiteral('-9007199254740992')).toBe(true);
    expect(isUnsafeIntegerLiteral('1000000000000000')).toBe(false);
    expect(isUnsafeIntegerLiteral('99999999999999999999')).toBe(true);
    expect(isUnsafeIntegerLiteral('0')).toBe(false);
  });
});

describe('parseJsonKeepingLargeIntegers', () => {
  it('keeps unsafe integers exact as strings, nested in objects and arrays, with their sign', () => {
    const text = `{"code":"0","info":[{"goodsId":${BIG},"ids":[${BIG}, -9223372036854775808 ,9007199254740992],"n":{"deep":{"x":18446744073709551615}}}]}`;
    expect(parseJsonKeepingLargeIntegers(text)).toEqual({
      code: '0',
      info: [
        {
          goodsId: BIG,
          ids: [BIG, '-9223372036854775808', '9007199254740992'],
          n: { deep: { x: '18446744073709551615' } },
        },
      ],
    });
    // A bare top-level integer too.
    expect(parseJsonKeepingLargeIntegers(` ${BIG}\n`)).toBe(BIG);
  });

  it('parses everything else exactly as JSON.parse does', () => {
    const cases = [
      '{"a":1,"b":-2,"c":9007199254740991,"d":-9007199254740991,"e":0}',
      '{"price":12345678901234567.5,"big":1.2345678901234567e30,"neg":-12345678901234567890.0,"exp":12345678901234567890E2}',
      '{"inString":"12345678901234567890","esc":"say \\"12345678901234567890\\" now","slash":"a\\\\","after":7}',
      '{"key12345678901234567890":true,"list":[null,false,"x"],"empty":{}}',
      '[1,2,3]',
      '"just a string with 12345678901234567890"',
      'true',
      '{"unicode":"\\u0022 12345678901234567890 \\u0022","n":1}',
    ];
    for (const text of cases) expect(parseJsonKeepingLargeIntegers(text)).toEqual(JSON.parse(text));
  });

  it('a large integer right after an escaped quote at the end of a string is still read as a value', () => {
    expect(parseJsonKeepingLargeIntegers(`{"s":"a\\\\","id":${BIG}}`)).toEqual({ s: 'a\\', id: BIG });
    expect(parseJsonKeepingLargeIntegers(`{"s":"q\\"","id":${BIG}}`)).toEqual({ s: 'q"', id: BIG });
  });

  it('throws exactly when JSON.parse throws', () => {
    const invalid = [
      '',
      '{',
      `{"a":${BIG}`,
      `[${BIG} 1]`,
      `[0${BIG}]`,
      `{"a":-${BIG}x}`,
      `{"a":${BIG}.}`,
      'not json 12345678901234567890',
      `{"a":"${BIG}}`,
      `{${BIG}:1}`,
    ];
    for (const text of invalid) {
      expect(() => JSON.parse(text)).toThrow();
      expect(() => parseJsonKeepingLargeIntegers(text)).toThrow();
    }
  });
});

describe('decodeResponseBody with largeIntegers', () => {
  const json = Buffer.from(`{"goodsId":${BIG}}`, 'utf8');
  const headers = { 'content-type': 'application/json' };

  it('keeps the digits only when asked, and rounds as before otherwise', () => {
    expect(decodeResponseBody(json, headers, { largeIntegers: 'string' })).toEqual({ goodsId: BIG });
    expect(decodeResponseBody(json, headers)).toEqual(JSON.parse(`{"goodsId":${BIG}}`));
    expect((decodeResponseBody(json, headers) as { goodsId: number }).goodsId).not.toBe(Number(BIG.slice(0, -1)));
    // Text that is not JSON stays text, as before.
    expect(decodeResponseBody(Buffer.from('oops 12345678901234567890'), { 'content-type': 'text/plain' }, { largeIntegers: 'string' })).toBe(
      'oops 12345678901234567890',
    );
  });
});

describe('stringifyWithIntegerLiterals', () => {
  it('writes digit strings at the named paths as number literals, exactly', () => {
    const body = {
      orderNo: 'GSON8F44T00000M',
      orderGoodsId: BIG,
      infoList: [
        { expressCode: '123456789012345678901', goodsId: BIG, status: 2 },
        { expressCode: 'X', goodsId: '3000000000065815', status: 1 },
        { expressCode: 'Y', goodsId: 42 },
      ],
      goodsIdList: [BIG, '-9223372036854775808'],
    };
    const text = stringifyWithIntegerLiterals(body, ['orderGoodsId', 'infoList[].goodsId', 'goodsIdList[]']);
    expect(text).toBe(
      `{"orderNo":"GSON8F44T00000M","orderGoodsId":${BIG},"infoList":[` +
        `{"expressCode":"123456789012345678901","goodsId":${BIG},"status":2},` +
        `{"expressCode":"X","goodsId":3000000000065815,"status":1},` +
        `{"expressCode":"Y","goodsId":42}],"goodsIdList":[${BIG},-9223372036854775808]}`,
    );
    // The input is not changed, and other strings of digits stay strings.
    expect(body.orderGoodsId).toBe(BIG);
    expect(parseJsonKeepingLargeIntegers(text)).toEqual({ ...body, infoList: [body.infoList[0], { ...body.infoList[1], goodsId: 3000000000065815 }, body.infoList[2]] });
  });

  it('skips absent fields and null, and refuses anything that is not a whole number', () => {
    expect(stringifyWithIntegerLiterals({ a: 1 }, ['orderGoodsId', 'list[].id'])).toBe('{"a":1}');
    expect(stringifyWithIntegerLiterals({ id: null }, ['id'])).toBe('{"id":null}');
    for (const bad of ['12a', '1.5', '', ' ', 1.5, 2 ** 60, true, {}, '0012']) {
      expect(() => stringifyWithIntegerLiterals({ id: bad }, ['id'])).toThrow(/id must be a whole number/);
    }
    expect(() => stringifyWithIntegerLiterals({ id: '1' }, ['a..b'])).toThrow(/not a body path/);
  });

  it('cannot be fooled by a value that looks like its own placeholder', () => {
    const text = stringifyWithIntegerLiterals({ note: '@@amcp-int-0000000000000000-0@@', id: BIG }, ['id']);
    expect(JSON.parse(text.replace(BIG, '1'))).toEqual({ note: '@@amcp-int-0000000000000000-0@@', id: 1 });
  });

  it('accepts the path shapes the validator accepts', () => {
    for (const ok of ['a', 'a[]', 'a[].b', 'a.b[]', 'a_b.c-d[].e']) expect(isBodyIntegerPath(ok)).toBe(true);
    for (const bad of ['', 'a..b', '.a', 'a[0]', 'a[].', 'a b', 5]) expect(isBodyIntegerPath(bad)).toBe(false);
  });
});
