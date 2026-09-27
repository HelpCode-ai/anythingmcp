import * as adapter from './sap-s4hana-hana.json';
import { DatabaseEngine } from '../../connectors/engines/database.engine';
import * as hanaDriver from '../../connectors/engines/hana.driver';
import { renderStaticResponse } from '../../connectors/static-response.util';

/**
 * Two layers of verification for the SAP S/4HANA (HANA SQL) adapter:
 *
 *   1. Static — always runs. Every dictionary tool must get through the
 *      engine's read-only guard and the adapter's own denied-tables list,
 *      compile to HANA `?` placeholders with every `${param}` bound (a
 *      leftover would reach HANA as literal text), and the guide must answer
 *      every topic it advertises.
 *
 *   2. Live — skipped unless RUN_SAP_HANA_LIVE is set. Runs each tool against
 *      a real S/4HANA database, which is the only way to prove the dictionary
 *      SQL matches SAP's tables on a given release:
 *
 *        RUN_SAP_HANA_LIVE=1 SAP_HANA_URL='hana://host:30015/?databaseName=QAS&currentSchema=SAPHANADB&sapClient=100&tls=no-verify' \
 *          SAP_HANA_USER=... SAP_HANA_PASSWORD=... SAP_LANGUAGE=E \
 *          npx jest src/adapters/intl/sap-s4hana-hana.live.spec.ts
 */

type Tool = (typeof adapter.tools)[number];
const tool = (name: string): Tool => adapter.tools.find((t) => t.name === name)!;

const sampleArgs: Record<string, Record<string, unknown>> = {
  sap_org_structure: {},
  sap_search_tables: { query: 'billing' },
  sap_describe_table: { table: 'VBRK' },
  sap_find_fields: { query: 'net due date', table_pattern: '%' },
  sap_field_values: { table: 'VBRK', field: 'VBTYP' },
  sap_table_relations: { table: 'VBRK' },
  sap_search_cds_views: { query: 'journal entry' },
  sap_describe_cds_view: { view: 'I_JournalEntryItemCube' },
  sap_query: { query: "SELECT TOP 5 BUKRS, BUTXT, WAERS FROM T001" },
};

describe('sap-s4hana-hana adapter (static)', () => {
  const engine = new DatabaseEngine();
  const env = { SAP_CLIENT: '100', SAP_LANGUAGE: 'E' };
  let openSpy: jest.SpyInstance;
  let seen: { sql: string; values: unknown[] }[];

  beforeEach(() => {
    seen = [];
    openSpy = jest.spyOn(hanaDriver, 'openHanaSession').mockResolvedValue({
      run: async () => undefined,
      query: async (sql: string, values: unknown[]) => {
        seen.push({ sql, values });
        return { rows: [], truncated: false };
      },
      close: async () => undefined,
    });
  });
  afterEach(() => openSpy.mockRestore());

  const queryTools = adapter.tools.filter((t) => t.endpointMapping.method === 'query');

  it('has sample arguments for every query tool', () => {
    expect(queryTools.map((t) => t.name).sort()).toEqual(Object.keys(sampleArgs).sort());
  });

  it.each(queryTools.map((t) => t.name))(
    '%s passes the guards and binds every parameter',
    async (name) => {
      await engine.execute(
        { baseUrl: 'hana://hana.example.test:30015/?sapClient=100', authType: 'NONE' },
        tool(name).endpointMapping as any,
        { ...env, ...sampleArgs[name] },
        { deniedTables: adapter.connector.config.deniedTables },
      );
      expect(seen).toHaveLength(1);
      expect(seen[0].sql).not.toMatch(/\$\{?\w/);
      if (name !== 'sap_query') expect(seen[0].values.length).toBeGreaterThan(0);
    },
  );

  it('keeps SAP_CLIENT and SAP_LANGUAGE bound, never inlined', async () => {
    await engine.execute(
      { baseUrl: 'hana://hana.example.test:30015', authType: 'NONE' },
      tool('sap_org_structure').endpointMapping as any,
      env,
    );
    expect(seen[0].sql).not.toContain("'100'");
    expect(seen[0].values).toEqual(expect.arrayContaining(['100', 'E']));
  });

  it('denies the HR and security tables it lists', async () => {
    await expect(
      engine.execute(
        { baseUrl: 'hana://hana.example.test:30015', authType: 'NONE' },
        tool('sap_query').endpointMapping as any,
        { query: 'SELECT * FROM PA0008' },
        { deniedTables: adapter.connector.config.deniedTables },
      ),
    ).rejects.toThrow(/denied-tables/);
  });

  it('the guide answers every advertised topic', () => {
    const guide = tool('sap_guide');
    const topics = (guide.parameters.properties as any).topic.enum as string[];
    expect(topics.length).toBeGreaterThan(5);
    for (const topic of topics) {
      const text = renderStaticResponse(guide.endpointMapping as any, { topic });
      expect(text.length).toBeGreaterThan(200);
      expect(text).not.toMatch(/^There is no topic/);
    }
    expect(renderStaticResponse(guide.endpointMapping as any, {})).toMatch(/Topics \(pass one as "topic"\)/);
  });

  it('probes with a tool that needs no arguments', () => {
    expect(adapter.probe.tool).toBe('sap_org_structure');
    expect((tool('sap_org_structure').parameters as any).required).toBeUndefined();
  });
});

const live = process.env.RUN_SAP_HANA_LIVE ? describe : describe.skip;

live('sap-s4hana-hana adapter (live)', () => {
  const engine = new DatabaseEngine();
  // Read at collection time, so tolerate the variable being absent when skipped.
  const url = process.env.SAP_HANA_URL || 'hana://unset:30015';
  const client = new URL(url.replace(/^hana:/, 'http:')).searchParams.get('sapClient') || '';
  const env = { SAP_CLIENT: client, SAP_LANGUAGE: process.env.SAP_LANGUAGE || 'E' };
  const config = {
    baseUrl: url,
    authType: 'CONNECTION_STRING',
    authConfig: { username: process.env.SAP_HANA_USER, password: process.env.SAP_HANA_PASSWORD },
  };

  beforeAll(() => {
    process.env.SSRF_ALLOW_PRIVATE = 'true';
  });

  it.each(Object.keys(sampleArgs))('%s runs', async (name) => {
    const out: any = await engine.execute(
      config,
      tool(name).endpointMapping as any,
      { ...env, ...sampleArgs[name] },
      { deniedTables: adapter.connector.config.deniedTables },
    );
     
    console.log(name, JSON.stringify(out.rows?.slice(0, 3)));
    expect(Array.isArray(out.rows)).toBe(true);
  }, 120_000);

  it('describes ACDOCA with labels and currency references', async () => {
    const out: any = await engine.execute(
      config,
      tool('sap_describe_table').endpointMapping as any,
      { ...env, table: 'ACDOCA' },
    );
    const hsl = out.rows.find((r: any) => r.FIELD === 'HSL');
    expect(hsl?.LABEL).toBeTruthy();
    expect(hsl?.CURRENCY_OR_UNIT_FIELD).toMatch(/RHCUR/);
  }, 120_000);
});
