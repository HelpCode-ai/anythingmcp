import { listAdapters, getAdapter } from './catalog';

const VALID_AUTH_TYPES = new Set([
  'NONE',
  'API_KEY',
  'BEARER_TOKEN',
  'BASIC_AUTH',
  'OAUTH2',
  'OAUTH1',
  'QUERY_AUTH',
  'LOGIN_TOKEN',
  'CONNECTION_STRING',
]);

const VALID_PASSWORD_HASHING_SCHEMES = new Set(['bcrypt', 'none']);
const VALID_SALT_SOURCE_TYPES = new Set(['fetch', 'static']);

// `STATIC` is intercepted by ConnectorsService / DynamicMcpTools BEFORE engine
// dispatch (returns endpointMapping.staticResponse verbatim), so it's universal
// across connector types — REST adapters can declare static "skill" or "enum
// helper" tools without ever calling an HTTP engine.
const VALID_REST_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'STATIC']);
const VALID_GRAPHQL_METHODS = new Set([
  'QUERY',
  'MUTATION',
  'SUBSCRIPTION',
  'STATIC',
  'SCHEMA',
]);

// DATABASE adapters never speak HTTP: `query` runs SQL (or a Mongo find spec),
// `mongo_schema` introspects collections, and `static` returns canned text —
// see DatabaseEngine.execute. Their `path` IS the statement, so the REST rules
// about `{placeholders}` and `${x}` do not apply to it.
const VALID_DATABASE_METHODS = new Set(['QUERY', 'STATIC', 'MONGO_SCHEMA']);

/**
 * Recursively collect every string value in an object/array, together with the
 * JSON path to that value. Used to scan endpointMapping fields for broken
 * placeholder syntax.
 */
function collectStrings(
  value: unknown,
  path: string,
  out: Array<{ path: string; value: string }>,
): void {
  if (typeof value === 'string') {
    out.push({ path, value });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => collectStrings(v, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      collectStrings(v, `${path}.${k}`, out);
    }
  }
}

