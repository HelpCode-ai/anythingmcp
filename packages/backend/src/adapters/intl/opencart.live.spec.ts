import * as adapter from './opencart.json';
import {
  DatabaseEngine,
  assertSafeSqlIdentifierVars,
  normalizeDeniedTables,
} from '../../connectors/engines/database.engine';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { renderStaticResponse } from '../../connectors/static-response.util';

/**
 * Two layers of verification for the OpenCart adapter, which reads the shop's
 * MySQL database:
 *
 *   1. Static, always: every tool is a SELECT (or the static guide), no fixed
 *      tool touches a password, token or IP column, every table name goes
 *      through the guarded prefix variable, and every fixed query gets through
 *      the engine's own compiler, read-only check and denied-tables list.
 *
 *   2. Live, only with RUN_OPENCART_LIVE=1: runs every fixed query once on a
 *      real OpenCart database, which is the only proof that the SQL matches
 *      the tables of a given OpenCart version.
 *
 *        RUN_OPENCART_LIVE=1 OPENCART_DB_HOST=... OPENCART_DB_PORT=3306 \
 *          OPENCART_DB_NAME=... OPENCART_DB_USER=... OPENCART_DB_PASSWORD=... \
 *          OPENCART_DB_PREFIX=oc_ npx jest src/adapters/intl/opencart.live.spec.ts
 *
 *      A database on a private address also needs SSRF_ALLOWED_HOSTS=<host>.
 */

const PREFIX_VAR = 'OPENCART_DB_PREFIX';
const PLACEHOLDER = `{{${PREFIX_VAR}}}`;

type Mapping = { method: string; path: string; staticResponse?: string };
interface Param {
  type: string;
  description?: string;
  default?: unknown;
}
interface Tool {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { type: string; properties?: Record<string, Param>; required?: string[] };
  endpointMapping: Mapping;
}
interface GuideStep {
  id: string;
  fields?: string[];
  saveAndCheck?: boolean;
}

// Read through a plain shape: the type inferred from the JSON is a union of
// every tool's own parameter set, which says nothing useful here.
const a = adapter as unknown as {
  description: string;
  instructions: string;
  prerequisites: string;
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  envVarMeta: Record<string, { secret?: boolean; pattern?: string }>;
  requiresIpAllowlist?: boolean;
  checkBeforeAuthorization?: unknown;
  probe: { tool: string };
  setupGuide: { effort: string; steps: GuideStep[] };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    config: { deniedTables: string[]; sqlIdentifierVars: string[]; readOnly?: boolean };
  };
  tools: Tool[];
};

const mapping = (t: Tool): Mapping => t.endpointMapping;
const tool = (name: string): Tool => a.tools.find((t) => t.name === name)!;
const properties = (t: Tool): Record<string, Param> => t.parameters.properties ?? {};
const required = (t: Tool): string[] => t.parameters.required ?? [];

const config = a.connector.config;

const RAW_TOOL = 'opencart_query';
const STATIC_TOOL = 'opencart_guide';
/** Tools that read MySQL's own catalogue; they take the prefix as a bound value. */
const SCHEMA_TOOLS = ['opencart_list_tables', 'opencart_describe_table'];
const fixedTools = a.tools.filter((t) => mapping(t).method === 'query' && mapping(t).path !== '${query}');

/** Values for the required parameters; everything else has a default. */
const sampleArgs: Record<string, Record<string, unknown>> = {
  opencart_get_order: { order_id: 1 },
  opencart_sales_summary: { date_from: '2000-01-01', date_to: '2099-12-31' },
  opencart_top_products: { date_from: '2000-01-01', date_to: '2099-12-31' },
  opencart_get_product: { product_id: 1 },
  opencart_get_customer: { customer_id: 1 },
  opencart_describe_table: { table: 'order' },
};

