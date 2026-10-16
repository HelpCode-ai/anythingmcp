import { Client } from 'pg';
import { report } from '../../scripts/secret-literals/report';
import { repair } from '../../scripts/secret-literals/repair';
import { encrypt } from '../common/crypto/encryption.util';
import { openEnvVarsStrict, sealEnvVars } from '../common/crypto/env-vars-at-rest';

/**
 * The report and repair scripts against a real Postgres with the app's
 * schema (all migrations applied). Gated: set SECRET_REPAIR_TEST_DATABASE_URL
 * to a throwaway, migrated database, e.g. a PGlite socket server:
 *
 *   node node_modules/@electric-sql/pglite-socket/dist/scripts/server.js --port=55512 &
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55512/postgres npx prisma migrate deploy
 *   SECRET_REPAIR_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55512/postgres \
 *     npx jest secret-literal-repair.integration
 *
 * It only touches rows of its own organization and drops them afterwards.
 */
const DB_URL = process.env.SECRET_REPAIR_TEST_DATABASE_URL;
const d = DB_URL ? describe : describe.skip;

const KEY = 'f'.repeat(48);
const ORG = 'org-secret-fixture';
const USER = 'user-secret-fixture';
const TG_SECRET = ['AAH', 'k3jd9QwErTyUiOp', 'AsDfGhJkLzXcVbN', 'm12'].join('');
const TG = `7123456789:${TG_SECRET}`;
const GOOGLE = ['AI', 'zaSyB1x2y3z4A5B6C7D8E9F0gHiJkLmNoPqRs'].join('');