describe('adapter catalog', () => {
  const adapters = listAdapters();

  it('registers at least one adapter', () => {
    expect(adapters.length).toBeGreaterThan(0);
  });

  it('has unique slugs', () => {
    const slugs = adapters.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  /**
   * `connector_auth_cache` is written by the login-token service and by nothing
   * else: 131 OAUTH2 connectors in production, zero rows. The Etsy adapter told
   * its users their OAuth token was persisted there, which was simply untrue —
   * OAuth2 writes the refreshed pair back into the connector's own encrypted
   * authConfig. Instructions are the page a customer reads when a connector
   * misbehaves, so a wrong sentence there costs somebody an afternoon.
   */
  it('only LOGIN_TOKEN adapters claim the connector_auth_cache table', () => {
    const liars = adapters
      .map((m) => getAdapter(m.slug)!)
      .filter(
        (a) =>
          a.instructions?.includes('connector_auth_cache') &&
          a.connector.authType !== 'LOGIN_TOKEN',
      )
      .map((a) => a.slug);
    expect(liars).toEqual([]);
  });

  describe('GraphQL adapters get auto-injected builtin tools', () => {
    const graphqlAdapters = adapters
      .map((m) => getAdapter(m.slug)!)
      .filter((a) => a.connector.type === 'GRAPHQL');

    it.each(graphqlAdapters.map((a) => [a.slug, a]))(
      '%s exposes the five GraphQL builtins',
      (_slug, adapter) => {
        const names = new Set(adapter.tools.map((t) => t.name));
        expect(names.has(`${adapter.slug}_graphql_schema_url`)).toBe(true);
        expect(names.has(`${adapter.slug}_graphql_schema`)).toBe(true);
        expect(names.has(`${adapter.slug}_graphql_query`)).toBe(true);
        expect(names.has(`${adapter.slug}_graphql_mutation`)).toBe(true);
        expect(names.has(`${adapter.slug}_graphql_subscription`)).toBe(true);
      },
    );

    it.each(graphqlAdapters.map((a) => [a.slug, a]))(
      '%s _graphql_schema uses method=schema and points at the SDL URL',
      (_slug, adapter) => {
        const tool = adapter.tools.find(
          (t) => t.name === `${adapter.slug}_graphql_schema`,
        )!;
        const em = tool.endpointMapping as { method: string; path: string };
        expect(em.method).toBe('schema');
        expect(em.path).toMatch(/^https?:\/\//);
      },
    );

    it.each(graphqlAdapters.map((a) => [a.slug, a]))(
      '%s _graphql_schema_url returns a URL string via method=static',
      (_slug, adapter) => {
        const tool = adapter.tools.find(
          (t) => t.name === `${adapter.slug}_graphql_schema_url`,
        )!;
        const em = tool.endpointMapping as { method: string; path: string };
        expect(em.method).toBe('static');
        expect(em.path).toMatch(/^https?:\/\//);
      },
    );
  });

  describe.each(adapters)('$slug', (meta) => {
    const adapter = getAdapter(meta.slug)!;

    it('has a valid connector authType', () => {
      expect(VALID_AUTH_TYPES.has(adapter.connector.authType)).toBe(true);
    });

    it('declares at least one tool', () => {
      expect(adapter.tools.length).toBeGreaterThan(0);
    });

    if (meta.region === 'intl' || adapter.connector.authType === 'LOGIN_TOKEN') {
      it('LOGIN_TOKEN authConfig is well-formed', () => {
        if (adapter.connector.authType !== 'LOGIN_TOKEN') return;
        const cfg = adapter.connector.authConfig as Record<string, unknown>;
        expect(cfg).toBeDefined();
        expect(typeof cfg.loginUrl).toBe('string');
        expect(typeof cfg.tokenJsonPath).toBe('string');
        if (cfg.passwordHashing) {
          const ph = cfg.passwordHashing as Record<string, unknown>;
          expect(VALID_PASSWORD_HASHING_SCHEMES.has(String(ph.scheme))).toBe(true);
          if (ph.scheme === 'bcrypt') {
            expect(ph.saltSource).toBeDefined();
            const src = ph.saltSource as Record<string, unknown>;
            expect(VALID_SALT_SOURCE_TYPES.has(String(src.type))).toBe(true);
            if (src.type === 'fetch') expect(typeof src.url).toBe('string');
            if (src.type === 'static') expect(typeof src.value).toBe('string');
          }
        }
      });
    }

    it.each(adapter.tools.map((t) => [t.name, t]))(
      '%s has a well-formed endpointMapping',
      (_name, tool) => {
        const em = tool.endpointMapping as Record<string, unknown>;

        const isDatabase = adapter.connector.type === 'DATABASE';
        const allowed = isDatabase
          ? VALID_DATABASE_METHODS
          : adapter.connector.type === 'GRAPHQL'
            ? VALID_GRAPHQL_METHODS
            : VALID_REST_METHODS;
        expect(allowed.has(String(em.method).toUpperCase())).toBe(true);
        expect(typeof em.path).toBe('string');

        // Legacy `body` field must be renamed to `bodyMapping`/`bodyTemplate`
        expect(em).not.toHaveProperty('body');

        // The remaining rules police HTTP URLs and HTTP payloads. A DATABASE
        // tool has neither: its path is SQL, where `${query}` is the documented
        // way to hand the engine a raw statement.
        if (isDatabase) return;

        // Path placeholders must be {x} (engine resolves path via `{name}` interpolation),
        // not ${x} (which the engine would leave literal in URLs).
        expect(em.path as string).not.toMatch(/\$\{[\w$]+\}/);

        // queryParams / bodyMapping / headers: verify every `$x` or `${x}` reference
        // points to a parameter the tool declares (catches typos in placeholder names).
        const declaredParams = new Set(
          Object.keys(
            ((tool.parameters as Record<string, unknown>)?.properties as
              | Record<string, unknown>
              | undefined) ?? {},
          ),
        );
        for (const field of ['queryParams', 'bodyMapping', 'headers']) {
          const strings: Array<{ path: string; value: string }> = [];
          collectStrings(em[field], field, strings);
          for (const { value } of strings) {
            // Full-string reference: "$foo" → must be declared as a tool param,
            // unless it's $$ (escape) or an env-var-style reference (UPPER_SNAKE_CASE,
            // resolved at runtime from connector.envVars populated at import time).
            const full = /^\$([\w$]+)$/.exec(value);
            if (full && !value.startsWith('$$') && !/^[A-Z][A-Z0-9_]*$/.test(full[1])) {
              expect(declaredParams.has(full[1])).toBe(true);
            }
            // Embedded references: "...${foo}..." — all names must be declared
            // (same env-var exemption applies).
            for (const match of value.matchAll(/\$\{([\w$]+)\}/g)) {
              if (/^[A-Z][A-Z0-9_]*$/.test(match[1])) continue;
              expect(declaredParams.has(match[1])).toBe(true);
            }
          }
        }
      },
    );
  });
});
