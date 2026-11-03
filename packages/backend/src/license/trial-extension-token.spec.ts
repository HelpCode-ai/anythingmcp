import { createTrialExtensionToken, readTrialExtensionToken } from './trial-extension-token';

describe('trial extension token', () => {
  const SECRET = 'jwt-secret';
  const ENDED = new Date('2026-11-01T10:00:00Z');
  const DAY = 24 * 60 * 60 * 1000;

  it('names its workspace until 7 days after the trial ended', () => {
    const token = createTrialExtensionToken('org-1', ENDED, SECRET)!;
    expect(readTrialExtensionToken(token, SECRET, new Date(ENDED.getTime() + DAY))).toEqual({ ok: true, organizationId: 'org-1' });
    expect(readTrialExtensionToken(token, SECRET, new Date(ENDED.getTime() + 7 * DAY - 1000))).toMatchObject({ ok: true });
  });

  it('is expired from then on', () => {
    const token = createTrialExtensionToken('org-1', ENDED, SECRET)!;
    expect(readTrialExtensionToken(token, SECRET, new Date(ENDED.getTime() + 7 * DAY))).toEqual({ ok: false, reason: 'expired' });
  });

  it('cannot be moved to another workspace, given a later expiry, or signed with another key', () => {
    const token = createTrialExtensionToken('org-1', ENDED, SECRET)!;
    const [, expiry, signature] = token.split('.');
    const now = new Date(ENDED.getTime() + DAY);
    expect(readTrialExtensionToken(`org-2.${expiry}.${signature}`, SECRET, now)).toEqual({ ok: false, reason: 'invalid' });
    expect(readTrialExtensionToken(`org-1.${Number(expiry) + 86400}.${signature}`, SECRET, now)).toEqual({ ok: false, reason: 'invalid' });
    expect(readTrialExtensionToken(token, 'other-secret', now)).toEqual({ ok: false, reason: 'invalid' });
    expect(readTrialExtensionToken(`${token.slice(0, -2)}xx`, SECRET, now)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses anything that is not a token', () => {
    for (const bad of [undefined, null, 42, '', 'a.b', 'org-1.abc.sig', 'x'.repeat(400), 'org 1.123.sig']) {
      expect(readTrialExtensionToken(bad, SECRET)).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(createTrialExtensionToken('bad id', ENDED, SECRET)).toBeNull();
  });
});
