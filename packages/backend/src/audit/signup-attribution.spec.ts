import { classifyTouch, clickIdFromAttribution, sanitizeSignupAttribution } from './signup-attribution';

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
      {
        first_touch: { utm_source: 'google', paid: true, ts: NOW - 1000, gclid: 'Cj0-a_b', ad_consent: 'granted' },
        last_touch: { referrer_host: 'github.com', ad_consent: 'denied' },
      },
      NOW,
    );
    expect(once?.first_touch?.gclid).toBe('Cj0-a_b');
    expect(sanitizeSignupAttribution(once, NOW)).toEqual(once);
  });
});

describe('click ids and ad consent', () => {
  const NOW = Date.parse('2026-09-27T10:00:00Z');
  const IDS = { gclid: 'Cj0KCQjw-abc_DEF', gbraid: 'Gb-1_x', wbraid: 'Wb_2-y' };

  it('keeps click ids only when the touch says ad consent was granted', () => {
    const out = sanitizeSignupAttribution({ first_touch: { ...IDS, ad_consent: 'granted' } }, NOW);
    expect(out?.first_touch).toEqual({ ...IDS, ad_consent: 'granted', paid: true, channel: 'google_ads' });
  });

  it.each([['denied'], ['unknown'], [undefined], ['GRANTED'], [true]])(
    'drops them when ad consent is %p',
    (adConsent) => {
      const out = sanitizeSignupAttribution(
        { first_touch: { utm_source: 'google', ...IDS, ad_consent: adConsent } },
        NOW,
      );
      expect(out?.first_touch?.gclid).toBeUndefined();
      expect(out?.first_touch?.gbraid).toBeUndefined();
      expect(out?.first_touch?.wbraid).toBeUndefined();
      expect(JSON.stringify(out)).not.toContain('Cj0KCQ');
    },
  );

  it('decides per touch: consent on the first touch does not carry over to the last', () => {
    const out = sanitizeSignupAttribution(
      {
        first_touch: { gclid: 'first-id', ad_consent: 'granted' },
        last_touch: { gclid: 'last-id', utm_source: 'google' },
      },
      NOW,
    );
    expect(out?.first_touch?.gclid).toBe('first-id');
    expect(out?.last_touch).toEqual({ utm_source: 'google', channel: 'referral' });
  });

  it.each([
    ['a dot', 'Cj0.KCQ'],
    ['a space', 'Cj0 KCQ'],
    ['an address', 'jane@example.com'],
    ['a query string', 'abc&utm_source=x'],
    ['151 characters', 'a'.repeat(151)],
    ['an empty string', '  '],
  ])('drops a click id with %s even with consent', (_label, gclid) => {
    const out = sanitizeSignupAttribution({ first_touch: { gclid, ad_consent: 'granted', utm_source: 'google' } }, NOW);
    expect(out?.first_touch?.gclid).toBeUndefined();
    expect(out?.first_touch?.paid).toBeUndefined();
  });

  it('keeps a 150-character click id', () => {
    const gclid = 'a'.repeat(150);
    const out = sanitizeSignupAttribution({ first_touch: { gclid, ad_consent: 'granted' } }, NOW);
    expect(out?.first_touch?.gclid).toBe(gclid);
  });
});

describe('clickIdFromAttribution', () => {
  it('prefers the last touch, and returns a single id: gclid before gbraid before wbraid', () => {
    expect(
      clickIdFromAttribution({
        first_touch: { gclid: 'first', ad_consent: 'granted', ts: '2026-09-20T10:00:00.000Z' },
        last_touch: { wbraid: 'w-last', gbraid: 'g-last', ad_consent: 'granted', ts: '2026-09-21T10:00:00.000Z' },
      }),
    ).toEqual({ gbraid: 'g-last', ad_consent: 'granted', captured_at: '2026-09-21T10:00:00.000Z' });
  });

  it('falls back to the first touch when the last carries none', () => {
    expect(
      clickIdFromAttribution({
        first_touch: { gclid: 'first', ad_consent: 'granted' },
        last_touch: { referrer_host: 'chatgpt.com' },
      }),
    ).toEqual({ gclid: 'first', ad_consent: 'granted' });
  });

  it('never returns an id from a stored touch without granted consent', () => {
    expect(clickIdFromAttribution({ first_touch: { gclid: 'legacy-row' } })).toBeNull();
    expect(clickIdFromAttribution({ last_touch: { gclid: 'x', ad_consent: 'denied' } })).toBeNull();
    expect(clickIdFromAttribution({ first_touch: { gclid: 'bad.id', ad_consent: 'granted' } })).toBeNull();
    expect(clickIdFromAttribution(null)).toBeNull();
    expect(clickIdFromAttribution([{ gclid: 'x', ad_consent: 'granted' }])).toBeNull();
  });
});
