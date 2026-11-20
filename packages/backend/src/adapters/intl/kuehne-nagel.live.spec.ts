import axios from 'axios';
import * as adapter from './kuehne-nagel.json';

/**
 * Kuehne+Nagel Shipment Tracking API v2 adapter.
 *
 * Static checks always run: the client-credentials token request at the
 * developer portal (consumer key and secret as HTTP Basic), the gateway
 * address, the four operations of the published OpenAPI definition with
 * their methods and paths, that the reference search requires its
 * reference, the body of the filtered search, and that every tool only
 * reads.
 * https://portal.api.kuehne-nagel.com/devportal/apis/6b98ae4c-ef06-4f72-acba-616584ee7f0f/overview
 *
 * Live checks run only with RUN_KUEHNE_NAGEL_LIVE=1. Without credentials
 * they confirm that the token endpoint refuses wrong credentials and that
 * the gateway refuses a call without a valid token; with
 * KUEHNE_NAGEL_CONSUMER_KEY and KUEHNE_NAGEL_CONSUMER_SECRET they fetch a
 * token and search one shipment. Reads only.
 *
 *   RUN_KUEHNE_NAGEL_LIVE=1 KUEHNE_NAGEL_CONSUMER_KEY=... KUEHNE_NAGEL_CONSUMER_SECRET=... \
 *     npx jest src/adapters/intl/kuehne-nagel.live.spec.ts
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: {
    properties?: Record<
      string,
      { description?: string; enum?: unknown[]; pattern?: string; minimum?: number; maximum?: number; default?: unknown }
    >;
    required?: string[];
  };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: unknown;
    headers?: Record<string, string>;
  };
  annotations?: { readOnlyHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  instructions: string;
  aliases?: string[];
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<
    string,
    { pattern?: string; kind?: string; secret?: boolean; options?: Array<{ value: string; label: string }> }
  >;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers?: Record<string, string>;
    config?: Record<string, unknown>;
  };
  tools: Tool[];
};
const tool = (name: string): Tool => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
/** Every argument an endpoint mapping reads: {name} in the path, $name and ${name} elsewhere. */
const used = (entry: Tool): Set<string> => {
  const m = entry.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)) out.add(p);
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      if (/^\$\w+$/.test(v)) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};

/** Tool name: [method, path, required arguments], as the vendor documents each operation. */
const CONTRACT: Record<string, [string, string, string[]]> = {
  kuehne_nagel_search_shipments: ['POST', '/shipments-search', []],
  kuehne_nagel_find_shipments_by_reference: ['GET', '/shipments', ['reference']],
  kuehne_nagel_get_shipment: ['GET', '/shipments/{unique_shipment_reference}', ['unique_shipment_reference']],
  kuehne_nagel_get_shipment_history: ['GET', '/shipments/{shipment_id}/history-records', ['shipment_id']],
};
/** Installed switched off: nothing: the adapter is read-only. */
const SWITCHED_OFF: string[] = [];
/** Tools on a write method that only read (searches and calculations). */
const POST_READS: string[] = ['kuehne_nagel_search_shipments'];

