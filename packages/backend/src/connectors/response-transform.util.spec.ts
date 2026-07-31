import {
  applyResponseTransform,
  hasTransform,
  parsePath,
  readTransform,
  validateTransform,
} from './response-transform.util';

/** Datto RMM-shaped payload — the case that motivated the feature. */
const DATTO = {
  pageDetails: { count: 2, totalCount: 812, nextPageUrl: 'https://api/v2/account/devices?page=2' },
  devices: [
    {
      id: 1,
      uid: 'u-1',
      siteName: 'HQ',
      hostname: 'PC-01',
      deviceType: { category: 'Desktop', type: 'Workstation' },
      operatingSystem: 'Windows 11',
      online: true,
      suspended: false,
      antivirus: { antivirusStatus: 'RunningAndUpToDate', antivirusProduct: 'Defender' },
      patchManagement: { patchStatus: 'FullyPatched' },
      udf: { udf1: 'x', udf2: 'y' },
      internalToken: 'secret',
    },
    {
      id: 2,
      uid: 'u-2',
      siteName: 'Branch',
      hostname: 'PC-02',
      deviceType: { category: 'Laptop', type: 'Workstation' },
      operatingSystem: 'Windows 10',
      online: false,
      suspended: false,
      antivirus: { antivirusStatus: 'NotInstalled' },
      patchManagement: { patchStatus: 'NoPolicy' },
      udf: { udf1: 'z' },
      internalToken: 'secret2',
    },
  ],
};

describe('parsePath', () => {
  it('parses dotted paths with an optional $ root', () => {
    expect(parsePath('$.a.b')).toEqual([
      { kind: 'key', name: 'a' },
      { kind: 'key', name: 'b' },
    ]);
    expect(parsePath('a.b')).toEqual(parsePath('$.a.b'));
    expect(parsePath('$a')).toEqual([{ kind: 'key', name: 'a' }]);
  });

  it('parses wildcards, indexes and quoted keys', () => {
    expect(parsePath('devices[*].id')).toEqual([
      { kind: 'key', name: 'devices' },
      { kind: 'wildcard' },
      { kind: 'key', name: 'id' },
    ]);
    expect(parsePath('a[0]')).toEqual([{ kind: 'key', name: 'a' }, { kind: 'index', index: 0 }]);
    expect(parsePath('a[-1]')).toEqual([{ kind: 'key', name: 'a' }, { kind: 'index', index: -1 }]);
    expect(parsePath("a['weird.key']")).toEqual([
      { kind: 'key', name: 'a' },
      { kind: 'key', name: 'weird.key' },
    ]);
  });

  it('rejects malformed and unsafe paths', () => {
    expect(() => parsePath('a[')).toThrow(/Unclosed/);
    expect(() => parsePath('a[x]')).toThrow(/Invalid array index/);
    expect(() => parsePath('')).toThrow(/Empty path/);
    expect(() => parsePath('__proto__.x')).toThrow(/Unsafe/);
    expect(() => parsePath('a.constructor')).toThrow(/Unsafe/);
    expect(() => parsePath('a.b.c.d.e.f.g.h'.repeat(10))).toThrow(/too deep/);
  });
});

describe('readTransform / hasTransform', () => {
  it('returns null when there is nothing to do', () => {
    expect(readTransform(undefined)).toBeNull();
    expect(readTransform(null)).toBeNull();
    expect(readTransform({})).toBeNull();
    expect(readTransform({ cacheTtl: 300, followUp: 'next' })).toBeNull();
    expect(readTransform({ transform: {} })).toBeNull();
    expect(readTransform({ transform: { mode: 'off', select: { a: 'a' } } })).toBeNull();
    expect(hasTransform({ cacheTtl: 60 })).toBe(false);
  });

  it('honours the legacy documented `fields` shape as an include list', () => {
    expect(readTransform({ type: 'json', fields: ['a', 'b.c'] })).toEqual({
      include: ['a', 'b.c'],
    });
    expect(hasTransform({ type: 'json', fields: ['a'] })).toBe(true);
  });
});

describe('applyResponseTransform — no-op path', () => {
  it('returns the very same reference when no transform is configured', () => {
    const raw = { a: 1 };
    for (const rm of [undefined, null, {}, { cacheTtl: 300 }, { followUp: 'x' }] as any[]) {
      const out = applyResponseTransform(raw, rm);
      expect(out.applied).toBe(false);
      expect(out.value).toBe(raw); // identity, not just deep equality
      expect(out.error).toBeUndefined();
    }
  });

  it('is a no-op for mode "off"', () => {
    const raw = { a: 1 };
    const out = applyResponseTransform(raw, { transform: { mode: 'off', select: { x: 'a' } } });
    expect(out.applied).toBe(false);
    expect(out.value).toBe(raw);
  });
});

