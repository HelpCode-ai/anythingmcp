import { expect, test } from '@playwright/test';
import type { Event } from '@sentry/nextjs';
import { beforeSendBrowser, isInjectedScriptError } from '../../src/lib/sentry-scrub';

/**
 * Errors thrown entirely inside scripts the browser injected (Chrome on iOS
 * translating /login, ANYTHINGMCP-CLOUD-FRONTEND-9 and -A) never reach Sentry.
 * Anything with a frame in one of our chunks, or without a stack, still does.
 */

const withFrames = (...filenames: Array<string | undefined>): Event => ({
  exception: { values: [{ type: 'RangeError', value: 'x', stacktrace: { frames: filenames.map((filename) => ({ filename })) } }] },
});

test.describe('injected-script errors', () => {
  test('drops an error whose whole stack is the page itself', () => {
    expect(isInjectedScriptError(withFrames('app:///login', 'app:///login'))).toBe(true);
    expect(isInjectedScriptError(withFrames(undefined))).toBe(true);
    expect(beforeSendBrowser(withFrames('app:///login'))).toBeNull();
  });

  test('keeps an error with a frame in one of our chunks', () => {
    const ours = withFrames('app:///login', 'app:///_next/static/chunks/0abc.js');
    expect(isInjectedScriptError(ours)).toBe(false);
    expect(beforeSendBrowser(ours)).not.toBeNull();
  });

  test('keeps an error without a stack', () => {
    expect(isInjectedScriptError({ exception: { values: [{ type: 'Error', value: 'La' }] } })).toBe(false);
    expect(isInjectedScriptError({})).toBe(false);
  });
});
