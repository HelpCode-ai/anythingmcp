import { Logger } from '@nestjs/common';
import { DynamicMcpTools } from './dynamic-mcp-tools';
import type { RegisteredTool } from './tool-registry';
import { getAdapter } from '../adapters/catalog';

/**
 * A Telegram send with no chat in the call and no default chat on the
 * connector is refused before the request is sent, with the fix in words.
 */
describe('DynamicMcpTools: required env defaults', () => {
  const catalogTool = getAdapter('telegram-bot')!.tools.find((t) => t.name === 'telegram_bot_send_message')!;

  function telegramTool(envVars: Record<string, string>): RegisteredTool {
    return {
      id: 'tool-tg',
      connectorId: 'conn-tg',
      organizationId: 'org-1',
      name: catalogTool.name,
      description: catalogTool.description,
      parameters: JSON.parse(JSON.stringify(catalogTool.parameters)),
      connectorType: 'REST',
      connectorConfig: {
        baseUrl: 'https://api.telegram.example/bot{{TELEGRAM_BOT_TOKEN}}',
        authType: 'NONE',
        envVars: { TELEGRAM_BOT_TOKEN: '123:abc', ...envVars },
        config: { adapterSlug: 'telegram-bot' },
      },
      endpointMapping: JSON.parse(JSON.stringify(catalogTool.endpointMapping)),
    } as unknown as RegisteredTool;
  }

  function build(tool: RegisteredTool, rest: jest.Mock) {
    const audit = { logInvocation: jest.fn().mockResolvedValue(undefined) };
    const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn(), incr: jest.fn(), expire: jest.fn(), ttl: jest.fn() };
    const unexpected = { execute: jest.fn().mockRejectedValue(new Error('unexpected engine')) };
    const executor = new DynamicMcpTools(
      { getTool: () => tool, getToolForOrg: () => tool } as any,
      audit as any,
      redis as any,
      { checkLicenseActive: jest.fn().mockResolvedValue(undefined) } as any,
      { isCloud: () => false } as any,
      {} as any,
      { execute: rest } as any,
      unexpected as any,
      unexpected as any,
      unexpected as any,
      unexpected as any,
      { scheduleObservationalIngest: jest.fn() } as any,
      { recentEvents: jest.fn().mockResolvedValue([]) } as any,
    );
    return { executor, audit };
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('refuses a send with no chat and no default chat without calling Telegram', async () => {
    const rest = jest.fn().mockResolvedValue({ ok: true });
    const { executor, audit } = build(telegramTool({ TELEGRAM_DEFAULT_CHAT_ID: '' }), rest);
    const res: any = await executor.executeTool('telegram_bot_send_message', { text: 'hello' });

    expect(rest).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    const detail = JSON.parse(res.content[0].text);
    expect(detail.code).toBe('MISSING_ARGUMENT');
    expect(detail.error).toMatch(/TELEGRAM_DEFAULT_CHAT_ID is empty/);
    expect(detail.error).toMatch(/no request was sent to Telegram/);
    expect(audit.logInvocation.mock.calls[0][0]).toMatchObject({ status: 'ERROR' });
  });

  it('refuses an explicit empty chat_id when there is no default chat', async () => {
    const rest = jest.fn().mockResolvedValue({ ok: true });
    const { executor } = build(telegramTool({}), rest);
    const res: any = await executor.executeTool('telegram_bot_send_message', { text: 'hello', chat_id: '' });
    expect(rest).not.toHaveBeenCalled();
    expect(JSON.parse(res.content[0].text).code).toBe('MISSING_ARGUMENT');
  });

  it('sends to the default chat when one is set', async () => {
    const rest = jest.fn().mockResolvedValue({ ok: true });
    const { executor } = build(telegramTool({ TELEGRAM_DEFAULT_CHAT_ID: '4242' }), rest);
    const res: any = await executor.executeTool('telegram_bot_send_message', { text: 'hello' });
    expect(res.isError).toBeFalsy();
    expect(rest).toHaveBeenCalledTimes(1);
    expect(rest.mock.calls[0][2]).toMatchObject({ chat_id: '4242', text: 'hello' });
  });

  it('sends to the chat the call names', async () => {
    const rest = jest.fn().mockResolvedValue({ ok: true });
    const { executor } = build(telegramTool({ TELEGRAM_DEFAULT_CHAT_ID: '' }), rest);
    const res: any = await executor.executeTool('telegram_bot_send_message', { text: 'hello', chat_id: '777' });
    expect(res.isError).toBeFalsy();
    expect(rest.mock.calls[0][2]).toMatchObject({ chat_id: '777' });
  });
});