describe('applyResponseTransform — select mode', () => {
  it('reshapes the motivating Datto RMM response', () => {
    const out = applyResponseTransform(DATTO, {
      transform: {
        select: {
          page: {
            count: '$.pageDetails.count',
            totalCount: '$.pageDetails.totalCount',
            nextPageUrl: '$.pageDetails.nextPageUrl',
          },
          devices: {
            $from: '$.devices[*]',
            $select: {
              id: 'id',
              hostname: 'hostname',
              siteName: 'siteName',
              category: 'deviceType.category',
              operatingSystem: 'operatingSystem',
              online: 'online',
              antivirusStatus: 'antivirus.antivirusStatus',
              patchStatus: 'patchManagement.patchStatus',
            },
          },
        },
      },
    });

    expect(out.applied).toBe(true);
    expect(out.error).toBeUndefined();
    expect(out.value).toEqual({
      page: { count: 2, totalCount: 812, nextPageUrl: 'https://api/v2/account/devices?page=2' },
      devices: [
        {
          id: 1,
          hostname: 'PC-01',
          siteName: 'HQ',
          category: 'Desktop',
          operatingSystem: 'Windows 11',
          online: true,
          antivirusStatus: 'RunningAndUpToDate',
          patchStatus: 'FullyPatched',
        },
        {
          id: 2,
          hostname: 'PC-02',
          siteName: 'Branch',
          category: 'Laptop',
          operatingSystem: 'Windows 10',
          online: false,
          antivirusStatus: 'NotInstalled',
          patchStatus: 'NoPolicy',
        },
      ],
    });
  });

  it('shrinks the payload substantially', () => {
    const before = JSON.stringify(DATTO).length;
    const after = JSON.stringify(
      applyResponseTransform(DATTO, {
        transform: {
          select: { devices: { $from: 'devices[*]', $select: { hostname: 'hostname' } } },
        },
      }).value,
    ).length;
    expect(after).toBeLessThan(before / 4);
  });

  it('omits keys whose path does not resolve, rather than emitting null', () => {
    const out = applyResponseTransform({ a: 1 }, { transform: { select: { a: 'a', b: 'missing.path' } } });
    expect(out.value).toEqual({ a: 1 });
    expect(Object.keys(out.value as object)).not.toContain('b');
  });

  it('keeps falsy values that do exist', () => {
    const out = applyResponseTransform(
      { zero: 0, empty: '', no: false, nil: null },
      { transform: { select: { zero: 'zero', empty: 'empty', no: 'no', nil: 'nil' } } },
    );
    expect(out.value).toEqual({ zero: 0, empty: '', no: false, nil: null });
  });

  it('supports wildcards, indexes and negative indexes', () => {
    const doc = { items: [{ n: 1 }, { n: 2 }, { n: 3 }] };
    expect(
      applyResponseTransform(doc, {
        transform: { select: { all: 'items[*].n', first: 'items[0].n', last: 'items[-1].n' } },
      }).value,
    ).toEqual({ all: [1, 2, 3], first: 1, last: 3 });
  });

  it('skips array elements missing the projected field', () => {
    const doc = { items: [{ n: 1 }, { other: 2 }, { n: 3 }] };
    expect(applyResponseTransform(doc, { transform: { select: { ns: 'items[*].n' } } }).value).toEqual({
      ns: [1, 3],
    });
  });

  it('walks object values with a wildcard', () => {
    const doc = { byId: { a: { n: 1 }, b: { n: 2 } } };
    expect(applyResponseTransform(doc, { transform: { select: { ns: 'byId[*].n' } } }).value).toEqual({
      ns: [1, 2],
    });
  });

  it('supports static literals and passthrough scalars', () => {
    const out = applyResponseTransform(
      { a: 1 },
      {
        transform: {
          select: {
            source: '= datto-rmm',
            tight: '=x',
            version: 2,
            enabled: true,
            nothing: null,
          },
        },
      },
    );
    expect(out.value).toEqual({
      source: 'datto-rmm',
      tight: 'x',
      version: 2,
      enabled: true,
      nothing: null,
    });
  });

  it('supports nested templates and arrays of specs', () => {
    const out = applyResponseTransform(
      { a: { b: 1 }, c: 2 },
      { transform: { select: { deep: { inner: { value: 'a.b' } }, list: ['a.b', 'c', 'missing'] } } },
    );
    expect(out.value).toEqual({ deep: { inner: { value: 1 } }, list: [1, 2] });
  });

  it('$from without $select returns the raw elements', () => {
    const out = applyResponseTransform(
      { items: [{ a: 1 }, { a: 2 }] },
      { transform: { select: { items: { $from: 'items[*]' } } } },
    );
    expect(out.value).toEqual({ items: [{ a: 1 }, { a: 2 }] });
  });

  it('$from on a non-array wraps a single object, and on a missing path omits the key', () => {
    expect(
      applyResponseTransform(
        { one: { a: 1 } },
        { transform: { select: { list: { $from: 'one', $select: { a: 'a' } } } } },
      ).value,
    ).toEqual({ list: [{ a: 1 }] });

    expect(
      applyResponseTransform(
        {},
        { transform: { select: { list: { $from: 'nope', $select: { a: 'a' } } } } },
      ).value,
    ).toEqual({});
  });

  it('$limit caps the number of mapped elements', () => {
    const out = applyResponseTransform(
      { items: [{ a: 1 }, { a: 2 }, { a: 3 }] },
      { transform: { select: { items: { $from: 'items[*]', $limit: 2, $select: { a: 'a' } } } } },
    );
    expect(out.value).toEqual({ items: [{ a: 1 }, { a: 2 }] });
  });

  it('handles an empty array and a root-level array', () => {
    expect(
      applyResponseTransform({ items: [] }, { transform: { select: { items: { $from: 'items[*]', $select: { a: 'a' } } } } })
        .value,
    ).toEqual({ items: [] });

    expect(
      applyResponseTransform([{ a: 1 }, { a: 2 }], {
        transform: { select: { rows: { $from: '$[*]', $select: { a: 'a' } } } },
      }).value,
    ).toEqual({ rows: [{ a: 1 }, { a: 2 }] });
  });

  it('handles a scalar or null root without throwing', () => {
    expect(applyResponseTransform('plain text', { transform: { select: { a: 'a' } } }).value).toEqual({});
    expect(applyResponseTransform(null, { transform: { select: { a: 'a' } } }).value).toEqual({});
  });
});