describe('kuehne-nagel adapter: static contract', () => {
  it('is filed under intl/logistics with its own icon and documentation link', () => {
    expect(a.slug).toBe('kuehne-nagel');
    expect(a.name).toBe('Kuehne+Nagel');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('logistics');
    expect(a.icon).toBe('kuehne-nagel');
    expect(a.docsUrl).toBe('https://portal.api.kuehne-nagel.com/devportal/apis/6b98ae4c-ef06-4f72-acba-616584ee7f0f/overview');
    expect(a.connector.type).toBe('REST');
  });

  it('uses client credentials at the developer portal and calls the gateway', () => {
    expect(a.connector.baseUrl).toBe('https://gateway.api.kuehne-nagel.com/track-trace/shipment/v2');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{KUEHNE_NAGEL_CONSUMER_KEY}}',
      clientSecret: '{{KUEHNE_NAGEL_CONSUMER_SECRET}}',
      tokenUrl: 'https://portal.api.kuehne-nagel.com/oauth2/token',
      tokenAuthMethod: 'client_secret_basic',
    });
    expect(a.requiredEnvVars).toEqual(['KUEHNE_NAGEL_CONSUMER_KEY', 'KUEHNE_NAGEL_CONSUMER_SECRET']);
    expect(a.envVarMeta.KUEHNE_NAGEL_CONSUMER_SECRET).toMatchObject({ kind: 'credential', secret: true });
    expect(a.envVarMeta.KUEHNE_NAGEL_CONSUMER_KEY.secret).toBeUndefined();
  });

  it('declares exactly the documented operations, each with its method, path and required arguments', () => {
    expect(a.tools.map((entry) => entry.name).sort()).toEqual(Object.keys(CONTRACT).sort());
    for (const [name, [method, path, required]] of Object.entries(CONTRACT)) {
      const entry = tool(name);
      expect([name, entry.endpointMapping.method, entry.endpointMapping.path]).toEqual([name, method, path]);
      expect([name, ...(entry.parameters.required ?? [])]).toEqual([name, ...required]);
    }
  });

  it('prefixes every tool and declares every argument it reads', () => {
    const names = new Set(a.tools.map((entry) => entry.name));
    expect(names.size).toBe(a.tools.length);
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      expect(entry.name).toMatch(/^kuehne_nagel_[a-z0-9_]+$/);
      expect(entry.description.length).toBeGreaterThanOrEqual(60);
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      const read = used(entry);
      for (const arg of read) expect([entry.name, arg, declared.has(arg) || envNames.has(arg)]).toEqual([entry.name, arg, true]);
      for (const arg of declared) expect([entry.name, arg, read.has(arg)]).toEqual([entry.name, arg, true]);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      for (const [arg, schema] of Object.entries(entry.parameters.properties ?? {})) {
        expect([entry.name, arg, Boolean(schema.description)]).toEqual([entry.name, arg, true]);
      }
    }
  });

  it('marks reads read-only and installs the risky writes switched off', () => {
    for (const entry of a.tools) {
      const reads = entry.endpointMapping.method === 'GET' || POST_READS.includes(entry.name);
      expect([entry.name, entry.annotations?.readOnlyHint === true]).toEqual([entry.name, reads]);
    }
    expect(
      a.tools
        .filter((entry) => entry.enabled === false)
        .map((entry) => entry.name)
        .sort(),
    ).toEqual([...SWITCHED_OFF].sort());
    for (const entry of a.tools) {
      if (entry.endpointMapping.method === 'DELETE') expect(SWITCHED_OFF).toContain(entry.name);
    }
  });

  it('names every tool in the instructions and keeps the texts safe to render', () => {
    const outsideCode = (text: string) => text.replace(/`[^`]*`/g, '');
    for (const entry of a.tools) {
      expect(a.instructions).toContain(entry.name);
      expect(outsideCode(entry.description)).not.toMatch(/[{}<]/);
    }
    expect(outsideCode(a.instructions)).not.toMatch(/[{}<]/);
    expect(a.instructions).not.toMatch(/\u2014/);
    expect(a.instructions.startsWith('## Kuehne+Nagel')).toBe(true);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('checks the credentials with a cheap read and explains the usual refusals', () => {
    expect(a.probe).toEqual({ tool: 'kuehne_nagel_search_shipments', params: { size: 1 } });
    expect(tool(a.probe.tool).annotations?.readOnlyHint).toBe(true);
    for (const key of ['400', '401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    for (const name of a.requiredEnvVars) expect(a.envVarMeta[name]).toBeTruthy();
  });

  it('only reads: three GET operations and the search, which is a POST that changes nothing', () => {
    expect(a.tools).toHaveLength(4);
    expect(POST_READS).toEqual(['kuehne_nagel_search_shipments']);
    for (const entry of a.tools) expect([entry.name, entry.annotations?.readOnlyHint]).toEqual([entry.name, true]);
    expect(SWITCHED_OFF).toEqual([]);
  });

  it('requires the reference on GET /shipments, which the API refuses without it', () => {
    const entry = tool('kuehne_nagel_find_shipments_by_reference');
    expect(entry.parameters.required).toEqual(['reference']);
    expect(entry.endpointMapping.queryParams).toEqual({ reference: '$reference' });
  });

  it('sends the search as a JSON body with pagination and filters', () => {
    const entry = tool('kuehne_nagel_search_shipments');
    expect(entry.endpointMapping.bodyMapping).toEqual({
      pagination: { page: '$page', size: '$size' },
      filters: {
        reference: '$reference',
        modesOfTransport: '$modes_of_transport',
        stages: '$stages',
        date: '$date',
        mawbNumber: '$mawb_number',
      },
    });
    // Pages are counted from 0.
    expect(entry.parameters.properties!.page.default).toBe(0);
  });

  it('accepts a tracking number or a prefixed shipment id for the details', () => {
    const schema = tool('kuehne_nagel_get_shipment').parameters.properties!.unique_shipment_reference;
    const pattern = new RegExp(schema.pattern!);
    for (const good of ['N4242', '1056143482TK', 'tracking-number:N4242', 'shipment-id:19101910']) expect(pattern.test(good)).toBe(true);
    for (const bad of ['', 'n4242', 'order:1', 'N 4242']) expect(pattern.test(bad)).toBe(false);
    expect(tool('kuehne_nagel_get_shipment_history').endpointMapping.path).toBe('/shipments/{shipment_id}/history-records');
  });
});

// Opt-in: RUN_KUEHNE_NAGEL_LIVE=1. Reads only; nothing is created or changed.
const live = process.env.RUN_KUEHNE_NAGEL_LIVE === '1';
(live ? describe : describe.skip)('Kuehne+Nagel: live', () => {
  const tokenUrl = 'https://portal.api.kuehne-nagel.com/oauth2/token';
  const base = 'https://gateway.api.kuehne-nagel.com/track-trace/shipment/v2';
  const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

  it('refuses wrong client credentials at the token endpoint', async () => {
    const response = await axios.post(tokenUrl, 'grant_type=client_credentials', {
      headers: { Authorization: basic('not-a-client', 'not-a-secret'), 'Content-Type': 'application/x-www-form-urlencoded' },
      validateStatus: () => true,
    });
    expect(response.status).toBe(401);
    expect(response.data.error).toBe('invalid_client');
  });

  it('refuses a gateway call with an invalid token', async () => {
    const response = await axios.get(`${base}/shipments`, {
      headers: { Authorization: 'Bearer not-a-token' },
      params: { reference: 'X' },
      validateStatus: () => true,
    });
    expect(response.status).toBe(401);
  });

  it('fetches a token and searches one shipment', async () => {
    const id = process.env.KUEHNE_NAGEL_CONSUMER_KEY;
    const secret = process.env.KUEHNE_NAGEL_CONSUMER_SECRET;
    if (!id || !secret) throw new Error('Set KUEHNE_NAGEL_CONSUMER_KEY and KUEHNE_NAGEL_CONSUMER_SECRET for the live check');
    const token = await axios.post(tokenUrl, 'grant_type=client_credentials', {
      headers: { Authorization: basic(id, secret), 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const search = await axios.post(
      `${base}/shipments-search`,
      { pagination: { page: 0, size: 1 }, filters: {} },
      { headers: { Authorization: `Bearer ${token.data.access_token}` }, validateStatus: () => true },
    );
    expect(search.status).toBe(200);
    expect(Array.isArray(search.data.shipments)).toBe(true);
  });
});
