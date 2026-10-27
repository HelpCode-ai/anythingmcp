import { AxiosError } from 'axios';
import {
  DEFAULT_TOOL_MAX_RESPONSE_BYTES,
  RESPONSE_TOO_LARGE_CODE,
  ResponseTooLargeError,
  fitsResponseLimit,
  restateResponseTooLarge,
  toolMaxResponseBytes,
} from './response-size-limit';

describe('toolMaxResponseBytes', () => {
  it('defaults to 10 MB', () => {
    expect(DEFAULT_TOOL_MAX_RESPONSE_BYTES).toBe(10 * 1024 * 1024);
    expect(toolMaxResponseBytes({})).toBe(DEFAULT_TOOL_MAX_RESPONSE_BYTES);
  });

  it('reads TOOL_MAX_RESPONSE_BYTES', () => {
    expect(toolMaxResponseBytes({ TOOL_MAX_RESPONSE_BYTES: '2048' })).toBe(2048);
    expect(toolMaxResponseBytes({ TOOL_MAX_RESPONSE_BYTES: ' 52428800 ' })).toBe(52428800);
  });

  it('falls back to the default for a value that is not a positive whole number', () => {
    for (const value of ['', '0', '-5', '10MB', '1.5', 'abc', '99999999999999999999']) {
      expect(toolMaxResponseBytes({ TOOL_MAX_RESPONSE_BYTES: value })).toBe(
        DEFAULT_TOOL_MAX_RESPONSE_BYTES,
      );
    }
  });

  it('reads process.env when no env is given', () => {
    const saved = process.env.TOOL_MAX_RESPONSE_BYTES;
    process.env.TOOL_MAX_RESPONSE_BYTES = '4096';
    try {
      expect(toolMaxResponseBytes()).toBe(4096);
    } finally {
      if (saved === undefined) delete process.env.TOOL_MAX_RESPONSE_BYTES;
      else process.env.TOOL_MAX_RESPONSE_BYTES = saved;
    }
  });
});

describe('ResponseTooLargeError', () => {
  it('names the limit and tells the model how to narrow the request', () => {
    const err = new ResponseTooLargeError(10 * 1024 * 1024);
    expect(err.code).toBe(RESPONSE_TOO_LARGE_CODE);
    expect(err.limitBytes).toBe(10 * 1024 * 1024);
    expect(err.message).toMatch(/larger than 10 MB, the limit for one tool call/);
    expect(err.message).toMatch(/filters/);
    expect(err.message).toMatch(/fewer fields/);
    expect(err.message).toMatch(/limit/);
    expect(err.message).toMatch(/TOOL_MAX_RESPONSE_BYTES/);
  });

  it('formats small limits readably', () => {
    expect(new ResponseTooLargeError(1536).message).toMatch(/larger than 1\.5 KB/);
    expect(new ResponseTooLargeError(100).message).toMatch(/larger than 100 bytes/);
  });

  it('speaks of the tool result, not the API response, for an oversized result', () => {
    const err = new ResponseTooLargeError(10 * 1024 * 1024, { source: 'result' });
    expect(err.code).toBe(RESPONSE_TOO_LARGE_CODE);
    expect(err.message).toMatch(/^The tool result is larger than 10 MB, the limit for one tool call/);
    expect(err.message).not.toMatch(/stopped reading/);
    expect(err.message).toMatch(/fewer fields/);
    expect(err.message).toMatch(/TOOL_MAX_RESPONSE_BYTES/);
    expect(err.cause).toBeUndefined();
  });
});

describe('fitsResponseLimit', () => {
  it('compares the UTF-8 bytes, not the characters, with the limit', () => {
    expect(fitsResponseLimit('a'.repeat(10), 10)).toBe(true);
    expect(fitsResponseLimit('a'.repeat(11), 10)).toBe(false);
    // 'é' is 2 bytes, '€' is 3 and an emoji (a surrogate pair) is 4.
    expect(fitsResponseLimit('é'.repeat(5), 10)).toBe(true);
    expect(fitsResponseLimit('é'.repeat(6), 10)).toBe(false);
    expect(fitsResponseLimit('€'.repeat(4), 10)).toBe(false);
    expect(fitsResponseLimit('€'.repeat(3), 9)).toBe(true);
    expect(fitsResponseLimit('😀'.repeat(2), 8)).toBe(true);
    expect(fitsResponseLimit('😀'.repeat(3), 11)).toBe(false);
  });

  it('settles short and long texts by their length alone', () => {
    const byteLength = jest.spyOn(Buffer, 'byteLength');
    try {
      expect(fitsResponseLimit('€'.repeat(3), 9)).toBe(true);
      expect(fitsResponseLimit('a'.repeat(11), 10)).toBe(false);
      expect(byteLength).not.toHaveBeenCalled();
      expect(fitsResponseLimit('a'.repeat(5), 10)).toBe(true);
      expect(byteLength).toHaveBeenCalledTimes(1);
    } finally {
      byteLength.mockRestore();
    }
  });
});

describe('restateResponseTooLarge', () => {
  it("restates axios' maxContentLength error", () => {
    const axiosErr = new AxiosError(
      'maxContentLength size of 2048 exceeded',
      AxiosError.ERR_BAD_RESPONSE,
    );
    const out = restateResponseTooLarge(axiosErr);
    expect(out).toBeInstanceOf(ResponseTooLargeError);
    expect((out as ResponseTooLargeError).limitBytes).toBe(2048);
    expect((out as ResponseTooLargeError).cause).toBe(axiosErr);
  });

  it('leaves every other error alone', () => {
    const timeout = new AxiosError('timeout of 30000ms exceeded', AxiosError.ECONNABORTED);
    expect(restateResponseTooLarge(timeout)).toBe(timeout);
    const plain = new Error('maxContentLength size of 2048 exceeded');
    expect(restateResponseTooLarge(plain)).toBe(plain);
  });
});
