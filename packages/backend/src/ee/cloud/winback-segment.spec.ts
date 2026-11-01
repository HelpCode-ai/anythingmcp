import {
  holdoutByte,
  holdoutValue,
  inWinbackHoldout,
  isBusinessConnector,
  isHoldoutValue,
  offerValue,
  winbackSegment,
} from './winback-segment';

describe('winbackSegment', () => {
  const seg = (adminEmails: string[], slugs: Array<string | undefined>, successfulCalls = 5) =>
    winbackSegment({ adminEmails, connectorConfigs: slugs.map((s) => (s ? { adapterSlug: s } : {})), successfulCalls });

  it('is unused without a successful call, whatever else', () => {
    expect(seg(['boss@acme.io'], ['etsy'], 0)).toBe('unused');
  });

  it('is business with a company address among the admins, or a business connector', () => {
    expect(seg(['ada@gmail.com', 'boss@acme.io'], [])).toBe('business');
    expect(seg(['ada@gmail.com'], ['etsy'])).toBe('business');
    expect(seg(['ada@gmail.com'], ['telegram-bot', 'odoo'])).toBe('business');
  });

  it('is telegram when every catalog connector is a Telegram bot', () => {
    expect(seg(['ada@gmail.com'], ['telegram-bot'])).toBe('telegram');
    // A custom connector says nothing either way.
    expect(seg(['ada@gmail.com'], ['telegram-bot', undefined])).toBe('telegram');
    expect(seg(['ada@gmail.com'], ['telegram-bot', 'todoist'])).toBe('consumer');
  });

  it('is consumer otherwise, Vinted sellers included', () => {
    expect(seg(['ada@gmail.com'], ['vinted'])).toBe('consumer');
    expect(seg(['ada@web.de'], [])).toBe('consumer');
    expect(seg(['ada@gmail.com'], [undefined])).toBe('consumer');
  });

  it('knows business connectors by catalog category, not by unknown slugs', () => {
    expect(isBusinessConnector({ adapterSlug: 'etsy' })).toBe(true);
    expect(isBusinessConnector({ adapterSlug: 'vinted' })).toBe(false);
    expect(isBusinessConnector({ adapterSlug: 'no-such-adapter' })).toBe(false);
    expect(isBusinessConnector(null)).toBe(false);
  });
});

describe('win-back holdout', () => {
  it('is the first byte of the salted hash, the same on every run', () => {
    expect(holdoutByte('org-h2')).toBe(5);
    expect(holdoutByte('org-h22')).toBe(33);
    expect(holdoutByte('org-h0')).toBe(169);
    expect(holdoutByte('org-h2')).toBe(holdoutByte('org-h2'));
  });

  it('holds out byte < 26 for business and byte < 51 for consumer and Telegram', () => {
    for (const s of ['business', 'consumer', 'telegram'] as const) expect(inWinbackHoldout('org-h2', s)).toBe(true);
    expect(inWinbackHoldout('org-h22', 'business')).toBe(false);
    expect(inWinbackHoldout('org-h22', 'consumer')).toBe(true);
    expect(inWinbackHoldout('org-h22', 'telegram')).toBe(true);
    for (const s of ['business', 'consumer', 'telegram'] as const) expect(inWinbackHoldout('org-h0', s)).toBe(false);
  });

  it('holds out unused workspaces in the 20% band too', () => {
    expect(inWinbackHoldout('org-h22', 'unused')).toBe(true);
    expect(inWinbackHoldout('org-h0', 'unused')).toBe(false);
  });

  it('holds about 10% and 20% over many ids', () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `org-${i}`);
    const share = (s: 'business' | 'consumer') => ids.filter((id) => inWinbackHoldout(id, s)).length / ids.length;
    expect(share('business')).toBeGreaterThan(0.08);
    expect(share('business')).toBeLessThan(0.12);
    expect(share('consumer')).toBeGreaterThan(0.17);
    expect(share('consumer')).toBeLessThan(0.23);
  });

  it('stores readable values', () => {
    expect(holdoutValue('business', true)).toBe('business:control');
    expect(holdoutValue('consumer', false)).toBe('consumer:treatment');
    expect(isHoldoutValue('telegram:control')).toBe(true);
    expect(isHoldoutValue('telegram:treatment')).toBe(false);
    expect(isHoldoutValue(null)).toBe(false);
    expect(offerValue('consumer', 'START30', 'blocked_calls')).toBe('consumer:START30:blocked_calls');
  });
});
