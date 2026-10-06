import { listAdapters, getAdapter } from './catalog';
import { REQUEST_BODY_METHODS } from '../connectors/engines/rest.engine';

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
  'HMAC',
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
// The OData built-ins every ODATA adapter (and REST adapter with
// connector.config.odata) carries; executed by ODataEngine, not as HTTP verbs.
const VALID_ODATA_BUILTIN_METHODS = new Set([
  'ODATA_LIST_SERVICES',
  'ODATA_DESCRIBE_SERVICE',
  'ODATA_DESCRIBE_ENTITY',
  'ODATA_QUERY',
  'ODATA_GET',
]);

/**
 * Declared tool arguments that are deliberately not sent anywhere, as
 * `"<slug>/<tool>": ["arg", ...]`, each with the reason next to it. Empty on
 * purpose: an argument the request never carries is a promise the model
 * cannot see broken, so the bar for adding one is a vendor quirk that leaves
 * no other way, written down here.
 */
const ARGS_NOT_SENT_BY_DESIGN: Record<string, string[]> = {};

/** HTTP verbs RestEngine sends as such (not `static`, not OData built-ins). */
const REST_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Every argument name a REST tool's endpointMapping hands to RestEngine, by
 * the rules RestEngine.execute applies:
 * - `{name}` in `path` is replaced with the argument of that name;
 * - in `queryParams`, `headers` and `bodyMapping` (nested values included,
 *   `__merge` / `__file` / `__raw` markers too) a whole-string `$name` or an
 *   embedded `${name}` is resolved from the arguments;
 * - `bodyTemplate` interpolates `${name}`;
 * - a body (`bodyMapping` or `bodyTemplate`) is only built for
 *   REQUEST_BODY_METHODS, so on any other method it contributes nothing.
 */