/** What the two call sites do before the engine runs: variables as parameter defaults, schema defaults, the prefix guard, {{VAR}}. */
function prepare(t: Tool, envVars: Record<string, string>, args: Record<string, unknown> = {}) {
  const withEnv = { ...envVars, ...(sampleArgs[t.name] ?? {}), ...args };
  const params = applySchemaDefaults(t.parameters, withEnv);
  assertSafeSqlIdentifierVars(config.sqlIdentifierVars, mapping(t).path, envVars);
  const { endpointMapping } = interpolateConnectorConfig(
    { baseUrl: a.connector.baseUrl },
    mapping(t),
    envVars,
  );
  return { endpointMapping, params };
}

/** SQL as the checks below read it: string literals emptied, so a word inside one is not taken for a column. */
const withoutLiterals = (sql: string) => sql.replace(/'(?:[^']|'')*'/g, "''");

/** Prose as the website renders it: code spans and fenced blocks removed. */
const proseOnly = (text: string) => text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');

describe('opencart adapter (static)', () => {
  describe('connector', () => {
    it('is a DATABASE connector on a mysql:// address built from variables', () => {
      expect(a.connector.type).toBe('DATABASE');
      expect(a.connector.authType).toBe('CONNECTION_STRING');
      expect(a.connector.baseUrl).toBe(
        'mysql://{{OPENCART_DB_HOST}}:{{OPENCART_DB_PORT}}/{{OPENCART_DB_NAME}}',
      );
    });

    it('keeps the credentials in authConfig, not in the address', () => {
      expect(a.connector.authConfig).toEqual({
        username: '{{OPENCART_DB_USER}}',
        password: '{{OPENCART_DB_PASSWORD}}',
      });
      expect(a.connector.baseUrl).not.toContain('@');
    });

    it('declares its variables, with the table prefix optional (a shop may have none)', () => {
      expect(a.requiredEnvVars).toEqual([
        'OPENCART_DB_HOST',
        'OPENCART_DB_PORT',
        'OPENCART_DB_NAME',
        'OPENCART_DB_USER',
        'OPENCART_DB_PASSWORD',
      ]);
      expect(a.optionalEnvVars).toEqual([PREFIX_VAR]);
      const meta = a.envVarMeta;
      for (const name of [...a.requiredEnvVars, ...a.optionalEnvVars]) {
        expect(meta[name]).toBeDefined();
      }
      expect(meta.OPENCART_DB_PASSWORD.secret).toBe(true);
      // The form refuses what the engine would refuse at call time.
      expect(meta[PREFIX_VAR].pattern).toBe('^[A-Za-z0-9_]{0,20}$');
    });

    it('installs read-only and asks for the outbound address to be allowed', () => {
      expect(config.readOnly).not.toBe(false);
      expect(a.requiresIpAllowlist).toBe(true);
      expect(a.tools.every((t) => t.enabled !== false)).toBe(true);
    });

    it('opts in to the guarded table prefix', () => {
      expect(config.sqlIdentifierVars).toEqual([PREFIX_VAR]);
    });

    it('probes with a tool that needs no arguments and reads prefixed tables', () => {
      const probe = tool(a.probe.tool);
      expect(probe).toBeDefined();
      expect(required(probe)).toEqual([]);
      expect(mapping(probe).path).toContain(PLACEHOLDER);
    });
  });

  describe('denied tables', () => {
    const denied = normalizeDeniedTables(config.deniedTables);
    const isDenied = (name: string) => denied.some((re) => re.test(name));

    it.each(['user', 'api', 'api_ip', 'api_session', 'customer_ip', 'session', 'customer_login'])(
      'blocks %s under any prefix',
      (table) => {
        for (const prefix of ['oc_', '', 'shop2_', 'OC_']) expect(isDenied(`${prefix}${table}`)).toBe(true);
      },
    );

    it('also blocks the other sign-in tables and the settings, which hold mail and payment credentials', () => {
      for (const table of [
        'oc_user_login',
        'oc_user_authorize',
        'oc_user_token',
        'oc_api_history',
        'oc_customer_authorize',
        'oc_customer_token',
        'oc_setting',
      ]) {
        expect(isDenied(table)).toBe(true);
      }
    });

    it('leaves the tables the tools read alone', () => {
      const used = new Set<string>();
      for (const t of fixedTools) {
        for (const m of mapping(t).path.matchAll(/`\{\{OPENCART_DB_PREFIX\}\}([a-z_]+)`/g)) used.add(m[1]);
      }
      expect(used.size).toBeGreaterThan(25);
      for (const table of used) {
        expect(isDenied(`oc_${table}`)).toBe(false);
        expect(isDenied(table)).toBe(false);
      }
    });
  });

  describe('tools', () => {
    it('are the expected set, all named opencart_*', () => {
      expect(a.tools.map((t) => t.name).sort()).toEqual(
        [
          'opencart_describe_table',
          'opencart_get_customer',
          'opencart_get_order',
          'opencart_get_product',
          'opencart_get_shop_overview',
          'opencart_guide',
          'opencart_list_categories',
          'opencart_list_coupons',
          'opencart_list_customers',
          'opencart_list_extensions',
          'opencart_list_order_statuses',
          'opencart_list_orders',
          'opencart_list_product_specials',
          'opencart_list_returns',
          'opencart_list_reviews',
          'opencart_list_seo_urls',
          'opencart_list_tables',
          'opencart_low_stock',
          'opencart_products_missing_content',
          'opencart_query',
          'opencart_sales_summary',
          'opencart_search_products',
          'opencart_top_products',
        ].sort(),
      );
    });

    it('use only the query and static methods: one guide, one free query, the rest fixed SELECTs', () => {
      for (const t of a.tools) expect(['query', 'static']).toContain(mapping(t).method);
      expect(a.tools.filter((t) => mapping(t).method === 'static').map((t) => t.name)).toEqual([STATIC_TOOL]);
      expect(a.tools.filter((t) => mapping(t).path === '${query}').map((t) => t.name)).toEqual([RAW_TOOL]);
      expect(fixedTools).toHaveLength(a.tools.length - 2);
    });

    it.each(fixedTools.map((t) => [t.name, t] as const))('%s is a single SELECT with a LIMIT', (_name, t) => {
      const sql = withoutLiterals(mapping(t).path);
      expect(sql.startsWith('SELECT ')).toBe(true);
      expect(sql).not.toContain(';');
      expect(sql).toMatch(/\bLIMIT (\d+|\$\{limit\})( OFFSET \$\{offset\})?$/);
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE\s+INTO|DROP|ALTER|TRUNCATE|CREATE|GRANT|CALL|SET)\b/i);
    });

    it.each(fixedTools.map((t) => [t.name, t] as const))(
      '%s never reads a password, salt, token, reset code or IP column',
      (name, t) => {
        const sql = withoutLiterals(mapping(t).path);
        expect(sql).not.toMatch(/\b(password|salt|token|ip|forwarded_ip|user_agent|accept_language|session_id)\b/i);
        expect(sql).not.toMatch(/SELECT\s+(\w+\.)?\*/i);
        // `code` is a coupon, currency, language or extension code elsewhere; on
        // the customer it is the password-reset code.
        if (['opencart_list_customers', 'opencart_get_customer'].includes(name)) {
          // `z.code` is the zone code of an address.
          expect(sql.replace(/\bz\.code\b/g, '')).not.toMatch(/\bcode\b/i);
        }
      },
    );

    it.each(fixedTools.map((t) => [t.name, t] as const))('%s takes the table prefix from the variable', (name, t) => {
      const path = mapping(t).path;
      if (SCHEMA_TOOLS.includes(name)) {
        // information_schema has no prefix: the prefix is compared as a bound value.
        expect(path).toContain('${' + PREFIX_VAR + '}');
        expect(path).not.toContain('{{');
        return;
      }
      expect(path).toContain(PLACEHOLDER);
      // The variable only ever starts a back-quoted table name…
      expect(path.replace(/`\{\{OPENCART_DB_PREFIX\}\}[a-z_]+`/g, '')).not.toMatch(/\{\{|\}\}/);
      // …and no table is named without it.
      const bare = withoutLiterals(path)
        .replace(/`\{\{OPENCART_DB_PREFIX\}\}[a-z_]+`/g, 'T')
        .match(/\b(?:FROM|JOIN)\s+(?!T\b|\()(\S+)/g);
      expect(bare).toBeNull();
    });

    it('fills no other variable into any SQL', () => {
      for (const t of a.tools) {
        const names = [...mapping(t).path.matchAll(/\{\{([^{}]+)\}\}/g)].map((m) => m[1]);
        expect(names.every((n) => n === PREFIX_VAR)).toBe(true);
      }
    });

    it.each(fixedTools.map((t) => [t.name, t] as const))(
      '%s declares every parameter it binds, and gives each optional one a default',
      (_name, t) => {
        const bound = new Set([...mapping(t).path.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]));
        bound.delete(PREFIX_VAR);
        const declared = properties(t);
        expect([...bound].sort()).toEqual(Object.keys(declared).sort());
        for (const [param, schema] of Object.entries(declared)) {
          expect(schema.description).toBeTruthy();
          if (!required(t).includes(param)) expect(schema.default).not.toBeUndefined();
        }
      },
    );

    it('has sample arguments for every required parameter', () => {
      for (const t of fixedTools) {
        expect(Object.keys(sampleArgs[t.name] ?? {}).sort()).toEqual([...required(t)].sort());
      }
    });
  });

  describe('through the engine', () => {
    const engine = new DatabaseEngine();
    const engineConfig = { baseUrl: 'mysql://shop.example.com:3306/shop', authType: 'CONNECTION_STRING' };
    let seen: { sql: string; values: unknown[]; readOnly: boolean }[];

    beforeEach(() => {
      seen = [];
      jest.spyOn(engine as any, 'assertSafeDbHost').mockResolvedValue(undefined);
      jest
        .spyOn(engine as any, 'dispatch')
        .mockImplementation(async (_config: unknown, sql: unknown, values: unknown, readOnly: unknown) => {
          seen.push({ sql: sql as string, values: values as unknown[], readOnly: readOnly as boolean });
          return { rows: [], totalRows: 0 };
        });
    });
    afterEach(() => jest.restoreAllMocks());

    const run = (t: Tool, envVars: Record<string, string>, args: Record<string, unknown> = {}) => {
      const { endpointMapping, params } = prepare(t, envVars, args);
      return engine.execute(engineConfig, endpointMapping, params, {
        readOnly: config.readOnly !== false,
        deniedTables: config.deniedTables,
      });
    };

    it.each(fixedTools.map((t) => [t.name, t] as const))(
      '%s compiles to bound parameters and passes the read-only and denied-tables checks',
      async (name, t) => {
        await run(t, { [PREFIX_VAR]: 'oc_' });
        expect(seen).toHaveLength(1);
        const { sql, values, readOnly } = seen[0];
        expect(readOnly).toBe(true);
        expect(sql).not.toMatch(/\$\{|\{\{/);
        expect((withoutLiterals(sql).match(/\?/g) ?? []).length).toBe(values.length);
        expect(values.every((v) => v !== undefined)).toBe(true);
        if (!SCHEMA_TOOLS.includes(name)) expect(sql).toMatch(/`oc_[a-z_]+`/);
      },
    );

    it.each(fixedTools.map((t) => [t.name, t] as const))('%s also works for a shop without a prefix', async (name, t) => {
      await run(t, { [PREFIX_VAR]: '' });
      expect(seen).toHaveLength(1);
      expect(seen[0].sql).not.toMatch(/\$\{|\{\{/);
      if (!SCHEMA_TOOLS.includes(name)) expect(seen[0].sql).toMatch(/`[a-z_]+`/);
    });

    it.each(["oc_' OR '1'='1", 'oc_`', 'oc_ x', 'oc_;', 'mysql.'])(
      'refuses the prefix %p before anything reaches the database',
      async (prefix) => {
        for (const t of fixedTools.filter((f) => !SCHEMA_TOOLS.includes(f.name))) {
          expect(() => prepare(t, { [PREFIX_VAR]: prefix })).toThrow(/OPENCART_DB_PREFIX is used as part of a table name/);
        }
        expect(seen).toHaveLength(0);
      },
    );

    it('binds an unsafe prefix as a value in the schema tools, where it is harmless', async () => {
      await run(tool('opencart_list_tables'), { [PREFIX_VAR]: "x' OR 1=1 --" });
      expect(seen[0].sql).not.toContain('OR 1=1');
      expect(seen[0].values).toContain("x' OR 1=1 --");
    });

    it('binds what the caller sends, however it is written', async () => {
      const hostile = "' OR 1=1; DROP TABLE oc_order; --";
      await run(tool('opencart_list_orders'), { [PREFIX_VAR]: 'oc_' }, { customer: hostile, status_ids: hostile });
      expect(seen[0].sql).not.toContain('DROP');
      expect(seen[0].values.filter((v) => v === hostile).length).toBeGreaterThan(2);
    });

    describe('opencart_query', () => {
      const free = (query: string) => run(tool(RAW_TOOL), { [PREFIX_VAR]: 'oc_' }, { query });

      it('runs a SELECT as written', async () => {
        await free('SELECT order_id, total FROM oc_order ORDER BY order_id DESC LIMIT 5');
        expect(seen[0].sql).toBe('SELECT order_id, total FROM oc_order ORDER BY order_id DESC LIMIT 5');
      });

      it.each([
        "UPDATE oc_product SET price = 1 WHERE product_id = 1",
        'DELETE FROM oc_order',
        'SELECT 1; DROP TABLE oc_order',
        "SELECT * FROM oc_order INTO OUTFILE '/tmp/x'",
      ])('refuses the write %p', async (query) => {
        await expect(free(query)).rejects.toThrow();
        expect(seen).toHaveLength(0);
      });

      it.each([
        'SELECT username, password FROM oc_user',
        'SELECT * FROM `oc_api`',
        'SELECT * FROM oc_api_session',
        'SELECT * FROM oc_session LIMIT 1',
        'SELECT ip FROM oc_customer_ip',
        'SELECT email FROM oc_customer_login',
        "SELECT `key`, value FROM oc_setting WHERE `key` LIKE '%password%'",
        'SELECT c.email FROM oc_customer c JOIN shop2_user u ON u.email = c.email',
      ])('refuses the blocked table in %p', async (query) => {
        await expect(free(query)).rejects.toThrow(/blocked by this connector's denied-tables list/);
        expect(seen).toHaveLength(0);
      });
    });
  });

  describe('texts', () => {
    it('the guide is a fixed text that names the tools to start with', () => {
      const text = renderStaticResponse(mapping(tool(STATIC_TOOL)), {});
      for (const name of ['opencart_get_shop_overview', 'opencart_list_order_statuses', 'opencart_query', 'opencart_list_tables']) {
        expect(text).toContain(name);
      }
      expect(text).toContain('order_status_id 0');
    });

    it('the instructions cover setup, where to start, and name every tool', () => {
      expect(a.instructions.startsWith('## OpenCart')).toBe(true);
      for (const heading of ['**Setup**', '**Where to start**', '**Data notes**', '**Not included**']) {
        expect(a.instructions).toContain(heading);
      }
      for (const name of ['DB_HOSTNAME', 'DB_DATABASE', 'DB_USERNAME', 'DB_PREFIX', 'Remote MySQL', 'SELECT']) {
        expect(a.instructions).toContain(name);
      }
      for (const t of a.tools) expect(a.instructions).toContain(`\`${t.name}\``);
    });

    it('descriptions and instructions hold no braces or angle brackets outside code', () => {
      const texts = [
        a.description,
        a.instructions,
        a.prerequisites,
        ...a.tools.map((t) => t.description),
        ...a.tools.flatMap((t) => Object.values(properties(t)).map((p) => p.description ?? '')),
      ];
      for (const text of texts) expect(proseOnly(text)).not.toMatch(/[{}<]/);
    });

    it('the setup guide has the three steps and asks for every variable', () => {
      const guide = a.setupGuide;
      expect(guide.effort).toBe('admin_needed');
      expect(guide.steps.map((s) => s.id)).toEqual(['database-user', 'remote-access', 'connection']);
      const asked = guide.steps.flatMap((s) => s.fields ?? []);
      expect(asked.sort()).toEqual([...a.requiredEnvVars, ...a.optionalEnvVars].sort());
      // saveAndCheck needs checkBeforeAuthorization, which only exists for
      // OAuth2 adapters. The last step is checked by the probe instead.
      expect(guide.steps.some((s) => s.saveAndCheck)).toBe(false);
      expect(a.checkBeforeAuthorization).toBeUndefined();
    });
  });
});

/* ------------------------------------------------------------------ */
/*  Live                                                               */
/* ------------------------------------------------------------------ */

const live = process.env.RUN_OPENCART_LIVE === '1';
const liveDescribe = live ? describe : describe.skip;

liveDescribe('opencart adapter (live)', () => {
  const engine = new DatabaseEngine();
  const envVars: Record<string, string> = {
    OPENCART_DB_HOST: process.env.OPENCART_DB_HOST ?? '',
    OPENCART_DB_PORT: process.env.OPENCART_DB_PORT ?? '3306',
    OPENCART_DB_NAME: process.env.OPENCART_DB_NAME ?? '',
    [PREFIX_VAR]: process.env.OPENCART_DB_PREFIX ?? 'oc_',
  };
  const authConfig = {
    username: process.env.OPENCART_DB_USER ?? '',
    password: process.env.OPENCART_DB_PASSWORD ?? '',
  };

  const call = (t: Tool, args: Record<string, unknown> = {}) => {
    const { endpointMapping, params } = prepare(t, envVars, args);
    const { config: resolved } = interpolateConnectorConfig(
      { baseUrl: a.connector.baseUrl },
      mapping(t),
      envVars,
    );
    return engine.execute(
      { baseUrl: resolved.baseUrl, authType: a.connector.authType, authConfig },
      endpointMapping,
      params,
      { readOnly: true, deniedTables: config.deniedTables },
    ) as Promise<{ rows: Record<string, unknown>[]; totalRows: number }>;
  };

  it('has the connection variables', () => {
    expect(envVars.OPENCART_DB_HOST).toBeTruthy();
    expect(envVars.OPENCART_DB_NAME).toBeTruthy();
    expect(authConfig.username).toBeTruthy();
  });

  it('answers the probe with at least one language', async () => {
    const out = await call(tool(a.probe.tool));
    expect(out.rows.some((r) => r.section === 'language')).toBe(true);
    expect(out.rows.filter((r) => r.section === 'count')).toHaveLength(3);
  });

  it.each(fixedTools.map((t) => [t.name, t] as const))('%s runs without a SQL error', async (name, t) => {
    try {
      const out = await call(t);
      expect(Array.isArray(out.rows)).toBe(true);
    } catch (err) {
      // OpenCart 4.1 has no product_special table; the tool says so.
      const message = String((err as Error).message);
      if (name === 'opencart_list_product_specials' && /product_special' doesn't exist/.test(message)) return;
      throw err;
    }
  });

  it('lists the shop tables under the configured prefix', async () => {
    const out = await call(tool('opencart_list_tables'), { search: 'order' });
    const names = out.rows.map((r) => String(r.name));
    expect(names).toContain('order');
    expect(names).toContain('order_product');
  });

  it('runs a free SELECT and still refuses a blocked table', async () => {
    const table = `${envVars[PREFIX_VAR]}order`;
    const out = await call(tool(RAW_TOOL), { query: `SELECT COUNT(*) AS n FROM \`${table}\`` });
    expect(out.rows).toHaveLength(1);
    await expect(
      call(tool(RAW_TOOL), { query: `SELECT * FROM \`${envVars[PREFIX_VAR]}user\` LIMIT 1` }),
    ).rejects.toThrow(/denied-tables list/);
  });
});
