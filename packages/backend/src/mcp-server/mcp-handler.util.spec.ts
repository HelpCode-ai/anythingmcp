import { Logger } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/server';
import {
  createQuietMcpHandler,
  JSON_MODE_WARNING_PREFIX,
  resetJsonModeWarningForTests,
} from './mcp-handler.util';

/**
 * The SDK printed its JSON-mode warning once per handler, and the endpoint
 * builds a handler per request: 61k lines a day in the cloud log.
 */
describe('createQuietMcpHandler', () => {
  const factory = () => new McpServer({ name: 't', version: '1' });
  let warn: jest.SpyInstance;
  let nestWarn: jest.SpyInstance;

  beforeEach(() => {
    resetJsonModeWarningForTests();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    nestWarn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('logs the JSON-mode warning once per process, however many handlers are built', async () => {
    for (let i = 0; i < 5; i++) {
      await createQuietMcpHandler(factory, { legacy: 'stateless', responseMode: 'json' }).close();
    }
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining(JSON_MODE_WARNING_PREFIX));
    expect(nestWarn).toHaveBeenCalledTimes(1);
    expect(nestWarn).toHaveBeenCalledWith(expect.stringContaining(JSON_MODE_WARNING_PREFIX));
  });

  it('puts console.warn back, and lets every other warning through', async () => {
    const before = console.warn;
    await createQuietMcpHandler(factory, { responseMode: 'json' }).close();
    expect(console.warn).toBe(before);
    console.warn('something else');
    expect(warn).toHaveBeenCalledWith('something else');
  });

  it('leaves SSE handlers untouched', async () => {
    const before = console.warn;
    await createQuietMcpHandler(factory, { responseMode: 'sse' }).close();
    expect(console.warn).toBe(before);
    expect(nestWarn).not.toHaveBeenCalled();
  });
});