describe('applyResponseTransform — include / exclude', () => {
  it('excludes nested paths across an array with a wildcard', () => {
    const out = applyResponseTransform(DATTO, {
      transform: { exclude: ['devices[*].udf', 'devices[*].internalToken', 'pageDetails.nextPageUrl'] },
    });
    const value = out.value as typeof DATTO;
    expect(out.applied).toBe(true);
    expect(value.devices[0]).not.toHaveProperty('udf');
    expect(value.devices[0]).not.toHaveProperty('internalToken');
    expect(value.devices[0].hostname).toBe('PC-01');
    expect(value.pageDetails).toEqual({ count: 2, totalCount: 812 });
  });

  it('does not mutate the raw response', () => {
    const before = JSON.stringify(DATTO);
    applyResponseTransform(DATTO, { transform: { exclude: ['devices[*].udf'] } });
    expect(JSON.stringify(DATTO)).toBe(before);
  });

  it('excluding a missing path is a no-op', () => {
    expect(applyResponseTransform({ a: 1 }, { transform: { exclude: ['b.c'] } }).value).toEqual({ a: 1 });
  });

  it('includes only the listed paths, preserving shape', () => {
    const out = applyResponseTransform(DATTO, {
      transform: { include: ['pageDetails.totalCount', 'devices[*].hostname', 'devices[*].online'] },
    });
    expect(out.value).toEqual({
      pageDetails: { totalCount: 812 },
      devices: [
        { hostname: 'PC-01', online: true },
        { hostname: 'PC-02', online: false },
      ],
    });
  });

  it('applies exclude before select', () => {
    const out = applyResponseTransform(
      { a: { keep: 1, drop: 2 } },
      { transform: { exclude: ['a.drop'], select: { a: 'a' } } },
    );
    expect(out.value).toEqual({ a: { keep: 1 } });
  });

  it('keeps element positions when including a single array index', () => {
    const out = applyResponseTransform(
      { items: [{ a: 1, b: 9 }, { a: 2, b: 9 }, { a: 3, b: 9 }] },
      { transform: { include: ['items[1].a'] } },
    );
    // Positions preserved, and the result must be a dense array — a sparse one
    // would serialize with stray nulls and confuse the calling agent.
    const items = (out.value as { items: unknown[] }).items;
    expect(items).toHaveLength(3);
    expect(items[1]).toEqual({ a: 2 });
    expect(JSON.parse(JSON.stringify(items))).toEqual([null, { a: 2 }, null]);
  });

  it('excludes a field under a single array index without dropping siblings', () => {
    const out = applyResponseTransform(
      { items: [{ a: 1, b: 2 }, { a: 3, b: 4 }] },
      { transform: { exclude: ['items[0].b'] } },
    );
    expect(out.value).toEqual({ items: [{ a: 1 }, { a: 3, b: 4 }] });
  });

  it('runs the legacy `fields` list as an include', () => {
    const out = applyResponseTransform(DATTO, { type: 'json', fields: ['pageDetails.count'] });
    expect(out.applied).toBe(true);
    expect(out.value).toEqual({ pageDetails: { count: 2 } });
  });
});

