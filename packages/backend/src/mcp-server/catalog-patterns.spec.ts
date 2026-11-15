import { getAdapter, listAdapters } from '../adapters/catalog';
import {
  ArgumentPatternError,
  catalogPatternViolations,
  MAX_CHECKED_LENGTH,
  patternErrorMessage,
} from './catalog-patterns';

const etsyListing = () => getAdapter('etsy')!.tools.find((t) => t.name === 'etsy_get_listing')!;
const storedOf = (slug: string, tool: string) =>
  JSON.parse(JSON.stringify(getAdapter(slug)!.tools.find((t) => t.name === tool)!.parameters));

describe('catalogPatternViolations', () => {
  const check = (args: Record<string, unknown>, stored = storedOf('etsy', 'etsy_get_listing')) =>
    catalogPatternViolations('etsy', 'etsy_get_listing', stored, args);

  it('refuses a value outside the declared pattern, with the rule in words', () => {
    const [violation, ...rest] = check({ listing_id: '1', includes: 'Images,Inventory' });
    expect(rest).toEqual([]);
    expect(violation).toMatchObject({ param: 'includes', value: 'Images,Inventory' });
    expect(violation.description).toMatch(/etsy_read_listing_inventory/);
    expect(violation.pattern).toBe((etsyListing().parameters as any).properties.includes.pattern);
  });

  it('lets through what the vendor accepts', () => {
    // Etsy compares the names without regard to case: both worked in production.
    expect(check({ includes: 'Images,Videos' })).toEqual([]);
    expect(check({ includes: 'images,videos' })).toEqual([]);
    expect(check({ includes: 'personalization' })).toEqual([]);
    expect(check({})).toEqual([]);
  });

  it('checks only strings, and only up to the length cap', () => {
    expect(check({ includes: 42 })).toEqual([]);
    expect(check({ includes: null })).toEqual([]);
    expect(check({ includes: ['Inventory'] })).toEqual([]);
    expect(check({ includes: 'x'.repeat(MAX_CHECKED_LENGTH + 1) })).toEqual([]);
    expect(check({ includes: 'x'.repeat(MAX_CHECKED_LENGTH) })).toHaveLength(1);
  });

  it('leaves a tool alone once the workspace changed or removed the pattern', () => {
    const edited = storedOf('etsy', 'etsy_get_listing');
    edited.properties.includes.pattern = '^.*$';
    expect(check({ includes: 'Inventory' }, edited)).toEqual([]);
    delete edited.properties.includes.pattern;
    expect(check({ includes: 'Inventory' }, edited)).toEqual([]);
    expect(check({ includes: 'Inventory' }, { type: 'object' })).toEqual([]);
    expect(catalogPatternViolations('etsy', 'etsy_get_listing', undefined, { includes: 'Inventory' })).toEqual([]);
  });

  it('never runs an expression that is only in the stored schema', () => {
    const stored = storedOf('etsy', 'etsy_get_listing');
    // An expression that would never finish, on an argument the catalog has no pattern for.
    stored.properties.listing_id = { type: 'string', pattern: '^(a+)+$' };
    const started = Date.now();
    expect(check({ listing_id: `${'a'.repeat(60)}!` }, stored)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('checks nothing for hand-built tools and unknown adapters', () => {
    const stored = storedOf('etsy', 'etsy_get_listing');
    expect(catalogPatternViolations(undefined, 'etsy_get_listing', stored, { includes: 'Inventory' })).toEqual([]);
    expect(catalogPatternViolations('no-such-adapter', 'etsy_get_listing', stored, { includes: 'Inventory' })).toEqual([]);
    expect(catalogPatternViolations('etsy', 'my_own_tool', stored, { includes: 'Inventory' })).toEqual([]);
  });

  it('accepts a Binance symbol that is not ASCII, and still refuses lower case', () => {
    const stored = storedOf('binance', 'binance_get_klines');
    const klines = (symbol: string) => catalogPatternViolations('binance', 'binance_get_klines', stored, { symbol });
    expect(klines('BTCUSDT')).toEqual([]);
    expect(klines('牛来USDT')).toEqual([]);
    expect(klines('btcusdt')).toHaveLength(1);
  });

  it('checks the items of an array argument', () => {
    // The first catalog tool with a pattern on array items, whichever it is.
    let found: { slug: string; tool: string; param: string } | undefined;
    for (const meta of listAdapters()) {
      for (const tool of getAdapter(meta.slug)?.tools ?? []) {
        for (const [param, prop] of Object.entries<any>((tool.parameters as any)?.properties ?? {})) {
          if (!found && prop?.type === 'array' && prop.items?.type === 'string' && prop.items.pattern) {
            found = { slug: meta.slug, tool: tool.name, param };
          }
        }
      }
    }
    expect(found).toBeDefined();
    const stored = storedOf(found!.slug, found!.tool);
    const out = catalogPatternViolations(found!.slug, found!.tool, stored, { [found!.param]: ['\u0000 not this \u0000'] });
    expect(out).toHaveLength(1);
    expect(out[0].param).toBe(found!.param);
  });
});

describe('patternErrorMessage', () => {
  it('reads as an instruction and says nothing was sent', () => {
    const error = new ArgumentPatternError([
      { param: 'includes', pattern: '^(Images)$', value: 'Inventory', description: 'Any of: Images.' },
    ]);
    expect(error.code).toBe('INVALID_ARGUMENT');
    expect(error.message).toBe(
      '`includes` cannot be "Inventory". Any of: Images. It must match ^(Images)$ ' +
        'No request was sent to the API: correct the argument and call again.',
    );
    expect(patternErrorMessage([error.violations[0], error.violations[0]])).toMatch(/correct the arguments and call again/);
  });
});

/**
 * Every expression the catalog declares is run on text a caller chose. This
 * guards the catalog itself: an expression that needs more than a moment on a
 * hostile input fails here, in CI, not in production.
 */
describe('catalog patterns are safe to run on untrusted text', () => {
  const sources = new Map<string, string>();
  for (const meta of listAdapters()) {
    for (const tool of getAdapter(meta.slug)?.tools ?? []) {
      for (const [param, prop] of Object.entries<any>((tool.parameters as any)?.properties ?? {})) {
        const pattern = prop?.type === 'string' ? prop.pattern : prop?.type === 'array' ? prop.items?.pattern : undefined;
        if (typeof pattern === 'string' && !sources.has(pattern)) sources.set(pattern, `${meta.slug} ${tool.name}.${param}`);
      }
    }
  }

  it('finds the catalog patterns', () => {
    expect(sources.size).toBeGreaterThan(100);
  });

  it('every pattern compiles and uses no backreference', () => {
    const broken: string[] = [];
    for (const [source, where] of sources) {
      try {
        new RegExp(source);
      } catch {
        broken.push(`${where}: does not compile: ${source}`);
        continue;
      }
      if (/\\[1-9]|\\k</.test(source.replace(/\\\\/g, ''))) broken.push(`${where}: backreference: ${source}`);
    }
    expect(broken).toEqual([]);
  });

  /**
   * Text built to make a backtracking engine work: one short unit repeated,
   * ended by a character that makes the whole match fail. Units come from the
   * expression's own literal characters, so the text gets past its fixed parts.
   */
  function hostileTexts(source: string, length: number): string[] {
    const plain = source.replace(/\\[dDwWsSbBnrtu]/g, '').replace(/[\\^$.*+?()[\]{}|]/g, '');
    const literals = [...new Set(plain)].slice(0, 24);
    const words = [...new Set(plain.replace(/[^A-Za-z0-9]/g, ''))].slice(0, 4);
    const fills = ['a', 'A', '0', 'a ', ' a', ...words];
    for (const first of words) for (const second of words) fills.push(first + second);
    const separators = [',', ';', '|', '/', '.', '-', '_', ' ', '"', '=', ':'].filter((c) => source.includes(c));
    const units = new Set<string>([...literals, 'a', 'A', '0', ' ', '\t']);
    for (const sep of separators) for (const fill of fills) units.add(sep + fill);
    // The literal opening of the expression (through group openings), so the repeated part is reached.
    const opening =
      /^((?:\\[^A-Za-z0-9]|[^\\^$.*+?()[\]{}|A-Za-z0-9]){1,4})/
        .exec(source.replace(/^\^/, '').replace(/\((?:\?:)?/g, ''))?.[1]
        .replace(/\\/g, '') ?? '';
    const texts: string[] = [];
    for (const unit of [...units].slice(0, 80)) {
      if (!unit) continue;
      const body = unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
      for (const head of new Set(['', opening])) {
        for (const tail of ['', '\u0000', '\n']) texts.push((head + body).slice(0, length - tail.length) + tail);
      }
    }
    return texts;
  }

  it('no pattern needs more than a moment on a hostile text', () => {
    const BUDGET_MS = 300;
    // Small steps: an expression whose time doubles every few characters goes
    // over the budget at one of them and fails the test, instead of passing a
    // short text and never finishing the next, much longer one.
    const lengths: number[] = [];
    for (let n = 8; n <= 120; n += 4) lengths.push(n);
    for (let n = 128; n <= 512; n += 8) lengths.push(n);
    lengths.push(1024, MAX_CHECKED_LENGTH);
    const slow: string[] = [];
    for (const [source, where] of sources) {
      const regex = new RegExp(source);
      let worst = 0;
      scan: for (const length of lengths) {
        for (const text of hostileTexts(source, length)) {
          const started = process.hrtime.bigint();
          regex.test(text);
          const ms = Number(process.hrtime.bigint() - started) / 1e6;
          if (ms > worst) worst = ms;
          if (ms > BUDGET_MS) {
            slow.push(`${where}: ${Math.round(ms)} ms on ${length} characters: ${source}`);
            break scan;
          }
        }
      }
    }
    expect(slow).toEqual([]);
  });

  it('the check itself catches a slow expression', () => {
    const regex = /^(a+)+$/;
    const started = process.hrtime.bigint();
    regex.test(`${'a'.repeat(27)}!`);
    expect(Number(process.hrtime.bigint() - started) / 1e6).toBeGreaterThan(50);
  });
});
