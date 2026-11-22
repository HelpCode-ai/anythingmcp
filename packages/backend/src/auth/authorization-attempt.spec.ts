import {
  attemptKey,
  CONNECTED_PAGE_ARMS,
  connectedPageArm,
  signInPageArm,
  SIGNIN_PAGE_ARMS,
  deviceOf,
  languageBucket,
  pageLanguageFor,
  testArm,
} from './authorization-attempt';

describe('authorization attempt', () => {
  describe('attemptKey', () => {
    it('is the expiry of the pending authorization as a short base-36 number', () => {
      const key = attemptKey(1795305600000);
      expect(key).toBe((1795305600000).toString(36));
      expect(key).toMatch(/^[0-9a-z]{6,12}$/);
    });

    it('is undefined without an expiry', () => {
      for (const value of [undefined, null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(attemptKey(value as number)).toBeUndefined();
      }
    });
  });

  it('tells a phone or tablet from a computer by the user agent', () => {
    expect(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 26_6 like Mac OS X) Mobile/15E148 Safari/604.1')).toBe('mobile');
    expect(deviceOf('Mozilla/5.0 (Linux; Android 16; Pixel 9) Chrome/140.0.0.0 Mobile Safari/537.36')).toBe('mobile');
    expect(deviceOf('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0.0.0 Safari/537.36')).toBe('desktop');
    expect(deviceOf(undefined)).toBe('desktop');
  });

  describe('the arm of a page test', () => {
    const CLOUD = { cloud: true };
    const SPLIT = { cloud: true, setting: 'split' };

    it('is always the same for one pending authorization', () => {
      const first = connectedPageArm('session-1', SPLIT);
      for (let i = 0; i < 20; i++) expect(connectedPageArm('session-1', SPLIT)).toBe(first);
      expect(CONNECTED_PAGE_ARMS).toContain(first);
    });

    it("splits pending authorizations into equal parts with 'split'", () => {
      const counts: Record<string, number> = { control: 0, next_step: 0 };
      for (let i = 0; i < 4000; i++) counts[connectedPageArm(`session-${i}`, SPLIT) as string] += 1;
      expect(counts.control + counts.next_step).toBe(4000);
      // 50 % each; 4,000 draws stay within a few points of it.
      expect(counts.control).toBeGreaterThan(1800);
      expect(counts.next_step).toBeGreaterThan(1800);
    });

    it('splits three arms into thirds, each test on its own', () => {
      const arms = ['a', 'b', 'c'] as const;
      const counts: Record<string, number> = { a: 0, b: 0, c: 0 };
      let sameAsOther = 0;
      for (let i = 0; i < 6000; i++) {
        const arm = testArm('one-test', arms, `session-${i}`, CLOUD) as string;
        counts[arm] += 1;
        if (arm === testArm('another-test', arms, `session-${i}`, CLOUD)) sameAsOther += 1;
      }
      for (const arm of arms) expect(counts[arm]).toBeGreaterThan(1800);
      // Two tests do not move together: about a third of the sessions agree by chance.
      expect(sameAsOther).toBeLessThan(2400);
    });

    it('does not run on a self-hosted instance, whatever the setting', () => {
      expect(connectedPageArm('session-1', { cloud: false })).toBeNull();
      expect(connectedPageArm('session-1', { cloud: false, setting: 'next_step' })).toBeNull();
    });

    it('does not run without a pending authorization', () => {
      for (const sessionId of [undefined, null, '']) expect(connectedPageArm(sessionId, CLOUD)).toBeNull();
    });

    it("is turned off by 'off': the control page, and no arm recorded", () => {
      for (const setting of ['off', ' OFF ']) {
        for (let i = 0; i < 50; i++) expect(connectedPageArm(`session-${i}`, { cloud: true, setting })).toBeNull();
      }
    });

    it('gives everyone the arm the setting names', () => {
      for (const arm of CONNECTED_PAGE_ARMS) {
        for (let i = 0; i < 50; i++) expect(connectedPageArm(`session-${i}`, { cloud: true, setting: arm })).toBe(arm);
      }
    });

    it('gives everyone next_step when unset, and reads any other setting as unset', () => {
      for (const setting of ['', 'yes', 'on', 'variant', undefined, null]) {
        for (let i = 0; i < 50; i++) expect(connectedPageArm(`session-${i}`, { cloud: true, setting })).toBe('next_step');
      }
      expect(connectedPageArm('session-1', CLOUD)).toBe('next_step');
    });
  });

  describe('the arm of the sign-in page test', () => {
    it('splits pending authorizations into equal parts when unset, independently of the other test', () => {
      const counts: Record<string, number> = { control: 0, buttons_first: 0 };
      let same = 0;
      for (let i = 0; i < 4000; i++) {
        const arm = signInPageArm(`session-${i}`, { cloud: true }) as string;
        counts[arm] += 1;
        if ((arm === 'control') === (connectedPageArm(`session-${i}`, { cloud: true, setting: 'split' }) === 'control')) same += 1;
      }
      expect(counts.control).toBeGreaterThan(1800);
      expect(counts.buttons_first).toBeGreaterThan(1800);
      expect(same).toBeGreaterThan(1600);
      expect(same).toBeLessThan(2400);
    });

    it("is off with 'off', on self-hosted and without a pending authorization", () => {
      expect(signInPageArm('s', { cloud: true, setting: 'off' })).toBeNull();
      expect(signInPageArm('s', { cloud: false })).toBeNull();
      expect(signInPageArm(undefined, { cloud: true })).toBeNull();
    });

    it('gives everyone the arm the setting names', () => {
      for (const arm of SIGNIN_PAGE_ARMS) {
        for (let i = 0; i < 30; i++) expect(signInPageArm(`s-${i}`, { cloud: true, setting: arm })).toBe(arm);
      }
    });
  });

  describe('the language of the browser', () => {
    it('is the first of its languages a page of ours speaks', () => {
      expect(pageLanguageFor('de-AT,de;q=0.9,en;q=0.8')).toBe('de');
      expect(pageLanguageFor('fr-FR,fr;q=0.9,es;q=0.8,en;q=0.7')).toBe('es');
      expect(pageLanguageFor('en;q=0.5, ja;q=0.9')).toBe('ja');
      expect(pageLanguageFor('zh-CN')).toBe('zh');
      expect(pageLanguageFor(['ru-RU', 'en'])).toBe('ru');
    });

    it('is null when the browser names none of them, or nothing', () => {
      expect(pageLanguageFor('fr-FR,pt;q=0.8')).toBeNull();
      expect(pageLanguageFor('*')).toBeNull();
      expect(pageLanguageFor('en;q=0')).toBeNull();
      expect(pageLanguageFor(undefined)).toBeNull();
      expect(pageLanguageFor('')).toBeNull();
    });

    it("is bucketed for the events by the first choice: one of the seven, or 'other'", () => {
      expect(languageBucket('it-IT,it;q=0.9,en;q=0.8')).toBe('it');
      expect(languageBucket('fr-FR,fr;q=0.9,en;q=0.8')).toBe('other');
      expect(languageBucket('pt-BR')).toBe('other');
      expect(languageBucket(undefined)).toBeUndefined();
      expect(languageBucket('*')).toBeUndefined();
    });

    it('reads nothing out of a header that is no language list', () => {
      expect(languageBucket('<script>alert(1)</script>')).toBeUndefined();
      expect(pageLanguageFor('de'.repeat(5000))).toBeNull();
    });
  });
});
