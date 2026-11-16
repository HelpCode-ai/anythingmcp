import { deriveResultHint, TELEGRAM_NO_UPDATES_HINT } from './result-hints';

describe('deriveResultHint', () => {
  const telegram = (args: Record<string, unknown>, result: unknown) =>
    deriveResultHint({ adapterSlug: 'telegram-bot', toolName: 'telegram_bot_get_updates', args, result });

  it('explains an empty Telegram read', () => {
    expect(telegram({}, { ok: true, result: [] })).toBe(TELEGRAM_NO_UPDATES_HINT);
    expect(telegram({ limit: 10, timeout: 0 }, { ok: true, result: [] })).toBe(TELEGRAM_NO_UPDATES_HINT);
  });

  it('says nothing when messages came back', () => {
    expect(telegram({}, { ok: true, result: [{ update_id: 1, message: { text: 'hi' } }] })).toBeUndefined();
  });

  it('says nothing to a polling loop that confirms updates with offset', () => {
    expect(telegram({ offset: 812, timeout: 20 }, { ok: true, result: [] })).toBeUndefined();
    expect(telegram({ offset: 0 }, { ok: true, result: [] })).toBeUndefined();
  });

  it('says nothing for other tools, other adapters and other shapes', () => {
    expect(
      deriveResultHint({ adapterSlug: 'telegram-bot', toolName: 'telegram_bot_get_me', args: {}, result: { ok: true, result: [] } }),
    ).toBeUndefined();
    expect(
      deriveResultHint({ toolName: 'telegram_bot_get_updates', args: {}, result: { ok: true, result: [] } }),
    ).toBeUndefined();
    expect(telegram({}, [])).toBeUndefined();
    expect(telegram({}, { ok: false, result: [] })).toBeUndefined();
    expect(telegram({}, null)).toBeUndefined();
  });

  it('tells the assistant what the user has to do, in words it can pass on', () => {
    expect(TELEGRAM_NO_UPDATES_HINT).toMatch(/pressed Start/);
    expect(TELEGRAM_NO_UPDATES_HINT).toMatch(/telegram_bot_get_me/);
    expect(TELEGRAM_NO_UPDATES_HINT).toMatch(/cannot read the user's own Telegram chats/);
  });
});
