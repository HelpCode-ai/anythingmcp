import { looksLikeEmail } from './connectors.controller';

describe('looksLikeEmail', () => {
  it('recognises e-mail addresses', () => {
    expect(looksLikeEmail('someone@example.com')).toBe(true);
    expect(looksLikeEmail('first.last@mail.example.co.uk')).toBe(true);
  });

  it('does not flag keys', () => {
    expect(looksLikeEmail('a1b2c3d4-KEY')).toBe(false);
    expect(looksLikeEmail('key@nodot')).toBe(false);
    expect(looksLikeEmail('@example.com')).toBe(false);
    expect(looksLikeEmail('a@b@example.com')).toBe(false);
    expect(looksLikeEmail('someone@example.')).toBe(false);
    expect(looksLikeEmail('some one@example.com')).toBe(false);
  });

  it('stays linear on the input CodeQL flagged for the old regex', () => {
    const crafted = '!@!.' + '!.'.repeat(50_000);
    const started = Date.now();
    looksLikeEmail(crafted);
    expect(Date.now() - started).toBeLessThan(50);
  });
});
