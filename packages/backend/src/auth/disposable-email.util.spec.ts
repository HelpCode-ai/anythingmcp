import { isDisposableEmail } from './disposable-email.util';

describe('isDisposableEmail', () => {
  it.each(['lala@yopmail.com', 'x@mailinator.com', 'someone@uberip.com', 'A@YOPMAIL.COM', 'a@yopmail.com.'])(
    'flags %s',
    (email) => expect(isDisposableEmail(email)).toBe(true),
  );

  it('flags a subdomain of a throwaway domain', () => {
    expect(isDisposableEmail('a@inbox.yopmail.com')).toBe(true);
  });

  it.each([
    'jane@gmail.com',
    'jane@outlook.com',
    'jane@icloud.com',
    'jane@proton.me',
    'jane@gmx.de',
    'abc123@privaterelay.appleid.com',
    'abc.123@simplelogin.com',
    'abc@mozmail.com',
    'abc@duck.com',
    'matteo@helpcode.ai',
  ])('accepts %s', (email) => expect(isDisposableEmail(email)).toBe(false));

  it('does not match on a suffix that is not a whole label', () => {
    expect(isDisposableEmail('a@notyopmail.com')).toBe(false);
  });

  it('answers false for input without a domain', () => {
    expect(isDisposableEmail('no-at-sign')).toBe(false);
  });
});