describe('applyResponseTransform — jmespath mode', () => {
  it('evaluates an expression, including computed values', () => {
    const out = applyResponseTransform(DATTO, {
      transform: {
        mode: 'jmespath',
        expression: '{ total: length(devices), offline: devices[?online == `false`].hostname }',
      },
    });
    expect(out.applied).toBe(true);
    expect(out.value).toEqual({ total: 2, offline: ['PC-02'] });
  });

  it('infers jmespath mode from the presence of an expression', () => {
    const out = applyResponseTransform(DATTO, { transform: { expression: 'devices[*].hostname' } });
    expect(out.value).toEqual(['PC-01', 'PC-02']);
  });

  it('falls back to raw on an invalid expression', () => {
    const out = applyResponseTransform(DATTO, { transform: { mode: 'jmespath', expression: '((((' } });
    expect(out.applied).toBe(false);
    expect(out.value).toBe(DATTO);
    expect(out.error).toBeTruthy();
    expect(out.fatal).toBe(false);
  });

  it('rejects an over-long expression', () => {
    const out = applyResponseTransform(DATTO, {
      transform: { mode: 'jmespath', expression: 'a'.repeat(5000) },
    });
    expect(out.applied).toBe(false);
    expect(out.error).toMatch(/too long/);
  });
});

describe('applyResponseTransform — failure handling', () => {
  it('falls back to the raw response by default', () => {
    const out = applyResponseTransform(DATTO, { transform: { select: { a: 'a[' } } });
    expect(out.applied).toBe(false);
    expect(out.value).toBe(DATTO);
    expect(out.error).toMatch(/Unclosed/);
    expect(out.fatal).toBe(false);
  });

  it('marks the outcome fatal when fallbackToRaw is false', () => {
    const out = applyResponseTransform(DATTO, {
      transform: { fallbackToRaw: false, select: { a: 'a[' } },
    });
    expect(out.applied).toBe(false);
    expect(out.fatal).toBe(true);
    expect(out.error).toBeTruthy();
  });

  it('rejects a non-array include/exclude', () => {
    const out = applyResponseTransform(DATTO, { transform: { include: 'a' as any } });
    expect(out.applied).toBe(false);
    expect(out.error).toMatch(/must be an array/);
  });
});

