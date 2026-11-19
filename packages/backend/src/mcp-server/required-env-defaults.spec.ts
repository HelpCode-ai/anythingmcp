import { getAdapter } from '../adapters/catalog';
import { MissingDefaultArgumentError, missingRequiredDefault } from './required-env-defaults';

describe('missingRequiredDefault', () => {
  const telegramSend = getAdapter('telegram-bot')!.tools.find((t) => t.name === 'telegram_bot_send_message')!;

  it('refuses a Telegram send whose chat_id stayed empty after the defaults', () => {
    for (const chatId of [undefined, null, '', '   ']) {
      const refusal = missingRequiredDefault('telegram-bot', telegramSend.endpointMapping, { text: 'hi', chat_id: chatId });
      expect(refusal).toBeInstanceOf(MissingDefaultArgumentError);
      expect(refusal!.code).toBe('MISSING_ARGUMENT');
      expect(refusal!.param).toBe('chat_id');
      expect(refusal!.message).toMatch(/TELEGRAM_DEFAULT_CHAT_ID is empty/);
      expect(refusal!.message).toMatch(/no request was sent to Telegram/);
      expect(refusal!.message).toMatch(/telegram_bot_get_updates/);
    }
  });

  it('lets a Telegram send with a chat through', () => {
    expect(missingRequiredDefault('telegram-bot', telegramSend.endpointMapping, { text: 'hi', chat_id: '12345' })).toBeUndefined();
  });

  it('leaves a tool alone whose installed mapping names no default for the parameter', () => {
    const { envDefaults: _dropped, ...older } = telegramSend.endpointMapping as Record<string, unknown>;
    expect(missingRequiredDefault('telegram-bot', older, { text: 'hi' })).toBeUndefined();
  });

  it('does not refuse an optional envDefaults parameter of another adapter (Mirakl shop_id)', () => {
    const mirakl = getAdapter('mirakl')!.tools.find((t) => (t.endpointMapping as any)?.envDefaults?.shop_id)!;
    expect(mirakl).toBeDefined();
    expect(missingRequiredDefault('mirakl', mirakl.endpointMapping, {})).toBeUndefined();
    expect(missingRequiredDefault(undefined, telegramSend.endpointMapping, {})).toBeUndefined();
  });

  it('covers every Telegram tool that fills chat_id from the default chat', () => {
    const withDefault = getAdapter('telegram-bot')!.tools.filter(
      (t) => (t.endpointMapping as any)?.envDefaults?.chat_id === 'TELEGRAM_DEFAULT_CHAT_ID',
    );
    expect(withDefault.length).toBeGreaterThan(10);
    for (const tool of withDefault) {
      expect(missingRequiredDefault('telegram-bot', tool.endpointMapping, {})?.param).toBe('chat_id');
    }
  });
});
