import { createEmailLinkToken, readEmailLinkToken, withEmailLinkToken } from './email-link-token';

const env = { EMAIL_LINK_SECRET: 'spec-shared-secret' };
const NOW = new Date('2026-10-15T00:00:00Z');
const DAY = 86_400_000;

describe('email link token (format of the licence site)', () => {
  // Minted by the site's own lib/email-link-token.ts with the same secret and
  // time: if this stops decoding, the site no longer reads our links.
  const SITE_TOKEN = 'Ad2qf35_BVmscygPUUYeVWzbAP82NSoR1OfIGsxQvT2nG_8IugDnOP3LdRfM3-jFsx0XiKxj6oVRLMexlWtiz0fqWp-1';

  it('reads a token the site minted', () => {
    expect(readEmailLinkToken(SITE_TOKEN, NOW, env)).toBe('buyer@example.com');
  });

  it('round-trips a lower-cased, trimmed address', () => {
    const token = createEmailLinkToken('  Buyer@Example.com ', NOW, env);
    expect(token).toMatch(/^[A-Za-z0-9_-]{20,1024}$/);
    expect(readEmailLinkToken(token, NOW, env)).toBe('buyer@example.com');
  });

  it('expires after 45 days', () => {
    const token = createEmailLinkToken('a@example.com', NOW, env);
    expect(readEmailLinkToken(token, new Date(NOW.getTime() + 44 * DAY), env)).toBe('a@example.com');
    expect(readEmailLinkToken(token, new Date(NOW.getTime() + 46 * DAY), env)).toBeNull();
  });

  it('is not readable with another secret, nor once altered', () => {
    const token = createEmailLinkToken('a@example.com', NOW, env)!;
    expect(readEmailLinkToken(token, NOW, { EMAIL_LINK_SECRET: 'other' })).toBeNull();
    const flipped = token.slice(0, 30) + (token[30] === 'A' ? 'B' : 'A') + token.slice(31);
    expect(readEmailLinkToken(flipped, NOW, env)).toBeNull();
  });

  it('makes no token without EMAIL_LINK_SECRET or without an address', () => {
    expect(createEmailLinkToken('a@example.com', NOW, {})).toBeNull();
    // The site's fallback to its Stripe key does not apply here.
    expect(createEmailLinkToken('a@example.com', NOW, { STRIPE_SECRET_KEY: 'sk_live_x' })).toBeNull();
    expect(createEmailLinkToken('', NOW, env)).toBeNull();
    expect(createEmailLinkToken(null, NOW, env)).toBeNull();
  });

  it('puts the token in the fragment, replacing any there', () => {
    expect(withEmailLinkToken('https://anythingmcp.com/pricing?promo=X', 'tok')).toBe(
      'https://anythingmcp.com/pricing?promo=X#t=tok',
    );
    expect(withEmailLinkToken('https://anythingmcp.com/pricing#old', 'tok')).toBe('https://anythingmcp.com/pricing#t=tok');
    expect(withEmailLinkToken('https://anythingmcp.com/pricing', null)).toBe('https://anythingmcp.com/pricing');
  });
});