describe('applyResponseTransform — security and limits', () => {
  it('never pollutes Object.prototype from template keys', () => {
    // Built via JSON.parse so "__proto__" is a real own property — an object
    // literal would instead invoke the prototype setter and test nothing.
    const select = JSON.parse('{"__proto__": {"polluted": "= yes"}, "ok": "a"}');
    expect(Object.prototype.hasOwnProperty.call(select, '__proto__')).toBe(true);
    const out = applyResponseTransform({ a: 1 }, { transform: { select } });
    expect(({} as any).polluted).toBeUndefined();
    expect(out.value).toEqual({ ok: 1 });
    expect(Object.getPrototypeOf(out.value)).toBe(Object.prototype);
  });

  it('never pollutes Object.prototype from upstream keys during exclude', () => {
    const hostile = JSON.parse('{"a": 1, "__proto__": {"polluted": "yes"}}');
    applyResponseTransform(hostile, { transform: { exclude: ['a'] } });
    expect(({} as any).polluted).toBeUndefined();
  });

  it('refuses to traverse prototype paths', () => {
    const out = applyResponseTransform({ a: 1 }, { transform: { select: { x: 'constructor.name' } } });
    expect(out.applied).toBe(false);
    expect(out.error).toMatch(/Unsafe/);
  });

  it('rejects a template nested past the depth limit', () => {
    let deep: Record<string, unknown> = { leaf: 'a' };
    for (let i = 0; i < 15; i++) deep = { nest: deep };
    const out = applyResponseTransform({ a: 1 }, { transform: { select: deep } });
    expect(out.applied).toBe(false);
    expect(out.error).toMatch(/too deeply/);
  });

  it('rejects an over-long include list', () => {
    const out = applyResponseTransform({ a: 1 }, {
      transform: { include: Array.from({ length: 501 }, (_, i) => `f${i}`) },
    });
    expect(out.applied).toBe(false);
    expect(out.error).toMatch(/too many entries/);
  });

  it('caps the output at maxBytes for arrays', () => {
    const doc = { rows: Array.from({ length: 200 }, (_, i) => ({ i, pad: 'x'.repeat(50) })) };
    const out = applyResponseTransform(doc, {
      transform: { expression: 'rows', maxBytes: 500 },
    });
    expect(out.truncated).toBe(true);
    const value = out.value as { _truncated: boolean; items: unknown[] };
    expect(value._truncated).toBe(true);
    expect(value.items.length).toBeGreaterThan(0);
    expect(value.items.length).toBeLessThan(200);
    expect(JSON.stringify(out.value).length).toBeLessThan(1200);
  });

  it('caps the output at maxBytes for objects', () => {
    const doc = { blob: 'x'.repeat(5000) };
    const out = applyResponseTransform(doc, { transform: { select: { blob: 'blob' }, maxBytes: 200 } });
    expect(out.truncated).toBe(true);
    expect((out.value as any)._truncated).toBe(true);
    expect((out.value as any).preview).toHaveLength(200);
  });

  it('leaves output under maxBytes untouched', () => {
    const out = applyResponseTransform({ a: 1 }, { transform: { select: { a: 'a' }, maxBytes: 10_000 } });
    expect(out.truncated).toBe(false);
    expect(out.value).toEqual({ a: 1 });
  });
});

describe('validateTransform', () => {
  it('accepts an empty / absent config', () => {
    expect(validateTransform(undefined)).toBeNull();
    expect(validateTransform(null)).toBeNull();
    expect(validateTransform({})).toBeNull();
  });

  it('accepts a well-formed select template', () => {
    expect(
      validateTransform({
        select: { page: { count: '$.pageDetails.count' }, devices: { $from: 'devices[*]', $select: { id: 'id' } } },
      }),
    ).toBeNull();
  });

  it('accepts a valid jmespath expression', () => {
    expect(validateTransform({ mode: 'jmespath', expression: 'devices[*].hostname' })).toBeNull();
  });

  it('accepts function calls that would type-error against an empty document', () => {
    // Regression: validation used to *evaluate* the expression against `{}`,
    // so `length(products)` — valid, and the main reason to reach for JMESPath
    // — was rejected with a 400 because `products` resolved to null.
    expect(validateTransform({ mode: 'jmespath', expression: 'length(products)' })).toBeNull();
    expect(
      validateTransform({
        mode: 'jmespath',
        expression: '{count: length(products), titles: products[*].title}',
      }),
    ).toBeNull();
    expect(validateTransform({ expression: 'sort_by(devices, &hostname)' })).toBeNull();
    expect(validateTransform({ expression: 'max(prices) - min(prices)' })).toBeNull();
  });

  it('rejects malformed configs with an actionable message', () => {
    expect(validateTransform('nope')).toMatch(/must be an object/);
    expect(validateTransform({ mode: 'magic' })).toMatch(/Unknown mode/);
    expect(validateTransform({ mode: 'jmespath' })).toMatch(/requires an expression/);
    expect(validateTransform({ mode: 'jmespath', expression: '((((' })).toBeTruthy();
    expect(validateTransform({ select: 'x' })).toMatch(/must be an object/);
    expect(validateTransform({ select: { a: 'b[' } })).toMatch(/Unclosed/);
    expect(validateTransform({ select: { a: { $from: 42 } } })).toMatch(/\$from/);
    expect(validateTransform({ select: { a: { $from: 'x', $select: 'y' } } })).toMatch(/\$select/);
    expect(validateTransform({ include: 'a' })).toMatch(/must be an array/);
    expect(validateTransform({ exclude: [''] })).toMatch(/non-empty strings/);
    expect(validateTransform({ maxBytes: -1 })).toMatch(/non-negative/);
    expect(validateTransform({ fallbackToRaw: 'yes' })).toMatch(/boolean/);
    expect(validateTransform({ expression: 'a'.repeat(5000) })).toMatch(/too long/);
  });
});