function argumentsSent(em: Record<string, unknown>): Set<string> {
  const sent = new Set<string>();
  for (const m of String(em.path ?? '').matchAll(/\{([^{}]+)\}/g)) sent.add(m[1]);
  const fields: unknown[] = [em.queryParams, em.headers];
  const sendsBody = REQUEST_BODY_METHODS.has(String(em.method).toUpperCase());
  if (sendsBody) fields.push(em.bodyMapping);
  for (const field of fields) {
    const strings: Array<{ path: string; value: string }> = [];
    collectStrings(field, '', strings);
    for (const { value } of strings) {
      const full = /^\$([\w$]+)$/.exec(value);
      if (full) sent.add(full[1]);
      for (const m of value.matchAll(/\$\{([\w$]+)\}/g)) sent.add(m[1]);
    }
  }
  if (sendsBody && typeof em.bodyTemplate === 'string') {
    for (const m of em.bodyTemplate.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
      sent.add(m[1]);
    }
  }
  return sent;
}

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
   * Category is the marketplace's filter axis: every distinct value becomes a
   * chip. `Sports` alongside `sports`, and `ecommerce` alongside `e-commerce`,
   * put the same concept behind two chips and split its adapters between them.
   * Lowercase kebab-case is the house format, so a stray capital or spelling
   * cannot quietly add a filter nobody meant to create.
   */
  it('categories are lowercase kebab-case', () => {
    const malformed = adapters
      .filter((a) => a.category && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(a.category))
      .map((a) => `${a.slug}: ${a.category}`);
    expect(malformed).toEqual([]);
  });

  it('every category is spelled one way only', () => {
    // Collapse the spellings that have actually collided before: separators
    // dropped (ecommerce/e-commerce) and singular/gerund pairs (maps/mapping).
    const key = (c: string) => c.replace(/-/g, '').replace(/ing$/, '');
    const byKey = new Map<string, Set<string>>();
    for (const a of adapters) {
      if (!a.category) continue;
      const k = key(a.category);
      byKey.set(k, (byKey.get(k) ?? new Set()).add(a.category));
    }
    const split = [...byKey.values()]
      .filter((v) => v.size > 1)
      .map((v) => [...v].sort().join(' / '));
    expect(split).toEqual([]);
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

  /**
   * The install probe runs immediately after import with no arguments, and
   * its result is what the install form reports. A probe tool with an
   * unsatisfied required parameter therefore tells the user their perfectly
   * good credential does not work.
   */
  it('every probe tool can run with the arguments the probe supplies', () => {
    const broken = adapters
      .map((m) => getAdapter(m.slug)!)
      .filter((a) => a.probe)
      .map((a) => {
        const tool = a.tools.find((t) => t.name === a.probe!.tool);
        if (!tool) return `${a.slug}: probe names unknown tool ${a.probe!.tool}`;
        const required =
          ((tool.parameters as { required?: string[] })?.required ?? []);
        const supplied = new Set(Object.keys(a.probe!.params ?? {}));
        const missing = required.filter((r) => !supplied.has(r));
        return missing.length ? `${a.slug}: probe needs ${missing.join(', ')}` : null;
      })
      .filter(Boolean);
    expect(broken).toEqual([]);
  });

  /**
   * A `{UPPER_SNAKE}` segment in a path is filled from the connector's env
   * vars, which ConnectorsService merges into the tool's params at call time.
   * Undeclared, the placeholder is never filled and every call 404s against a
   * URL containing a literal brace. Three adapters (fatture-in-cloud,
   * exact-online, moneybird) put the tenant id in the path this way.
   */
  it('every env-var path placeholder is a declared env var', () => {
    const broken: string[] = [];
    for (const meta of adapters) {
      const a = getAdapter(meta.slug)!;
      const declared = new Set([
        ...(a.requiredEnvVars ?? []),
        ...(a.optionalEnvVars ?? []),
      ]);
      for (const tool of a.tools) {
        const path = String(
          (tool.endpointMapping as { path?: unknown }).path ?? '',
        );
        for (const m of path.matchAll(/\{([A-Z][A-Z0-9_]*)\}/g)) {
          if (!declared.has(m[1])) {
            broken.push(`${a.slug}/${tool.name}: {${m[1]}} is not declared`);
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });

  /**
   * The reverse of the reference check further down: there, every `$x` must
   * be a declared argument; here, every declared argument must be sent. A
   * property nobody maps is accepted from the model and dropped before the
   * request, and the call still succeeds, so nothing tells the model its
   * argument did nothing (#890: MFR's create/update tools went out with an
   * empty body, Coda's bulk delete without its row ids, a "restrict to this
   * subreddit" search searched all of Reddit).
   *
   * REST tools only. GraphQL, database and MCP tools hand their arguments to
   * their engines by other rules, and OData built-ins and `static` tools do
   * not build an HTTP request from them at all.
   */
  it('every declared argument of a REST tool reaches the request', () => {
    const dropped: string[] = [];
    for (const meta of adapters) {
      const a = getAdapter(meta.slug)!;
      if (a.connector.type !== 'REST') continue;
      for (const tool of a.tools) {
        const em = tool.endpointMapping as Record<string, unknown>;
        if (!REST_HTTP_METHODS.has(String(em.method).toUpperCase())) continue;
        const sent = argumentsSent(em);
        const allowed = new Set(ARGS_NOT_SENT_BY_DESIGN[`${a.slug}/${tool.name}`] ?? []);
        const declared = Object.keys(
          ((tool.parameters as { properties?: Record<string, unknown> })?.properties) ?? {},
        );
        for (const name of declared) {
          if (!sent.has(name) && !allowed.has(name)) {
            dropped.push(`${a.slug}/${tool.name} (${String(em.method).toUpperCase()}): ${name}`);
          }
        }
      }
    }
    expect(dropped).toEqual([]);
  });

  /**
   * RestEngine builds no body for a GET, so a body mapping there is dead
   * configuration that looks like it sends something.
   */
  it('no REST tool maps a body on a method that sends none', () => {
    const dead: string[] = [];
    for (const meta of adapters) {
      const a = getAdapter(meta.slug)!;
      if (a.connector.type !== 'REST') continue;
      for (const tool of a.tools) {
        const em = tool.endpointMapping as Record<string, unknown>;
        const method = String(em.method).toUpperCase();
        if (!REST_HTTP_METHODS.has(method) || REQUEST_BODY_METHODS.has(method)) continue;
        if (em.bodyMapping !== undefined || em.bodyTemplate !== undefined) {
          dead.push(`${a.slug}/${tool.name} (${method})`);
        }
      }
    }
    expect(dead).toEqual([]);
  });

  /** An exception that no longer matches anything is a stale excuse. */
  it('every ARGS_NOT_SENT_BY_DESIGN entry names a declared, unsent argument', () => {
    const stale: string[] = [];
    for (const [key, names] of Object.entries(ARGS_NOT_SENT_BY_DESIGN)) {
      const [slug, toolName] = key.split('/');
      const tool = getAdapter(slug)?.tools.find((t) => t.name === toolName);
      if (!tool) {
        stale.push(`${key}: no such tool`);
        continue;
      }
      const em = tool.endpointMapping as Record<string, unknown>;
      const sent = argumentsSent(em);
      const declared = new Set(
        Object.keys(((tool.parameters as { properties?: Record<string, unknown> })?.properties) ?? {}),
      );
      for (const name of names) {
        if (!declared.has(name)) stale.push(`${key}: ${name} is not declared`);
        else if (sent.has(name)) stale.push(`${key}: ${name} is sent after all`);
      }
    }
    expect(stale).toEqual([]);
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
        // Same rule as LoginTokenService: a token read from a cookie has no
        // JSON path, it names the cookie instead.
        if (cfg.tokenSource === 'cookie') {
          expect(typeof cfg.cookieName).toBe('string');
        } else {
          expect(typeof cfg.tokenJsonPath).toBe('string');
        }
        // performLogin refuses to start without both, even when the body
        // does not use them.
        expect(typeof cfg.username).toBe('string');
        expect(typeof cfg.password).toBe('string');
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

    if (adapter.connector.authType === 'LOGIN_TOKEN') {
      /**
       * Two LoginTokenService behaviours only bite on a GET login, and both
       * produced a silently wrong request in shipped adapters before this
       * existed (glpi, synology):
       *
       * - `loginUrl` is used verbatim and never interpolated, so a
       *   `${username}` written there is sent as those ten characters.
       * - With no `loginBody`, every template param — including the
       *   password — becomes a query parameter, i.e. lands in the upstream's
       *   access log.
       *
       * Credentials belong in `loginBody`, which is interpolated, or in
       * `loginHeaders`. A GET login that genuinely needs no parameters must
       * say so with an explicit empty `loginBody`.
       */
      it('login request is built from interpolated fields, not the URL', () => {
        const cfg = adapter.connector.authConfig as Record<string, unknown>;
        expect(String(cfg.loginUrl ?? '')).not.toMatch(/\$\{/);
        const method = String(cfg.loginMethod ?? 'POST').toUpperCase();
        if (method === 'GET') {
          const hasBody =
            cfg.loginBody !== undefined || cfg.loginBodyTemplate !== undefined;
          expect(hasBody).toBe(true);
        }
      });
    }

    it.each(adapter.tools.map((t) => [t.name, t]))(
      '%s has a well-formed endpointMapping',
      (_name, tool) => {
        const em = tool.endpointMapping as Record<string, unknown>;

        // A tool of a vendor's MCP server is called by name on the remote
        // server: `method` is that name and `path` the MCP endpoint, not an
        // HTTP verb and URL.
        if (adapter.connector.type === 'MCP') {
          expect(em.method).toBe(tool.name);
          expect(typeof em.path).toBe('string');
          return;
        }

        const isDatabase = adapter.connector.type === 'DATABASE';
        const allowed = isDatabase
          ? VALID_DATABASE_METHODS
          : adapter.connector.type === 'GRAPHQL'
            ? VALID_GRAPHQL_METHODS
            : VALID_REST_METHODS;
        const method = String(em.method).toUpperCase();
        const odataBuiltin =
          VALID_ODATA_BUILTIN_METHODS.has(method) &&
          (adapter.connector.type === 'ODATA' ||
            !!(adapter.connector as { config?: { odata?: unknown } }).config?.odata);
        expect(allowed.has(method) || odataBuiltin).toBe(true);
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

        // …nor $UPPER_SNAKE. RestEngine.resolveValue honours `$VAR` in
        // queryParams, bodyMapping and headers, but the path is interpolated
        // by a plain `{key}` replace, so `/c/$FIC_COMPANY_ID/clients` ships
        // the literal dollar sign to the vendor and 404s. Env vars reach the
        // path as `{FIC_COMPANY_ID}` — they are merged into params at call
        // time (ConnectorsService.mergedParams). Lower-case `$metadata` and
        // `$links` are OData's own literals and are left alone.
        expect(em.path as string).not.toMatch(/\$[A-Z][A-Z0-9_]*\b/);

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
