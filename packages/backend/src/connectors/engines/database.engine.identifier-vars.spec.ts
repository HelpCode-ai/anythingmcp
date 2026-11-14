import {
  DatabaseEngine,
  assertSafeSqlIdentifierVars,
  compileParameterized,
} from './database.engine';
import { interpolateConnectorConfig } from '../../common/env-interpolation.util';

const mockExecute = jest.fn();
const mockQuery = jest.fn();
const mockEnd = jest.fn();
jest.mock('mysql2/promise', () => ({
  createConnection: jest.fn().mockImplementation(() =>
    Promise.resolve({ execute: mockExecute, query: mockQuery, end: mockEnd }),
  ),
}));

/**
 * `connector.config.sqlIdentifierVars`: the variables a DATABASE connector may
 * use inside an identifier of its SQL (OpenCart's table prefix). `{{VAR}}` in
 * a tool's SQL is filled in as text before the engine runs, so the guard runs
 * first, on the template as written.
 */
const LIST = ['OPENCART_DB_PREFIX'];
const SQL =
  'SELECT o.order_id, o.total FROM `{{OPENCART_DB_PREFIX}}order` o WHERE o.order_id = ${order_id}';

/** What the two call sites do: guard, then interpolate, then compile. */
function run(
  identifierVars: unknown,
  template: string,
  envVars: Record<string, string>,
  params: Record<string, unknown> = {},
) {
  assertSafeSqlIdentifierVars(identifierVars, template, envVars);
  const { endpointMapping } = interpolateConnectorConfig(
    { baseUrl: 'mysql://host:3306/shop' },
    { method: 'query', path: template },
    envVars,
  );
  return compileParameterized(endpointMapping.path, params, 'mysql');
}

