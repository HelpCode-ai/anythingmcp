import { classifyTouch, sanitizeSignupAttribution } from './signup-attribution';

describe('classifyTouch', () => {
  it.each([
    [{ paid: true as const }, 'google_ads'],
    [{ gad_source: '1', referrer_host: 'google.com' }, 'google_ads'],
    [{ utm_source: 'google', utm_medium: 'cpc' }, 'google_ads'],
    [{ utm_source: 'linkedin', utm_medium: 'paid_social' }, 'paid_other'],
    [{ utm_source: 'chatgpt.com' }, 'ai_assistant'],
    [{ referrer_host: 'perplexity.ai' }, 'ai_assistant'],
    [{ referrer_host: 'claude.ai' }, 'ai_assistant'],
    [{ referrer_host: 'gemini.google.com' }, 'ai_assistant'],
    [{ referrer_host: 'github.com' }, 'github'],
    [{ utm_source: 'github', utm_medium: 'readme' }, 'github'],
    [{ referrer_host: 'google.de' }, 'organic_google'],
    [{ referrer_host: 'google.co.uk' }, 'organic_google'],
    [{ referrer_host: 'bing.com' }, 'organic_search'],
    [{ referrer_host: 'duckduckgo.com' }, 'organic_search'],
    [{ referrer_host: 'news.ycombinator.com' }, 'social'],
    [{ referrer_host: 'linkedin.com' }, 'social'],
    [{ utm_medium: 'newsletter', utm_source: 'brevo' }, 'email'],
    [{ referrer_host: 'anythingmcp.com' }, 'website'],
    [{ referrer_host: 'dev.to' }, 'referral'],
    [{ landing_path: '/login', captured_on: 'cloud' as const }, 'direct'],
  ])('%j is %s', (touch, channel) => {
    expect(classifyTouch(touch)).toBe(channel);
  });
});

describe('sanitizeSignupAttribution', () => {
  const NOW = Date.parse('2026-09-27T10:00:00Z');

  it('returns null when there is no touch to record', () => {
    expect(sanitizeSignupAttribution(undefined, NOW)).toBeNull();
    expect(sanitizeSignupAttribution({}, NOW)).toBeNull();
    expect(sanitizeSignupAttribution({ first_touch: { gclid: 'x', email: 'a@b.c' } }, NOW)).toBeNull();
    expect(sanitizeSignupAttribution([{ utm_source: 'x' }], NOW)).toBeNull();
  });

  it('drops a timestamp from a broken clock but keeps the touch', () => {
    const out = sanitizeSignupAttribution(
      { first_touch: { utm_source: 'google', ts: NOW + 7 * 86_400_000 } },
      NOW,
    );
    expect(out?.first_touch).toEqual({ utm_source: 'google', channel: 'referral' });
  });

  it('is idempotent: sanitizing stored metadata changes nothing', () => {
    const once = sanitizeSignupAttribution(
      { first_touch: { utm_source: 'google', paid: true, ts: NOW - 1000 }, last_touch: { referrer_host: 'github.com' } },
      NOW,
    );
    expect(sanitizeSignupAttribution(once, NOW)).toEqual(once);
  });
});
