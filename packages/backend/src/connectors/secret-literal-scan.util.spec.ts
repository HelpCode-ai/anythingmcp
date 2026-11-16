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

  it('ignores a clean connector', () => {
    expect(scanConnector(connector(), [tool()])).toEqual([]);
  });

  describe('a DATABASE connector', () => {
    const STORED = 'postgresql://app:s3cret@db.example.com:5432/shop';

    it('finds a password still in the connection string, redacted', () => {
      const found = scanConnector(connector({ type: 'DATABASE', baseUrl: STORED }), []);
      expect(found).toEqual([
        {
          connectorId: 'c1',
          workspaceId: 'org1',
          field: 'baseUrl',
          kind: 'database_url_password',
          pattern: 'postgresql://app:********@db.example.com:5432/shop',
          adapterSlug: null,
        },
      ]);
      expect(JSON.stringify(found)).not.toContain('s3cret');
    });

    it('finds nothing once the password has moved out of the URL', () => {
      expect(
        scanConnector(connector({ type: 'DATABASE', baseUrl: 'postgresql://db.example.com:5432/shop' }), []),
      ).toEqual([]);
    });

    it('does not inspect tools: the connection string is the only field that can carry a password', () => {
      expect(
        scanConnector(connector({ type: 'DATABASE', baseUrl: 'postgresql://db.example.com:5432/shop' }), [
          tool({ endpointMapping: { method: 'query', path: "SELECT * FROM t WHERE p = 's3cret'" } }),
        ]),
      ).toEqual([]);
    });
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

  describe('a DATABASE connector', () => {
    const STORED = 'postgresql://app:s3cret@db.example.com:5432/shop';

    it('moves the credentials into authConfig when it holds neither', () => {
      const plan = planRepair(connector({ type: 'DATABASE', baseUrl: STORED, authConfig: null }), [])!;
      expect(plan.connector.baseUrl).toBe('postgresql://db.example.com:5432/shop');
      expect(plan.connector.authConfig).toEqual({ username: 'app', password: 's3cret' });
      expect(plan.tools).toEqual([]);
    });

    it.each([
      ['mssql', 'mssql://sa:n3w@sql.example.com:1433/shop', 'mssql://sql.example.com:1433/shop', { username: 'sa', password: 'n3w' }],
      ['oracle', 'oracle://app:s3cret@ora.example.com:1521/orcl', 'oracle://ora.example.com:1521/orcl', { username: 'app', password: 's3cret' }],
      ['hana', 'hana://app:s3cret@hana.example.com:30015/shop', 'hana://hana.example.com:30015/shop', { username: 'app', password: 's3cret' }],
    ])('moves credentials out of a %s URL the same way', (_driver, baseUrl, cleaned, authConfig) => {
      const plan = planRepair(connector({ type: 'DATABASE', baseUrl, authConfig: null }), [])!;
      expect(plan.connector.baseUrl).toBe(cleaned);
      expect(plan.connector.authConfig).toEqual(authConfig);
    });

    it('does nothing when authConfig already holds a username or password', () => {
      // Which one wins then differs by driver (pg/mysql/mongo prefer the URL's
      // username, mssql/oracle/hana prefer authConfig), so moving here could
      // change who connects — the same rule the live API follows.
      expect(
        planRepair(connector({ type: 'DATABASE', baseUrl: STORED, authConfig: { username: 'other' } }), []),
      ).toBeNull();
    });

    it('does nothing once the password has already moved out of the URL', () => {
      expect(
        planRepair(
          connector({ type: 'DATABASE', baseUrl: 'postgresql://db.example.com:5432/shop', authConfig: null }),
          [],
        ),
      ).toBeNull();
    });

    it('does nothing for a connection string it cannot parse', () => {
      // A multi-host MongoDB URL: DatabaseEngine puts authConfig's credentials
      // back into it at call time, so leaving it as it is keeps connecting.
      expect(
        planRepair(
          connector({
            type: 'DATABASE',
            baseUrl: 'mongodb://app:s3cret@m1.example.com:27017,m2.example.com:27017/shop',
            authConfig: null,
          }),
          [],
        ),
      ).toBeNull();
    });
  });
});
