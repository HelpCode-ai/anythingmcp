import { CONSUMER_EMAIL_DOMAINS, isConsumerEmail } from './consumer-email-domains';

describe('isConsumerEmail', () => {
  it('recognises the big free mailbox providers', () => {
    for (const email of [
      'ada@gmail.com',
      'ada@googlemail.com',
      'ada@yahoo.co.uk',
      'ada@hotmail.it',
      'ada@outlook.de',
      'ada@icloud.com',
      'ada@gmx.net',
      'ada@web.de',
      'ada@t-online.de',
      'ada@libero.it',
      'ada@proton.me',
      'ada@qq.com',
      'ada@seznam.cz',
    ]) {
      expect(isConsumerEmail(email)).toBe(true);
    }
  });

  it('ignores case and surrounding whitespace', () => {
    expect(isConsumerEmail('Ada.Lovelace@GMail.COM')).toBe(true);
    expect(isConsumerEmail('ada@gmail.com ')).toBe(true);
  });

  it('treats company domains as business', () => {
    expect(isConsumerEmail('ada@kochfreiburg.de')).toBe(false);
    expect(isConsumerEmail('ada@anythingmcp.com')).toBe(false);
  });

  it('matches the exact domain only, never a subdomain or a look-alike', () => {
    expect(isConsumerEmail('ada@mail.gmail.com')).toBe(false);
    expect(isConsumerEmail('ada@gmail.com.example.org')).toBe(false);
    expect(isConsumerEmail('ada@notgmail.com')).toBe(false);
    expect(isConsumerEmail('ada@yahoo.ca')).toBe(false);
  });

  it('refuses malformed or empty input', () => {
    expect(isConsumerEmail('')).toBe(false);
    expect(isConsumerEmail(null)).toBe(false);
    expect(isConsumerEmail(undefined)).toBe(false);
    expect(isConsumerEmail('gmail.com')).toBe(false);
    expect(isConsumerEmail('@gmail.com')).toBe(false);
  });

  it('keeps every entry lower-case and without an @', () => {
    for (const domain of CONSUMER_EMAIL_DOMAINS) {
      expect(domain).toBe(domain.toLowerCase());
      expect(domain).not.toContain('@');
    }
  });
});
