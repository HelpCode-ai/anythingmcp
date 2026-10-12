import { planRepair, scanConnector, type ConnectorRow, type ToolRow } from './secret-literal-scan.util';

const TG_SECRET = ['AAH', 'k3jd9QwErTyUiOp', 'AsDfGhJkLzXcVbN', 'm12'].join('');
const TG = `7123456789:${TG_SECRET}`;

const connector = (over: Partial<ConnectorRow> = {}): ConnectorRow => ({
  id: 'c1',
  organizationId: 'org1',
  name: 'My Telegram',
  type: 'REST',
  baseUrl: 'https://api.telegram.org',
  headers: null,
  config: null,
  envVars: null,
  ...over,
});

const tool = (over: Partial<ToolRow> = {}): ToolRow => ({
  id: 't1',
  connectorId: 'c1',
  name: 'send',
  description: 'Send',
  parameters: { type: 'object', properties: {} },
  endpointMapping: { method: 'POST', path: '/sendMessage' },
  ...over,
});

describe('scanConnector', () => {
  it('reports base URL, baseline, path, name and description, redacted', () => {
    const found = scanConnector(
      connector({
        baseUrl: `https://api.telegram.org/bot${TG}`,
        config: { adapterSlug: 'telegram-bot', baseUrlBaseline: `https://api.telegram.org/bot${TG}` },
      }),
      [
        tool({
          name: `post_bot${TG.replace(':', '_')}_sendMessage`.slice(0, 64),
          description: `POST /bot${TG}/sendMessage`,
          endpointMapping: { method: 'POST', path: `/bot${TG}/sendMessage` },
        }),
      ],
    );
    expect(found.map((f) => f.field).sort()).toEqual([
      'baseUrl',
      'config.baseUrlBaseline',
      'tool.description',
      'tool.name',
      'tool.path',
    ]);
    expect(found.every((f) => f.adapterSlug === 'telegram-bot' && f.workspaceId === 'org1')).toBe(true);
    expect(JSON.stringify(found)).not.toContain(TG_SECRET);
  });

  it('ignores clean and DATABASE connectors', () => {
    expect(scanConnector(connector(), [tool()])).toEqual([]);
    expect(
      scanConnector(connector({ type: 'DATABASE', baseUrl: `postgres://u:${TG}@h/db` }), [
        tool({ endpointMapping: { method: 'query', path: `SELECT '${TG}'` } }),
      ]),
    ).toEqual([]);
  });
});

describe('planRepair', () => {
  it('reuses the variable of a catalog install and cleans base URL and baseline', () => {
    const plan = planRepair(
      connector({
        baseUrl: `https://api.telegram.org/bot${TG}`,
        config: { adapterSlug: 'telegram-bot', baseUrlBaseline: `https://api.telegram.org/bot${TG}` },
        headers: { 'X-Api-Key': 'k1k2k3k4k5' },
        envVars: { TELEGRAM_BOT_TOKEN: TG },
      }),
      [tool()],
    )!;
    expect(plan.connector.baseUrl).toBe('https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}');
    expect(plan.connector.config).toEqual({
      adapterSlug: 'telegram-bot',
      baseUrlBaseline: 'https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}',
    });
    // Catalog headers are rebuilt from the template, not moved.
    expect(plan.connector.headers).toBeUndefined();
    expect(plan.connector.envVars).toBeUndefined();
    expect(plan.newVariables).toEqual([]);
    expect(plan.tools).toEqual([]);
  });

  it('adds a variable, rewrites the tool and keeps names unique', () => {
    const plan = planRepair(connector(), [
      tool({ id: 't0', name: 'post_bot_sendMessage' }),
      tool({
        id: 't1',
        name: `post_bot${TG.replace(':', '_')}_sendMessage`.slice(0, 64),
        endpointMapping: { method: 'POST', path: `/bot${TG}/sendMessage` },
      }),
    ])!;
    expect(plan.newVariables).toEqual(['TELEGRAM_BOT_TOKEN']);
    expect(plan.connector.envVars).toEqual({ TELEGRAM_BOT_TOKEN: TG });
    expect(plan.tools).toEqual([
      {
        id: 't1',
        changes: {
          name: 'post_bot_sendMessage_2',
          endpointMapping: { method: 'POST', path: '/bot{{TELEGRAM_BOT_TOKEN}}/sendMessage' },
        },
      },
    ]);
  });

  it('returns null when there is nothing to do', () => {
    expect(planRepair(connector(), [tool()])).toBeNull();
  });
});
