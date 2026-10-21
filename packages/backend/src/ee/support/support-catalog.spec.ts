import { catalogMentions, catalogMentionsLine } from './support-catalog';

describe('catalogMentions', () => {
  it('finds a catalog connector named in a message, in any language', () => {
    expect(catalogMentions('Please connect with telegram').map((m) => m.slug)).toContain('telegram-bot');
    expect(catalogMentions('Как подключить Telegram бот?').map((m) => m.slug)).toContain('telegram-bot');
  });

  it('needs every word of a multi-word name', () => {
    const slugs = catalogMentions('my google account').map((m) => m.slug);
    expect(slugs).not.toContain('google-ads');
    expect(catalogMentions('Google Ads report').map((m) => m.slug)).toContain('google-ads');
  });

  it('finds nothing in a message that names no app', () => {
    expect(catalogMentions('Что мне делать?')).toEqual([]);
    expect(catalogMentions('')).toEqual([]);
  });

  it('names the setup page in the prompt line', () => {
    expect(catalogMentionsLine([{ slug: 'telegram-bot', name: 'Telegram Bot' }])).toContain(
      'Telegram Bot (/connectors/setup/telegram-bot)',
    );
    expect(catalogMentionsLine([])).toMatch(/none found/);
  });
});