describe('assertSafeSqlIdentifierVars', () => {
  describe('substitution', () => {
    it('lets a plain prefix through and keeps values bound', () => {
      const out = run(LIST, SQL, { OPENCART_DB_PREFIX: 'oc_' }, { order_id: 42 });
      expect(out.sql).toBe('SELECT o.order_id, o.total FROM `oc_order` o WHERE o.order_id = ?');
      expect(out.values).toEqual([42]);
    });

    it('accepts an empty prefix (a shop installed without one)', () => {
      const out = run(LIST, SQL, { OPENCART_DB_PREFIX: '' }, { order_id: 1 });
      expect(out.sql).toContain('FROM `order` o');
    });

    it('accepts letters, digits and underscores up to 20 characters', () => {
      for (const value of ['oc_', 'OC2_', 'shop_2024_', 'a'.repeat(20)]) {
        expect(() =>
          assertSafeSqlIdentifierVars(LIST, SQL, { OPENCART_DB_PREFIX: value }),
        ).not.toThrow();
      }
    });

    it('reads the name with spaces inside the braces, as the interpolation does', () => {
      const spaced = 'SELECT 1 FROM `{{ OPENCART_DB_PREFIX }}order`';
      expect(run(LIST, spaced, { OPENCART_DB_PREFIX: 'oc_' }).sql).toBe('SELECT 1 FROM `oc_order`');
      expect(() => run(LIST, spaced, { OPENCART_DB_PREFIX: 'oc_; --' })).toThrow(/OPENCART_DB_PREFIX/);
    });

    it('never binds or inlines a caller parameter named like the variable', () => {
      // {{VAR}} is filled from the connector's variables only; what the caller
      // sends can only ever reach a bound ${parameter}.
      const out = run(LIST, SQL, { OPENCART_DB_PREFIX: 'oc_' }, {
        order_id: 7,
        OPENCART_DB_PREFIX: 'x` ; DROP TABLE y; --',
      });
      expect(out.sql).toBe('SELECT o.order_id, o.total FROM `oc_order` o WHERE o.order_id = ?');
      expect(out.values).toEqual([7]);
    });
  });

  describe('refusal', () => {
    const unsafe: Array<[string, string]> = [
      ['a single quote', "oc_' OR '1'='1"],
      ['a double quote', 'oc_"'],
      ['a backtick', 'oc_`'],
      ['a space', 'oc_order o JOIN oc_user u'],
      ['a semicolon', 'oc_order; DROP TABLE oc_order'],
      ['a dot (another schema)', 'mysql.'],
      ['a comment marker', 'oc_--'],
      ['a parenthesis', 'oc_('],
      ['a line break', 'oc_\n'],
      ['a non-ASCII letter', 'öc_'],
      ['more than 20 characters', 'a'.repeat(21)],
    ];

    it.each(unsafe)('refuses a value with %s', (_label, value) => {
      expect(() => run(LIST, SQL, { OPENCART_DB_PREFIX: value }, { order_id: 1 })).toThrow(
        /OPENCART_DB_PREFIX is used as part of a table name.*No query was sent/,
      );
    });

    it('does not repeat the refused value in the error', () => {
      const value = "oc_' UNION SELECT password";
      let message = '';
      try {
        assertSafeSqlIdentifierVars(LIST, SQL, { OPENCART_DB_PREFIX: value });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain('OPENCART_DB_PREFIX');
      expect(message).not.toContain('UNION');
    });

    it('refuses a value that is not a string', () => {
      expect(() =>
        assertSafeSqlIdentifierVars(LIST, SQL, { OPENCART_DB_PREFIX: 5 as unknown as string }),
      ).toThrow(/OPENCART_DB_PREFIX/);
    });

    it('refuses any other variable in the SQL, however harmless its value', () => {
      const template =
        "SELECT 1 FROM `{{OPENCART_DB_PREFIX}}order` o WHERE o.email = '{{SHOP_EMAIL}}'";
      expect(() =>
        run(LIST, template, { OPENCART_DB_PREFIX: 'oc_', SHOP_EMAIL: 'a@example.com' }),
      ).toThrow(/SHOP_EMAIL cannot be used in this connector's SQL.*OPENCART_DB_PREFIX/);
    });

    it('refuses a caller-context variable in the SQL as well', () => {
      const template = "SELECT 1 FROM t WHERE owner = '{{amcp.user.email}}'";
      expect(() => assertSafeSqlIdentifierVars(LIST, template, {})).toThrow(/amcp\.user\.email/);
    });

    it('with an empty list, no variable may be filled into the SQL', () => {
      expect(() => assertSafeSqlIdentifierVars([], SQL, { OPENCART_DB_PREFIX: 'oc_' })).toThrow(
        /\(none\)/,
      );
    });

    it('ignores list entries that are not strings', () => {
      expect(() =>
        assertSafeSqlIdentifierVars([null, 3, 'OPENCART_DB_PREFIX'], SQL, { OPENCART_DB_PREFIX: 'oc_' }),
      ).not.toThrow();
    });
  });

  describe('left alone', () => {
    it('does nothing for a connector without the list: the old path, byte for byte', () => {
      const env = { SCHEMA: "sales'; --" };
      const template = 'SELECT * FROM {{SCHEMA}}.orders WHERE id = ${id}';
      for (const absent of [undefined, null, 'OPENCART_DB_PREFIX', { 0: 'SCHEMA' }]) {
        expect(() => assertSafeSqlIdentifierVars(absent, template, env)).not.toThrow();
      }
      const guarded = run(undefined, template, env, { id: 3 });
      const before = compileParameterized(
        interpolateConnectorConfig(
          { baseUrl: 'mysql://host:3306/shop' },
          { method: 'query', path: template },
          env,
        ).endpointMapping.path,
        { id: 3 },
        'mysql',
      );
      expect(guarded).toEqual(before);
      expect(guarded.sql).toBe("SELECT * FROM sales'; --.orders WHERE id = ?");
    });

    it('does nothing for SQL without a variable, a raw ${query} tool or a static tool', () => {
      const env = { OPENCART_DB_PREFIX: 'not safe;' };
      for (const template of ['SELECT 1', '${query}', '', undefined]) {
        expect(() => assertSafeSqlIdentifierVars(LIST, template, env)).not.toThrow();
      }
    });

    it('leaves a variable with no value to the unresolved-placeholder check', () => {
      expect(() => assertSafeSqlIdentifierVars(LIST, SQL, {})).not.toThrow();
      expect(() => assertSafeSqlIdentifierVars(LIST, SQL, undefined)).not.toThrow();
      expect(() => assertSafeSqlIdentifierVars(LIST, SQL, null)).not.toThrow();
    });
  });
});

describe('DatabaseEngine with a guarded table prefix (MySQL path)', () => {
  const engine = new DatabaseEngine();
  const config = { baseUrl: 'mysql://host:3306/shop', authType: 'CONNECTION_STRING' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockExecute.mockResolvedValue([[{ order_id: 42, total: '10.0000' }]]);
    mockQuery.mockResolvedValue([[]]);
  });

  it('runs the prefixed statement with the value bound', async () => {
    const env = { OPENCART_DB_PREFIX: 'shop1_' };
    assertSafeSqlIdentifierVars(LIST, SQL, env);
    const { endpointMapping } = interpolateConnectorConfig(
      { baseUrl: config.baseUrl },
      { method: 'query', path: SQL },
      env,
    );
    const out = await engine.execute(config, endpointMapping, { order_id: 42 });
    expect(mockExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: 'SELECT o.order_id, o.total FROM `shop1_order` o WHERE o.order_id = ?',
      }),
      [42],
    );
    expect(out).toEqual({ rows: [{ order_id: 42, total: '10.0000' }], totalRows: 1 });
  });

  it('still applies the denied-tables list to the prefixed name', async () => {
    const template = 'SELECT u.username FROM `{{OPENCART_DB_PREFIX}}user` u WHERE u.user_id = ${id}';
    const env = { OPENCART_DB_PREFIX: 'oc_' };
    assertSafeSqlIdentifierVars(LIST, template, env);
    const { endpointMapping } = interpolateConnectorConfig(
      { baseUrl: config.baseUrl },
      { method: 'query', path: template },
      env,
    );
    await expect(
      engine.execute(config, endpointMapping, { id: 1 }, { deniedTables: ['*user'] }),
    ).rejects.toThrow(/OC_USER is blocked/);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
