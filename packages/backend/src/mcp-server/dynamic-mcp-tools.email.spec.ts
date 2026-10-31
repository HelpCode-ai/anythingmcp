import { Logger } from '@nestjs/common';
import { DynamicMcpTools } from './dynamic-mcp-tools';
import type { RegisteredTool } from './tool-registry';
import { BINARY_MARKER } from '../connectors/binary-response.util';

/** An EMAIL tool call over MCP reaches the email engine with resolved settings. */
function build(tool: RegisteredTool, result: unknown) {
  const emailEngine = { execute: jest.fn().mockResolvedValue(result) };
  const reject = { execute: jest.fn().mockRejectedValue(new Error('wrong engine')) };
  const executor = new DynamicMcpTools(
    { getTool: () => tool, getToolForOrg: () => tool } as any,
    { logInvocation: jest.fn().mockResolvedValue(undefined) } as any,
    { get: jest.fn().mockResolvedValue(null), set: jest.fn() } as any,
    { checkLicenseActive: jest.fn().mockResolvedValue(undefined) } as any,
    { isCloud: () => false } as any,
    {} as any,
    reject as any,
    reject as any,
    reject as any,
    reject as any,
    reject as any,
    { scheduleObservationalIngest: jest.fn() } as any,
    { recentEvents: jest.fn().mockResolvedValue([]) } as any,
    reject as any,
    undefined,
    emailEngine as any,
  );
  return { executor, emailEngine };
}

const tool = (method: string): RegisteredTool => ({
  id: 't1',
  connectorId: 'c1',
  organizationId: 'org-1',
  name: `imap_smtp_${method}`,
  description: 'x',
  parameters: { type: 'object', properties: {} },
  connectorType: 'EMAIL',
  connectorConfig: {
    baseUrl: 'imap://imap.ionos.de:993',
    authType: 'BASIC_AUTH',
    authConfig: JSON.stringify({ username: 'anna@example.com', password: '{{EMAIL_PASSWORD}}' }),
    envVars: { EMAIL_IMAP_HOST: 'imap.ionos.de', EMAIL_PASSWORD: 'Secret-Value-123' },
    config: { email: { imapHost: '{{EMAIL_IMAP_HOST}}', toolPrefix: 'imap_smtp' } },
  } as any,
  endpointMapping: { method: `email_${method}`, path: '' },
});

describe('DynamicMcpTools with EMAIL connectors', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });
  afterAll(() => jest.restoreAllMocks());

  it('passes the resolved settings and login to the email engine', async () => {
    const { executor, emailEngine } = build(tool('search'), { folder: 'INBOX', total: 0, messages: [] });
    const res = await executor.executeTool('imap_smtp_search', { from: 'bob' });
    expect(res.isError).toBeUndefined();
    const [config, mapping, params, settings] = emailEngine.execute.mock.calls[0];
    expect(config).toMatchObject({ authConfig: { username: 'anna@example.com', password: 'Secret-Value-123' } });
    expect(mapping).toMatchObject({ method: 'email_search' });
    expect(params).toMatchObject({ from: 'bob' });
    expect(settings).toEqual({ imapHost: 'imap.ionos.de', toolPrefix: 'imap_smtp' });
  });

  it('hands an attachment to the client as an embedded file', async () => {
    const pdf = Buffer.from('%PDF-1.7 fake').toString('base64');
    const { executor } = build(tool('get_attachment'), {
      [BINARY_MARKER]: 1,
      contentType: 'application/pdf',
      bytes: 13,
      filename: 'Rechnung.pdf',
      base64: pdf,
    });
    const res = (await executor.executeTool('imap_smtp_get_attachment', { uid: 1, index: 1 })) as any;
    expect(res.content[1]).toEqual({
      type: 'resource',
      resource: { uri: 'file:///Rechnung.pdf', mimeType: 'application/pdf', blob: pdf },
    });
  });
});
