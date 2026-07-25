import {
  annotationsSignature,
  deriveToolAnnotations,
  parseAnnotationsOverride,
} from './tool-annotations';

const rest = (method: string, name = 'do_thing') => ({
  name,
  connectorType: 'REST',
  endpointMapping: { method, path: '/x' },
});

describe('deriveToolAnnotations', () => {
  describe('REST', () => {
    it.each(['GET', 'HEAD', 'OPTIONS'])('marks %s read-only', (method) => {
      expect(deriveToolAnnotations(rest(method)).readOnlyHint).toBe(true);
    });

    it('does not emit write-only hints for a read-only tool', () => {
      // destructiveHint/idempotentHint are meaningful only when
      // readOnlyHint is false; emitting them would be noise.
      const a = deriveToolAnnotations(rest('GET'));
      expect(a.destructiveHint).toBeUndefined();
      expect(a.idempotentHint).toBeUndefined();
    });

    it('treats POST as an additive, non-idempotent write', () => {
      expect(deriveToolAnnotations(rest('POST', 'create_invoice'))).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      });
    });

    it('treats PUT as destructive and idempotent', () => {
      expect(deriveToolAnnotations(rest('PUT', 'replace_doc'))).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      });
    });

    it('treats PATCH as destructive but not idempotent', () => {
      expect(deriveToolAnnotations(rest('PATCH', 'edit_doc'))).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      });
    });

    it('treats DELETE as destructive and idempotent', () => {
      expect(deriveToolAnnotations(rest('DELETE', 'delete_doc'))).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      });
    });

    it('lets an unambiguous name correct the verb baseline', () => {
      // A delete exposed over POST is destructive, not additive.
      expect(deriveToolAnnotations(rest('POST', 'delete_customer')).destructiveHint).toBe(
        true,
      );
    });

    it('never claims read-only for POST, even when the name reads like a search', () => {
      // POST /search is extremely common but indistinguishable from a write at
      // the protocol level. Wrongly asserting read-only would invite an agent
      // to call a mutating tool freely, so this needs the explicit override.
      const a = deriveToolAnnotations(rest('POST', 'search_products'));
      expect(a.readOnlyHint).toBe(false);
    });

    it('is case-insensitive about the verb', () => {
      expect(deriveToolAnnotations(rest('get')).readOnlyHint).toBe(true);
    });

    it('omits read/write hints when the verb is unknown', () => {
      const a = deriveToolAnnotations(rest('WEIRD', 'neutral_name'));
      expect(a.readOnlyHint).toBeUndefined();
    });
  });

  describe('GraphQL', () => {
    it('marks a query read-only', () => {
      expect(
        deriveToolAnnotations({
          name: 'get_user',
          connectorType: 'GRAPHQL',
          endpointMapping: { method: 'query', path: 'query { user }' },
        }).readOnlyHint,
      ).toBe(true);
    });

    it('marks a mutation as a write', () => {
      expect(
        deriveToolAnnotations({
          name: 'create_user',
          connectorType: 'GRAPHQL',
          endpointMapping: { method: 'mutation', path: 'mutation { x }' },
        }),
      ).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    });
  });

  describe('DATABASE', () => {
    it('is a closed world', () => {
      expect(
        deriveToolAnnotations({
          name: 'q',
          connectorType: 'DATABASE',
          endpointMapping: { method: 'query', path: 'SELECT 1' },
        }).openWorldHint,
      ).toBe(false);
    });

    it('honours the connector-level readOnly flag', () => {
      expect(
        deriveToolAnnotations({
          name: 'run_sql',
          connectorType: 'DATABASE',
          endpointMapping: { method: 'query', path: 'DELETE FROM t' },
          connectorConfig: { config: { readOnly: true } },
        }).readOnlyHint,
      ).toBe(true);
    });

    it('detects a SELECT as read-only', () => {
      expect(
        deriveToolAnnotations({
          name: 'list_orders',
          connectorType: 'DATABASE',
          endpointMapping: { method: 'query', path: '  SELECT * FROM orders' },
          connectorConfig: { config: { readOnly: false } },
        }).readOnlyHint,
      ).toBe(true);
    });

    it('detects a write statement even inside a CTE', () => {
      expect(
        deriveToolAnnotations({
          name: 'archive_orders',
          connectorType: 'DATABASE',
          endpointMapping: {
            method: 'query',
            path: 'WITH x AS (SELECT 1) INSERT INTO archive SELECT * FROM x',
          },
          connectorConfig: { config: { readOnly: false } },
        }).readOnlyHint,
      ).toBe(false);
    });

    it('ignores SQL keywords that only appear in comments', () => {
      expect(
        deriveToolAnnotations({
          name: 'list_orders',
          connectorType: 'DATABASE',
          endpointMapping: {
            method: 'query',
            path: '-- do not delete anything\nSELECT * FROM orders',
          },
          connectorConfig: { config: { readOnly: false } },
        }).readOnlyHint,
      ).toBe(true);
    });

    it('marks a static response read-only', () => {
      expect(
        deriveToolAnnotations({
          name: 'get_guide',
          connectorType: 'DATABASE',
          endpointMapping: { method: 'static', path: '' },
          connectorConfig: { config: { readOnly: false } },
        }).readOnlyHint,
      ).toBe(true);
    });
  });

  describe('SOAP and MCP proxy', () => {
    it('never asserts read-only without verb semantics', () => {
      const a = deriveToolAnnotations({
        name: 'GetCustomerDetails',
        connectorType: 'SOAP',
        endpointMapping: { method: 'GetCustomerDetails', path: 'Port' },
      });
      expect(a.readOnlyHint).toBeUndefined();
    });

    it('still flags a confidently-named destructive operation', () => {
      expect(
        deriveToolAnnotations({
          name: 'DeleteCustomer',
          connectorType: 'SOAP',
          endpointMapping: { method: 'DeleteCustomer', path: 'Port' },
        }),
      ).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    });
  });

  describe('title', () => {
    it('humanizes snake_case and camelCase names', () => {
      expect(deriveToolAnnotations(rest('GET', 'get_customer_orders')).title).toBe(
        'Get customer orders',
      );
      expect(deriveToolAnnotations(rest('GET', 'getCustomerOrders')).title).toBe(
        'Get customer orders',
      );
    });
  });

  describe('explicit annotations', () => {
    it('override the derived values', () => {
      // The POST-search case, fixed by an admin.
      const a = deriveToolAnnotations({
        ...rest('POST', 'search_products'),
        annotations: { readOnlyHint: true },
      });
      expect(a.readOnlyHint).toBe(true);
    });

    it('drop stale write hints when flipping a tool to read-only', () => {
      const a = deriveToolAnnotations({
        ...rest('DELETE', 'delete_thing'),
        annotations: { readOnlyHint: true },
      });
      expect(a.destructiveHint).toBeUndefined();
      expect(a.idempotentHint).toBeUndefined();
    });

    it('keep derived values for keys the override does not set', () => {
      const a = deriveToolAnnotations({
        ...rest('GET', 'get_thing'),
        annotations: { title: 'Custom title' },
      });
      expect(a.title).toBe('Custom title');
      expect(a.readOnlyHint).toBe(true);
    });

    it('ignore unknown keys and wrongly-typed values', () => {
      const a = deriveToolAnnotations({
        ...rest('GET'),
        annotations: { bogus: true, readOnlyHint: 'yes' },
      });
      expect(a).not.toHaveProperty('bogus');
      expect(a.readOnlyHint).toBe(true); // derived value survives
    });

    it('tolerate a non-object stored value', () => {
      expect(() =>
        deriveToolAnnotations({ ...rest('GET'), annotations: 'nonsense' }),
      ).not.toThrow();
    });
  });
});

