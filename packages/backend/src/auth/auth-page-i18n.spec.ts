// `openid-client` is ESM-only; login.controller reaches it through SsoService.
jest.mock('openid-client', () => ({}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { PAGE_LANGUAGES, type PageLanguage } from './authorization-attempt';
import { fill, plural, SCRIPT_FILL, scriptTexts, SIGN_IN_TEXTS } from './auth-page-i18n';
import {
  EMAIL_CODE_TEXTS,
  LOGIN_ERROR_TEXTS,
  loginErrorParam,
  loginErrorParamForText,
  loginErrorText,
  orList,
  SERVER_PICKER_TEXTS,
} from './auth-page-i18n.steps';
import { CONNECTED_PAGE_TEXTS } from './auth-page-i18n.connected';
import { TELEGRAM_PANEL_TEXTS, telegramAnswerText } from './auth-page-i18n.telegram';
import { EDGE_PAGE_TEXTS } from './auth-page-i18n.pages';
import { FILE_SEARCH_SETUP_OPTIONS, finishSetupRequest, FIRST_CONNECTOR_EXAMPLE, WRONG_WORKSPACE_MESSAGE } from './login.controller';
import { TELEGRAM_CONNECTED_REQUEST } from '../adapters/telegram-managed-bot';

/**
 * The dictionaries of the authorization pages (auth-page-i18n*.ts), checked
 * as data: every language says the same things with the same placeholders
 * and the same markup as English, and nothing in a text can break out of
 * where it is written (HTML, an attribute, an inline script).
 */

const DICTIONARIES: Record<string, Record<PageLanguage, unknown>> = {
  'sign-in page': SIGN_IN_TEXTS,
  'e-mail code step': EMAIL_CODE_TEXTS,
  'server picker': SERVER_PICKER_TEXTS,
  'sign-in messages': LOGIN_ERROR_TEXTS,
  'page after approving': CONNECTED_PAGE_TEXTS,
  'Telegram panel': TELEGRAM_PANEL_TEXTS,
  'closed, rate limit, cancelled, File Search': EDGE_PAGE_TEXTS,
};

/** Every text of a dictionary, by its path (`js.added`). */
function flatten(value: unknown, path = ''): Record<string, string> {
  if (typeof value === 'string') return { [path]: value };
  const out: Record<string, string> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    Object.assign(out, flatten(child, path ? `${path}.${key}` : key));
  }
  return out;
}

const placeholders = (text: string) => [...new Set(text.match(/\{\w+\}/g) ?? [])].sort();
const tags = (text: string) => (text.match(/<\/?[a-z][^>]*>/gi) ?? []).sort();
const OTHERS = PAGE_LANGUAGES.filter((lang) => lang !== 'en');

describe.each(Object.entries(DICTIONARIES))('the texts of the %s', (_name, table) => {
  const english = flatten(table.en);

  it('exist for the seven languages', () => {
    expect(Object.keys(table).sort()).toEqual([...PAGE_LANGUAGES].sort());
    expect(Object.keys(english).length).toBeGreaterThan(0);
  });

  it.each(OTHERS)('%s has every key of English, and no other', (lang) => {
    expect(Object.keys(flatten(table[lang])).sort()).toEqual(Object.keys(english).sort());
  });

  it.each(OTHERS)('%s keeps every placeholder of the English text', (lang) => {
    const texts = flatten(table[lang]);
    for (const [key, text] of Object.entries(english)) {
      expect({ key, placeholders: placeholders(texts[key]) }).toEqual({ key, placeholders: placeholders(text) });
    }
  });

  it.each(OTHERS)('%s has the markup of the English text, and nothing else', (lang) => {
    const texts = flatten(table[lang]);
    for (const [key, text] of Object.entries(english)) {
      // <strong> where English has it; a plain text stays plain in every language.
      expect({ key, tags: tags(texts[key]) }).toEqual({ key, tags: tags(text) });
    }
  });

  it.each(PAGE_LANGUAGES)('%s has no empty text and nothing that could leave its place in the page', (lang) => {
    for (const [key, text] of Object.entries(flatten(table[lang]))) {
      const where = `${lang} ${key}`;
      // The two list separators are spaces and a comma: everything else says something.
      expect({ where, empty: text.trim() === '' && !/Sep$|Last$|Or$/.test(key) }).toEqual({ where, empty: false });
      expect({ where, script: /<\s*\/?\s*script/i.test(text) }).toEqual({ where, script: false });
      // Some texts are written into attributes (placeholder, alt, aria-label).
      expect({ where, quote: text.includes('"') }).toEqual({ where, quote: false });
      // The only tags are the ones English has (checked above); the only entity is &amp;.
      expect({ where, entity: /&(?!amp;)/.test(text) }).toEqual({ where, entity: false });
      expect({ where, angle: /[<>]/.test(text.replace(/<\/?strong>|<\/?b>/g, '')) }).toEqual({ where, angle: false });
      // Line and paragraph separators end a line of script source.
      expect({ where, separator: /[\u2028\u2029]/.test(text) }).toEqual({ where, separator: false });
    }
  });

  it.each(OTHERS)('%s is a translation, not a copy of English', (lang) => {
    const texts = flatten(table[lang]);
    const same = Object.keys(english).filter((key) => texts[key] === english[key] && /[a-z]{4,} [a-z]{4,}/.test(english[key]));
    // Product names and protocol lists are the same everywhere; sentences are not.
    expect(same).toEqual([]);
  });
});

describe('the English texts are the texts the pages always had', () => {
  it('for the constants other code and specs use', () => {
    expect(LOGIN_ERROR_TEXTS.en.wrongWorkspace).toBe(WRONG_WORKSPACE_MESSAGE);
    expect(WRONG_WORKSPACE_MESSAGE).toBe(
      'The MCP server you are connecting belongs to another workspace, and this account is not a member of it. ' +
        'Sign in with an account of that workspace, or ask its admin to invite you. ' +
        'If you do not need this connection, remove it from your AI client.',
    );
    expect(FIRST_CONNECTOR_EXAMPLE).toBe('Connect my Telegram bot to AnythingMCP.');
    expect(finishSetupRequest('Etsy')).toBe('Finish setting up my Etsy connector.');
    expect(finishSetupRequest('Etsy', 'de')).toBe('Schließe die Einrichtung meines Etsy-Connectors ab.');
    expect(TELEGRAM_PANEL_TEXTS.en.answers.request).toBe(TELEGRAM_CONNECTED_REQUEST);
  });

  it('for the File Search options that are words', () => {
    const { optionLabels, optionHints } = EDGE_PAGE_TEXTS.en.fileSearch;
    for (const [id, label] of Object.entries(optionLabels)) {
      expect(FILE_SEARCH_SETUP_OPTIONS.find((o) => o.id === id)?.label).toBe(label);
    }
    for (const [id, hint] of Object.entries(optionHints)) {
      expect(FILE_SEARCH_SETUP_OPTIONS.find((o) => o.id === id)?.hint).toBe(hint);
    }
    // Every option that is not a protocol or product name has its words in the dictionary.
    const named = new Set(['SFTP', 'FTPS', 'FTP', 'WebDAV', 'Nextcloud', 'ownCloud', 'Synology NAS', 'QNAP NAS', 'FRITZ!Box', 'Hetzner Storage Box']);
    const hintsThatAreNames = new Set(['WebDAV', 'SFTP', 'FTPS', 'AWS S3, DigitalOcean Spaces, MinIO, Wasabi']);
    for (const option of FILE_SEARCH_SETUP_OPTIONS) {
      if (!named.has(option.label)) expect(Object.keys(optionLabels)).toContain(option.id);
      if (!hintsThatAreNames.has(option.hint)) expect(Object.keys(optionHints)).toContain(option.id);
    }
  });

  // Two services answer in English and the pages find their messages in the
  // dictionaries by that text. If a service changes a sentence, the page
  // would silently show English: these fail first.
  const source = (file: string) => readFileSync(join(__dirname, file), 'utf8');

  it('for what the Telegram token service answers', () => {
    const service = source('../adapters/telegram-managed-bot.service.ts');
    const { unavailable, expiredContinue, alreadyConnected, notATokenStrict, checkFailed, notSaved } = TELEGRAM_PANEL_TEXTS.en.answers;
    for (const text of [unavailable, expiredContinue, alreadyConnected, notATokenStrict, checkFailed, notSaved]) {
      expect(service).toContain(`'${text}'`);
    }
  });

  it('for what a sign-in with a provider can end in', () => {
    const service = source('./social/social-auth.service.ts');
    const E = LOGIN_ERROR_TEXTS.en;
    for (const text of [
      E.socialFailed,
      E.optionUnavailable,
      E.authorizationExpired,
      E.linkExpired,
      E.otherBrowser,
      E.cancelled,
      E.providerFailed,
      E.ssoRequired,
      E.noWorkspace,
      E.ambiguousEmail,
      E.registrationClosed,
      E.disposableEmail,
    ]) {
      expect(service).toContain(`'${text}'`);
    }
    // The three that name the provider are template strings there.
    for (const text of [E.providerNoEmail, E.providerUnverified, E.alreadyLinked]) {
      expect(service).toContain(`\`${text.replace(/\{provider\}/g, '${adapter.label}')}\``);
    }
  });
});

describe('fill and plural', () => {
  it('fills placeholders once and leaves an unknown one visible', () => {
    expect(fill('{a} and {b}', { a: '{b}', b: 'x' })).toBe('{b} and x');
    expect(fill('{missing}', {})).toBe('{missing}');
  });

  it('counts connectors the way each language does', () => {
    const count = (lang: PageLanguage, n: number) => plural(SERVER_PICKER_TEXTS[lang].connectors, lang, n);
    expect([0, 1, 2].map((n) => count('en', n))).toEqual(['0 connectors', '1 connector', '2 connectors']);
    expect([0, 1, 2].map((n) => count('de', n))).toEqual(['0 Connectors', '1 Connector', '2 Connectors']);
    expect([1, 2, 5, 11, 21, 22, 25].map((n) => count('ru', n))).toEqual([
      '1 коннектор',
      '2 коннектора',
      '5 коннекторов',
      '11 коннекторов',
      '21 коннектор',
      '22 коннектора',
      '25 коннекторов',
    ]);
    expect(count('ja', 3)).toBe('コネクタ 3 件');
    expect(count('zh', 1)).toBe('1 个连接器');
  });
});

describe('texts in an inline script', () => {
  const HOSTILE = {
    a: '</script><script>alert(1)</script>',
    b: 'quote " and \' and backslash \\ and \\u0041',
    c: 'line\u2028separator\u2029s & <!-- comment -->',
    d: 'Telegram を接続しました。{seconds} 秒後に {client} に戻ります…',
  };

  it('are written as a literal that cannot end the script element or a line of it', () => {
    const literal = scriptTexts(HOSTILE);
    expect(literal).not.toMatch(/[<>&\u2028\u2029]/);
    expect(literal).not.toContain('\n');
    // And it is the same object when a browser reads it.
    const read = require('vm').runInNewContext(`(${literal})`);
    expect({ ...read }).toEqual(HOSTILE);
  });

  it('are filled in the browser like on the server', () => {
    const run = (text: string, values: Record<string, unknown>) =>
      require('vm').runInNewContext(`(function () { ${SCRIPT_FILL} return fill(text, values); })()`, { text, values });
    expect(run('{name} added — you’ll finish it in {client}.', { name: 'Etsy', client: 'Claude' })).toBe(
      'Etsy added — you’ll finish it in Claude.',
    );
    // Values are never read again as text with placeholders, and "$&" means nothing.
    expect(run('{app} / {client}', { app: '{client} $& $1', client: 'C' })).toBe('{client} $& $1 / C');
    expect(run('{seconds} s, {missing}, {constructor}', { seconds: 5 })).toBe('5 s, {missing}, {constructor}');
  });

  it.each(PAGE_LANGUAGES)('%s: every script text survives the way into the page', (lang) => {
    for (const texts of [CONNECTED_PAGE_TEXTS[lang].js, TELEGRAM_PANEL_TEXTS[lang].js]) {
      const literal = scriptTexts(texts);
      expect(literal).not.toMatch(/[<>&\u2028\u2029]/);
      expect({ ...require('vm').runInNewContext(`(${literal})`) }).toEqual(texts);
    }
  });
});

describe('the message of a redirect to the sign-in page', () => {
  const PROVIDERS = [
    { id: 'google', name: 'Google' },
    { id: 'microsoft', name: 'Microsoft' },
    { id: 'github', name: 'GitHub' },
  ];

  it('travels as a key and is written in the language of the page', () => {
    expect(loginErrorParam('sessionExpired')).toBe('sessionExpired');
    expect(loginErrorText('sessionExpired', 'en', [])).toBe('Your session expired. Please try again.');
    expect(loginErrorText('sessionExpired', 'de', [])).toBe('Ihre Sitzung ist abgelaufen. Bitte versuchen Sie es erneut.');
    expect(loginErrorText('sessionExpired', 'ja', [])).toBe('セッションの有効期限が切れました。もう一度お試しください。');
    for (const lang of PAGE_LANGUAGES) {
      for (const key of Object.keys(LOGIN_ERROR_TEXTS.en)) {
        if (key === 'listSep' || key === 'listOr') continue;
        const text = loginErrorText(key, lang, PROVIDERS);
        expect(text).not.toBe(key);
        expect(text).not.toMatch(/\{\w+\}/);
      }
    }
  });

  it('still reads the English text an older redirect carried, and translates it', () => {
    expect(loginErrorText('Your session expired. Please try again.', 'de', [])).toBe(
      'Ihre Sitzung ist abgelaufen. Bitte versuchen Sie es erneut.',
    );
    expect(loginErrorText(WRONG_WORKSPACE_MESSAGE, 'it', [])).toBe(LOGIN_ERROR_TEXTS.it.wrongWorkspace);
    const old =
      'That email and password do not match. If you signed up with Google, Microsoft or GitHub, use that button instead. New here? Create an account first.';
    expect(loginErrorText(old, 'en', PROVIDERS)).toBe(old);
    expect(loginErrorText(old, 'de', PROVIDERS)).toContain('mit Google, Microsoft oder GitHub registriert');
  });

  it('shows any other text as it is', () => {
    for (const text of ['Something else went wrong.', 'sessionExpired!', 'listSep', 'listOr', 'toString', 'constructor', '<b>x</b>']) {
      expect(loginErrorText(text, 'de', PROVIDERS)).toBe(text);
    }
  });

  it('names the provider buttons the page has, in the list form of the language', () => {
    expect(orList([], LOGIN_ERROR_TEXTS.en)).toBe('');
    expect(orList(['Google'], LOGIN_ERROR_TEXTS.en)).toBe('Google');
    expect(orList(['Google', 'Microsoft'], LOGIN_ERROR_TEXTS.en)).toBe('Google or Microsoft');
    expect(loginErrorText('signInFailed', 'es', PROVIDERS)).toContain('con Google, Microsoft o GitHub,');
    expect(loginErrorText('signInFailed', 'ru', PROVIDERS)).toContain('через Google, Microsoft или GitHub,');
    expect(loginErrorText('signInFailed', 'zh', PROVIDERS)).toContain('通过 Google、Microsoft 或 GitHub 注册');
    expect(loginErrorText('signInFailed', 'ja', PROVIDERS)).toContain('Google、Microsoft または GitHub で登録');
    // No buttons to name: the short answer, in the language of the page.
    expect(loginErrorText('signInFailed', 'de', [])).toBe('E-Mail oder Passwort ungültig');
  });

  it('carries the provider of a message that names one by its id', () => {
    const english = 'Your Google account did not share a verified email address. Sign up with your email address instead.';
    expect(loginErrorParamForText(english, PROVIDERS)).toBe(encodeURIComponent('providerNoEmail:google'));
    expect(loginErrorText('providerNoEmail:google', 'en', PROVIDERS)).toBe(english);
    expect(loginErrorText('providerNoEmail:google', 'de', PROVIDERS)).toBe(
      'Ihr Google-Konto hat keine bestätigte E-Mail-Adresse übermittelt. Registrieren Sie sich stattdessen mit Ihrer E-Mail-Adresse.',
    );
    expect(loginErrorText('alreadyLinked:github', 'it', PROVIDERS)).toBe('Il tuo account è già collegato a un altro account GitHub.');
    // A provider this page does not have: the general message, never a broken sentence.
    expect(loginErrorText('providerNoEmail:evil', 'de', PROVIDERS)).toBe(LOGIN_ERROR_TEXTS.de.socialFailed);
    expect(loginErrorText('providerNoEmail', 'de', PROVIDERS)).toBe(LOGIN_ERROR_TEXTS.de.socialFailed);
  });

  it('turns an English message of the social sign-in service into its key, and leaves an unknown one as text', () => {
    expect(loginErrorParamForText('Sign-in was cancelled.', PROVIDERS)).toBe('cancelled');
    expect(loginErrorParamForText('This sign-in option is not available right now.', PROVIDERS)).toBe('optionUnavailableNow');
    expect(loginErrorParamForText('A new message nobody translated yet.', PROVIDERS)).toBe(
      encodeURIComponent('A new message nobody translated yet.'),
    );
  });
});

describe('an answer of the Telegram token route', () => {
  it('is the same message in the language of the page', () => {
    expect(telegramAnswerText('Telegram is already connected.', 'de')).toBe('Telegram ist bereits verbunden.');
    expect(telegramAnswerText('Telegram is already connected.', 'en')).toBe('Telegram is already connected.');
    expect(telegramAnswerText('Telegram is already connected.', null)).toBe('Telegram is already connected.');
  });

  it("stays as it comes when it is Telegram's own refusal", () => {
    expect(telegramAnswerText('Telegram refused the bot token.', 'ja')).toBe('Telegram refused the bot token.');
  });
});
