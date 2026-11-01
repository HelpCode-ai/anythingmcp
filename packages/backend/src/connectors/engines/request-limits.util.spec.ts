import {
  DEFAULT_TOOL_TIMEOUT_MS,
  MAX_TOOL_RESPONSE_BYTES_OVERRIDE,
  MAX_TOOL_TIMEOUT_MS,
  MIN_TOOL_TIMEOUT_MS,
  toolResponseLimitBytes,
  toolTimeoutMs,
} from './request-limits.util';
import { DEFAULT_TOOL_MAX_RESPONSE_BYTES } from '../../common/response-size-limit';

describe('toolTimeoutMs', () => {
  it('keeps 30 s when the tool sets nothing usable', () => {
    for (const value of [undefined, null, '', 'soon', '2m', 0, -5, 1.5, NaN, Infinity, {}, [60000], true]) {
      expect(toolTimeoutMs(value)).toBe(DEFAULT_TOOL_TIMEOUT_MS);
    }
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(30_000);
  });

  it('takes a value in range, as a number or a string of digits', () => {
    expect(toolTimeoutMs(120_000)).toBe(120_000);
    expect(toolTimeoutMs('90000')).toBe(90_000);
    expect(toolTimeoutMs(5_000)).toBe(5_000);
  });

  it('clamps to 1 s – 180 s, so a tool cannot switch the timeout off', () => {
    expect(toolTimeoutMs(10)).toBe(MIN_TOOL_TIMEOUT_MS);
    expect(toolTimeoutMs(3_600_000)).toBe(MAX_TOOL_TIMEOUT_MS);
    expect(toolTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TOOL_TIMEOUT_MS);
    expect([MIN_TOOL_TIMEOUT_MS, MAX_TOOL_TIMEOUT_MS]).toEqual([1_000, 180_000]);
  });
});

describe('toolResponseLimitBytes', () => {
  const MB = 1024 * 1024;

  it('keeps TOOL_MAX_RESPONSE_BYTES when the tool sets nothing usable', () => {
    for (const value of [undefined, null, '', '40MB', 0, -1, 2.5, {}, false]) {
      expect(toolResponseLimitBytes(value, {})).toBe(DEFAULT_TOOL_MAX_RESPONSE_BYTES);
      expect(toolResponseLimitBytes(value, { TOOL_MAX_RESPONSE_BYTES: String(20 * MB) })).toBe(20 * MB);
    }
  });

  it('raises the limit for one tool, up to 50 MB', () => {
    expect(toolResponseLimitBytes(40 * MB, {})).toBe(40 * MB);
    expect(toolResponseLimitBytes(String(40 * MB), {})).toBe(40 * MB);
    expect(toolResponseLimitBytes(500 * MB, {})).toBe(MAX_TOOL_RESPONSE_BYTES_OVERRIDE);
    expect(MAX_TOOL_RESPONSE_BYTES_OVERRIDE).toBe(50 * MB);
  });

  it('allows a tool to set a lower limit than the global one', () => {
    expect(toolResponseLimitBytes(MB, {})).toBe(MB);
  });

  it('lets a tool go as high as a global limit an administrator set above 50 MB, no higher', () => {
    const env = { TOOL_MAX_RESPONSE_BYTES: String(80 * MB) };
    expect(toolResponseLimitBytes(70 * MB, env)).toBe(70 * MB);
    expect(toolResponseLimitBytes(500 * MB, env)).toBe(80 * MB);
  });
});