describe('annotationsSignature', () => {
  it('changes when a hint changes, so live sessions re-emit tools/list_changed', () => {
    const a = annotationsSignature(deriveToolAnnotations(rest('GET', 'x')));
    const b = annotationsSignature(
      deriveToolAnnotations({ ...rest('GET', 'x'), annotations: { readOnlyHint: false } }),
    );
    expect(a).not.toBe(b);
  });

  it('is stable for equal annotations', () => {
    expect(annotationsSignature(deriveToolAnnotations(rest('GET', 'x')))).toBe(
      annotationsSignature(deriveToolAnnotations(rest('GET', 'x'))),
    );
  });
});

describe('parseAnnotationsOverride', () => {
  it('accepts a valid partial override', () => {
    expect(parseAnnotationsOverride({ readOnlyHint: true })).toEqual({
      readOnlyHint: true,
    });
  });

  it('returns null for null (reset to derived)', () => {
    expect(parseAnnotationsOverride(null)).toBeNull();
  });

  it('returns null when nothing usable was provided', () => {
    expect(parseAnnotationsOverride({})).toBeNull();
  });

  it('rejects unknown keys', () => {
    expect(() => parseAnnotationsOverride({ readOnly: true })).toThrow(
      /Unknown annotation keys/,
    );
  });

  it('rejects wrong types', () => {
    expect(() => parseAnnotationsOverride({ readOnlyHint: 'true' })).toThrow(
      /must be a boolean/,
    );
    expect(() => parseAnnotationsOverride({ title: 5 })).toThrow(/must be a string/);
  });

  it('rejects arrays and scalars', () => {
    expect(() => parseAnnotationsOverride([1])).toThrow(/must be an object/);
    expect(() => parseAnnotationsOverride('x')).toThrow(/must be an object/);
  });
});
