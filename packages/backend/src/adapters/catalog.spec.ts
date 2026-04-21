import { listAdapters, getAdapter } from './catalog';

const VALID_AUTH_TYPES = new Set([
  'NONE',
  'API_KEY',
  'BEARER_TOKEN',
  'BASIC_AUTH',
  'OAUTH2',
  'QUERY_AUTH',
]);

const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

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

  describe.each(adapters)('$slug', (meta) => {
    const adapter = getAdapter(meta.slug)!;

    it('has a valid connector authType', () => {
      expect(VALID_AUTH_TYPES.has(adapter.connector.authType)).toBe(true);
    });

    it('declares at least one tool', () => {
      expect(adapter.tools.length).toBeGreaterThan(0);
    });

    it.each(adapter.tools.map((t) => [t.name, t]))(
      '%s has a well-formed endpointMapping',
      (_name, tool) => {
        const em = tool.endpointMapping as Record<string, unknown>;

        expect(VALID_METHODS.has(String(em.method).toUpperCase())).toBe(true);
        expect(typeof em.path).toBe('string');

        // Legacy `body` field must be renamed to `bodyMapping`/`bodyTemplate`
        expect(em).not.toHaveProperty('body');

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
            // Full-string reference: "$foo" → must be declared, unless it's an env placeholder
            const full = /^\$([\w$]+)$/.exec(value);
            if (full && !value.startsWith('$$')) {
              expect(declaredParams.has(full[1])).toBe(true);
            }
            // Embedded references: "...${foo}..." — all names must be declared
            for (const match of value.matchAll(/\$\{([\w$]+)\}/g)) {
              expect(declaredParams.has(match[1])).toBe(true);
            }
          }
        }
      },
    );
  });
});