d('secret literal report + repair (real Postgres)', () => {
  let client: Client;
  const lines: string[] = [];
  const out = (line: string) => lines.push(line);

  async function connector(id: string, values: Record<string, unknown>) {
    await client.query(
      `INSERT INTO connectors (id, user_id, organization_id, name, type, base_url, headers, config, env_vars, updated_at)
       VALUES ($1, $2, $3, $4, $5::"ConnectorType", $6, $7::jsonb, $8::jsonb, $9::jsonb, now())`,
      [
        id,
        USER,
        ORG,
        values.name,
        values.type ?? 'REST',
        values.baseUrl,
        values.headers === undefined ? null : JSON.stringify(values.headers),
        values.config === undefined ? null : JSON.stringify(values.config),
        values.envVars === undefined ? null : JSON.stringify(values.envVars),
      ],
    );
  }

  async function tool(id: string, connectorId: string, name: string, endpointMapping: unknown, description = 'x') {
    await client.query(
      `INSERT INTO mcp_tools (id, connector_id, name, description, parameters, endpoint_mapping, updated_at)
       VALUES ($1, $2, $3, $4, '{"type":"object","properties":{}}'::jsonb, $5::jsonb, now())`,
      [id, connectorId, name, description, JSON.stringify(endpointMapping)],
    );
  }

  async function cleanup() {
    await client.query(`DELETE FROM mcp_tools WHERE connector_id IN (SELECT id FROM connectors WHERE organization_id = $1)`, [ORG]);
    await client.query(`DELETE FROM connectors WHERE organization_id = $1`, [ORG]);
    await client.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await client.query(`DELETE FROM organizations WHERE id = $1`, [ORG]);
    const backups = await client.query(`SELECT tablename FROM pg_tables WHERE tablename LIKE 'secret_literal_repair_backup_%'`);
    for (const row of backups.rows) await client.query(`DROP TABLE ${row.tablename}`);
  }

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = KEY;
    client = new Client({ connectionString: DB_URL });
    await client.connect();
    await cleanup();
    await client.query(`INSERT INTO organizations (id, name, updated_at) VALUES ($1, 'Fixture', now())`, [ORG]);
    await client.query(
      `INSERT INTO users (id, email, organization_id, updated_at) VALUES ($1, 'fixture@example.com', $2, now())`,
      [USER, ORG],
    );

    // A catalog Telegram install from before the fix: token resolved into the base URL.
    await connector('c-tg-catalog', {
      name: 'Telegram Bot API',
      baseUrl: `https://api.telegram.org/bot${TG}`,
      config: { adapterSlug: 'telegram-bot', baseUrlBaseline: `https://api.telegram.org/bot${TG}` },
      envVars: sealEnvVars({ TELEGRAM_BOT_TOKEN: TG }),
    });
    await tool('t-tg-catalog', 'c-tg-catalog', 'telegram_bot_get_me', { method: 'GET', path: '/getMe' });

    // The hand-built connector of the incident: token in the path, name and description.
    await connector('c-tg-custom', { name: 'My Telegram', baseUrl: 'https://api.telegram.org' });
    await tool(
      't-tg-custom',
      'c-tg-custom',
      `post_bot${TG.replace(':', '_')}_sendMessage`.slice(0, 64),
      { method: 'POST', path: `/bot${TG}/sendMessage`, bodyMapping: { text: '$text' } },
      `POST /bot${TG}/sendMessage`,
    );

    // A key in the query string and a literal credential header, with another variable already set.
    await connector('c-maps', {
      name: 'Maps',
      baseUrl: `https://maps.example.com/api?key=${GOOGLE}`,
      headers: { 'X-Api-Key': 'k1k2k3k4k5', Accept: 'application/json' },
      envVars: sealEnvVars({ REGION: 'eu' }),
    });

    // Nothing to do here.
    await connector('c-clean', { name: 'Clean', baseUrl: 'https://api.example.com/v1' });
    await tool('t-clean', 'c-clean', 'list_items', { method: 'GET', path: '/items/{id}' });
    await connector('c-db', { name: 'DB', type: 'DATABASE', baseUrl: 'postgres://u:p@db.example.com/x' });
    await tool('t-db', 'c-db', 'q', { method: 'query', path: `SELECT '${TG}'` });

    // Variables encrypted with another key: must be skipped, never overwritten.
    await connector('c-badkey', {
      name: 'Bad key',
      baseUrl: `https://api.telegram.org/bot${TG}`,
      envVars: { $enc: encrypt(JSON.stringify({ A: 'b' }), 'z'.repeat(48), 'connectors.env_vars') },
    });
  });

  afterAll(async () => {
    if (client) {
      await cleanup();
      await client.end();
    }
  });

  beforeEach(() => {
    lines.length = 0;
  });

  it('report: counts the findings, prints no secret, writes nothing', async () => {
    const findings = (await report(client, out)).filter((f) => f.workspaceId === ORG);
    const byConnector = (id: string) => findings.filter((f) => f.connectorId === id).map((f) => f.field).sort();
    expect(byConnector('c-tg-catalog')).toEqual(['baseUrl', 'config.baseUrlBaseline']);
    expect(byConnector('c-tg-custom')).toEqual(['tool.description', 'tool.name', 'tool.path']);
    expect(byConnector('c-maps')).toEqual(['baseUrl', 'headers.X-Api-Key']);
    expect(byConnector('c-clean')).toEqual([]);
    expect(byConnector('c-db')).toEqual([]);
    const text = lines.join('\n');
    expect(text).not.toContain(TG_SECRET);
    expect(text).not.toContain(GOOGLE);
    expect(text).not.toContain('k1k2k3k4k5');
    const stored = await client.query(`SELECT base_url FROM connectors WHERE id = 'c-tg-catalog'`);
    expect(stored.rows[0].base_url).toContain(TG_SECRET);
  });

  it('repair dry run: plans every fix, writes nothing', async () => {
    const result = await repair(client, { workspaceId: ORG, out });
    expect(result.plans.map((p) => p.connectorId).sort()).toEqual(['c-maps', 'c-tg-catalog', 'c-tg-custom']);
    expect(result.skipped).toEqual([{ connectorId: 'c-badkey', reason: expect.stringMatching(/could not be decrypted/) }]);
    expect(lines.join('\n')).not.toContain(TG_SECRET);
    const tables = await client.query(`SELECT 1 FROM pg_tables WHERE tablename LIKE 'secret_literal_repair_backup_%'`);
    expect(tables.rowCount).toBe(0);
    const stored = await client.query(`SELECT name FROM mcp_tools WHERE id = 't-tg-custom'`);
    expect(stored.rows[0].name).toContain('7123456789');
  });

  it('repair --apply: backs up, rewrites, keeps every variable, and is idempotent', async () => {
    const result = await repair(client, { workspaceId: ORG, apply: true, backupSuffix: 'fixture', out });
    expect(result.backupTable).toBe('secret_literal_repair_backup_fixture');

    const backup = await client.query(`SELECT kind, id, base_url FROM secret_literal_repair_backup_fixture ORDER BY kind, id`);
    expect(backup.rows.map((r) => `${r.kind}:${r.id}`)).toEqual([
      'connector:c-maps',
      'connector:c-tg-catalog',
      'connector:c-tg-custom',
      'tool:t-tg-custom',
    ]);
    expect(backup.rows.find((r) => r.id === 'c-tg-catalog').base_url).toContain(TG_SECRET);

    const rows = Object.fromEntries(
      (await client.query(`SELECT id, base_url, headers, config, env_vars FROM connectors WHERE organization_id = $1`, [ORG])).rows.map(
        (r) => [r.id, r],
      ),
    );
    // Catalog Telegram: same variable reused, nothing added.
    expect(rows['c-tg-catalog'].base_url).toBe('https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}');
    expect(rows['c-tg-catalog'].config.baseUrlBaseline).toBe('https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}');
    expect(rows['c-tg-catalog'].config.adapterSlug).toBe('telegram-bot');
    expect(openEnvVarsStrict(rows['c-tg-catalog'].env_vars)).toEqual({ TELEGRAM_BOT_TOKEN: TG });

    // Custom Telegram: a new, encrypted variable.
    expect(rows['c-tg-custom'].env_vars.$enc).toEqual(expect.any(String));
    expect(JSON.stringify(rows['c-tg-custom'].env_vars)).not.toContain(TG_SECRET);
    expect(openEnvVarsStrict(rows['c-tg-custom'].env_vars)).toEqual({ TELEGRAM_BOT_TOKEN: TG });
    const t = (await client.query(`SELECT name, description, endpoint_mapping FROM mcp_tools WHERE id = 't-tg-custom'`)).rows[0];
    expect(t.name).toBe('post_bot_sendMessage');
    expect(t.description).toBe('POST /bot{{TELEGRAM_BOT_TOKEN}}/sendMessage');
    expect(t.endpoint_mapping).toEqual({ method: 'POST', path: '/bot{{TELEGRAM_BOT_TOKEN}}/sendMessage', bodyMapping: { text: '$text' } });

    // Maps: existing variable kept, two added.
    expect(rows['c-maps'].base_url).toBe('https://maps.example.com/api?key={{MAPS_API_KEY}}');
    expect(rows['c-maps'].headers).toEqual({ 'X-Api-Key': '{{MAPS_API_KEY_2}}', Accept: 'application/json' });
    expect(openEnvVarsStrict(rows['c-maps'].env_vars)).toEqual({ REGION: 'eu', MAPS_API_KEY: GOOGLE, MAPS_API_KEY_2: 'k1k2k3k4k5' });

    // Untouched.
    expect(rows['c-clean'].base_url).toBe('https://api.example.com/v1');
    expect(rows['c-db'].base_url).toBe('postgres://u:p@db.example.com/x');
    expect(rows['c-badkey'].base_url).toContain(TG_SECRET);

    // A second run finds nothing left to do (the bad-key connector stays skipped).
    const again = await repair(client, { workspaceId: ORG, out });
    expect(again.plans).toEqual([]);
    const findings = (await report(client, out)).filter((f) => f.workspaceId === ORG);
    expect(findings.map((f) => f.connectorId)).toEqual(['c-badkey']);
  });
});
