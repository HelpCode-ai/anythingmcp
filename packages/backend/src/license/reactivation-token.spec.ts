import { createReactivationToken, readReactivationToken, REACTIVATION_LINK_TTL_DAYS } from './reactivation-token';
import {
  reactivationLinkVariant,
  trialReactivationLink,
  trialReactivationUrl,
  trialReactivationUrlFor,
} from './license-checkout';

const ENV = { ENCRYPTION_KEY: 'k'.repeat(20) + 'Zq81-reactivation-test-key' };
const NOW = new Date('2026-11-07T10:00:00Z');
const DAY = 86_400_000;

describe('reactivation token', () => {
  it('round-trips the workspace and the user', () => {
    const token = createReactivationToken({ organizationId: 'org_1', userId: 'user-1' }, NOW, ENV)!;
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(readReactivationToken(token, NOW, ENV)).toEqual({ organizationId: 'org_1', userId: 'user-1' });
  });

  it('works without a user', () => {
    const token = createReactivationToken({ organizationId: 'org_1' }, NOW, ENV)!;
    expect(readReactivationToken(token, NOW, ENV)).toEqual({ organizationId: 'org_1', userId: null });
  });

  it('holds no readable id', () => {
    const token = createReactivationToken({ organizationId: 'cmorg123456', userId: 'cmuser98765' }, NOW, ENV)!;
    const raw = Buffer.from(token, 'base64url').toString('latin1');
    expect(raw).not.toContain('cmorg123456');
    expect(raw).not.toContain('cmuser98765');
  });

  it(`expires after ${REACTIVATION_LINK_TTL_DAYS} days`, () => {
    const token = createReactivationToken({ organizationId: 'org_1' }, NOW, ENV)!;
    const almost = new Date(NOW.getTime() + REACTIVATION_LINK_TTL_DAYS * DAY - 1000);
    const after = new Date(NOW.getTime() + REACTIVATION_LINK_TTL_DAYS * DAY + 1000);
    expect(readReactivationToken(token, almost, ENV)).not.toBeNull();
    expect(readReactivationToken(token, after, ENV)).toBeNull();
  });

  it('refuses an altered token', () => {
    const token = createReactivationToken({ organizationId: 'org_1' }, NOW, ENV)!;
    const raw = Buffer.from(token, 'base64url');
    for (const at of [0, 5, raw.length - 20, raw.length - 1]) {
      const bad = Buffer.from(raw);
      bad[at] ^= 0x01;
      expect(readReactivationToken(bad.toString('base64url'), NOW, ENV)).toBeNull();
    }
    expect(readReactivationToken(token.slice(0, -2), NOW, ENV)).toBeNull();
  });

  it('refuses a token made with another key', () => {
    const other = createReactivationToken({ organizationId: 'org_1' }, NOW, {
      ENCRYPTION_KEY: 'another-key-of-enough-length-1234567890',
    })!;
    expect(readReactivationToken(other, NOW, ENV)).toBeNull();
  });

  it('refuses oversized, malformed and non-string tokens', () => {
    expect(readReactivationToken('A'.repeat(600), NOW, ENV)).toBeNull();
    expect(readReactivationToken('short', NOW, ENV)).toBeNull();
    expect(readReactivationToken('not a token at all, has spaces', NOW, ENV)).toBeNull();
    expect(readReactivationToken(undefined, NOW, ENV)).toBeNull();
    expect(readReactivationToken({}, NOW, ENV)).toBeNull();
  });

  it('makes and reads nothing without a usable ENCRYPTION_KEY', () => {
    expect(createReactivationToken({ organizationId: 'org_1' }, NOW, {})).toBeNull();
    expect(createReactivationToken({ organizationId: 'org_1' }, NOW, { ENCRYPTION_KEY: 'short' })).toBeNull();
    const token = createReactivationToken({ organizationId: 'org_1' }, NOW, ENV)!;
    expect(readReactivationToken(token, NOW, {})).toBeNull();
  });

  it('refuses an invalid workspace id', () => {
    expect(createReactivationToken({ organizationId: '' }, NOW, ENV)).toBeNull();
    expect(createReactivationToken({ organizationId: 'a/b' }, NOW, ENV)).toBeNull();
  });
});

describe('reactivationLinkVariant', () => {
  it('is fixed per workspace', () => {
    for (let i = 0; i < 50; i++) {
      expect(reactivationLinkVariant(`org-${i}`)).toBe(reactivationLinkVariant(`org-${i}`));
    }
  });

  it('gives every workspace the page since the test ended', () => {
    for (let i = 0; i < 1_000; i++) expect(reactivationLinkVariant(`cm${i.toString(36)}xyz`)).toBe('page');
  });
});

describe('trialReactivationUrlFor', () => {
  const env = { ...ENV, FRONTEND_URL: 'https://cloud.test/', MARKETING_URL: 'https://site.test' } as any;
  // Every workspace is in the 'page' arm since the test ended (2026-11-17).
  const orgOf = (_variant: 'page') => 'org-1';

  it("links a 'page' workspace to the no-login page with a token for it and the user", () => {
    const org = orgOf('page');
    const link = trialReactivationLink(org, 'user-1', env);
    expect(link.variant).toBe('page');
    const m = link.url.match(/^https:\/\/cloud\.test\/reactivate\/([A-Za-z0-9_-]+)$/);
    expect(m).not.toBeNull();
    expect(readReactivationToken(m![1], new Date(), env)).toEqual({ organizationId: org, userId: 'user-1' });
    expect(trialReactivationUrlFor(org, 'user-1', env)).toMatch(/^https:\/\/cloud\.test\/reactivate\//);
    expect(link.url).not.toMatch(/email|@/i);
  });

  it("falls back to the pricing page, counted as 'pricing', when no token can be made", () => {
    const org = orgOf('page');
    const noKey = { FRONTEND_URL: 'https://cloud.test', MARKETING_URL: 'https://site.test' } as any;
    expect(trialReactivationLink(org, 'user-1', noKey)).toEqual({
      url: trialReactivationUrl(noKey),
      variant: 'pricing',
    });
  });
});
