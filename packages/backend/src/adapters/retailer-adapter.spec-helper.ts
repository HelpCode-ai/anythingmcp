import axios from 'axios';
import * as sourceAdapter from './intl/mirakl.json';
import { RestEngine } from '../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../connectors/engines/login-token.service';
import { applySchemaDefaults } from '../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../common/env-interpolation.util';
import { needsBrowserAuthorization } from './env-var-meta';

/**
 * Shared checks for the retailer marketplace adapters that
 * scripts/generate-retailer-adapters.mjs writes from intl/mirakl.json and
 * scripts/retailer-marketplaces.json (Decathlon, Carrefour, MediaMarkt...).
 * Each generated <slug>.live.spec.ts calls describeRetailerAdapter once.
 *
 *   1. Static: always runs. The retailer's own seller platform as base URL,
 *      the raw shop key in the Authorization header, the optional shop id,
 *      and the same calls as intl/mirakl.json (method and path of every
 *      tool, parameters, bodies, which tools write and which install
 *      switched off), whose behaviour mirakl.live.spec.ts pins. Also that
 *      the adapter reads as the retailer's own: its tool prefix everywhere,
 *      every tool named in the instructions, and the software behind the
 *      back office named only in the aliases and once in the instructions.
 *
 *   2. Live: skipped unless RUN_<SLUG>_LIVE=1. GET /api/version on every
 *      host answers 200 without a key; with <SLUG>_API_KEY (and <SLUG>_URL
 *      for a retailer with one platform per country) it reads the shop,
 *      orders and offers. Nothing writes to a marketplace.
 *
 *        RUN_DECATHLON_LIVE=1 DECATHLON_API_KEY=... \
 *          npx jest src/adapters/intl/decathlon.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown> };
  annotations?: Record<string, unknown>;
};
type EnvVarMeta = { pattern?: string; secret?: boolean; link?: string; options?: Array<{ value: string; label: string }> };
type RetailerAdapter = {
  slug: string;
  name: string;
  aliases: string[];
  description: string;
  instructions: string;
  icon: string;
  docsUrl: string;
  requiredEnvVars: string[];
  optionalEnvVars: string[];
  envVarMeta: Record<string, EnvVarMeta>;
  verifyHints: Record<string, string>;
  probe: { tool: string };
  setupGuide: { effort: string; steps: Array<{ id: string; action?: { url: string }; fields?: string[]; saveAndCheck?: boolean }> };
  checkBeforeAuthorization?: unknown;
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string> };
  tools: Tool[];
};

const source = sourceAdapter as unknown as { slug: string; tools: Tool[] };
const SOURCE_PREFIX = `${source.slug}_`;
const SOURCE_SHOP = `${source.slug.toUpperCase()}_SHOP_ID`;
// Built at run time so no literal here looks like a real key.
const KEY = ['1b2c3d4e', '5f60', '7182', '93a4', 'b5c6d7e8f901'].join('-');

/** What a tool sends, without its name and wording: equal for a retailer tool and the tool it was generated from. */
const callShape = (tool: Tool, shopVar: string): unknown =>
  JSON.parse(
    JSON.stringify(
      { parameters: tool.parameters, endpointMapping: tool.endpointMapping, annotations: tool.annotations, enabled: tool.enabled },
      (key, value: unknown) => (key === 'description' && typeof value === 'string' ? undefined : value),
    )
      .split(shopVar)
      .join('SHOP_ID'),
  );

/** Every string of a value, depth first. */
const strings = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => strings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => strings(item, out));
  return out;
};

/**
 * @param adapter the generated adapter JSON
 * @param expected its slug and the host names of the retailer's seller platform (one, or one per country)
 */
export function describeRetailerAdapter(adapter: unknown, expected: { slug: string; hosts: string[] }): void {
  const a = adapter as RetailerAdapter;
  const prefix = `${expected.slug.replace(/-/g, '_')}_`;
  const upper = expected.slug.replace(/-/g, '_').toUpperCase();
  const KEY_VAR = `${upper}_API_KEY`;
  const SHOP_VAR = `${upper}_SHOP_ID`;
  const URL_VAR = `${upper}_URL`;
  const origins = expected.hosts.map((host) => `https://${host}`);
  const multi = origins.length > 1;
  const envFor = (origin: string): Record<string, string> => ({ [KEY_VAR]: KEY, ...(multi ? { [URL_VAR]: origin } : {}) });
  const sourceName = (name: string) => `${SOURCE_PREFIX}${name.slice(prefix.length)}`;
  const tool = (name: string) => {
    const t = a.tools.find((x) => x.name === name);
    if (!t) throw new Error(`missing tool ${name}`);
    return t;
  };
  // Mirrors DynamicMcpTools: {{VAR}} interpolated, env vars also passed as params.
  const execute = (name: string, env: Record<string, string>, params: Record<string, unknown>) => {
    const { config, endpointMapping } = interpolateConnectorConfig(
      { baseUrl: a.connector.baseUrl, headers: a.connector.headers },
      tool(name).endpointMapping,
      env,
    );
    return new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).execute(
      {
        baseUrl: config.baseUrl,
        authType: a.connector.authType,
        authConfig: interpolateDeep({ ...a.connector.authConfig }, env),
        headers: config.headers,
      },
      endpointMapping,
      { ...applySchemaDefaults(tool(name).parameters, params), ...env },
    ) as Promise<any>;
  };
  const sent = () => mockedAxios.mock.calls[0][0];

  describe(`${expected.slug} adapter: static spec conformance`, () => {
    beforeEach(() => mockedAxios.mockReset());

    it('is the retailer adapter of this file, with its own icon and probe', () => {
      expect(a.slug).toBe(expected.slug);
      expect(a.icon).toBe(expected.slug);
      expect(a.connector.type).toBe('REST');
      expect(a.probe).toEqual({ tool: `${prefix}get_account` });
      expect(a.docsUrl).toMatch(/^https:\/\//);
    });

    it("calls the retailer's own seller platform and adds /api", async () => {
      if (multi) {
        expect(a.connector.baseUrl).toBe(`{{${URL_VAR}}}/api`);
        expect(a.requiredEnvVars).toEqual([URL_VAR, KEY_VAR]);
        expect(a.envVarMeta[URL_VAR].options!.map((o) => o.value)).toEqual(origins);
        for (const option of a.envVarMeta[URL_VAR].options!) expect(option.label).toMatch(/\S/);
        const allowed = new RegExp(a.envVarMeta[URL_VAR].pattern!);
        for (const origin of origins) expect(allowed.test(origin)).toBe(true);
        for (const bad of [`${origins[0]}/`, `${origins[0]}/api`, origins[0].replace('https:', 'http:'), 'https://example.com', `${origins[0]}.example.com`]) {
          expect(allowed.test(bad)).toBe(false);
        }
      } else {
        expect(a.connector.baseUrl).toBe(`${origins[0]}/api`);
        expect(a.requiredEnvVars).toEqual([KEY_VAR]);
        expect(a.envVarMeta[URL_VAR]).toBeUndefined();
      }
      for (const origin of origins) {
        mockedAxios.mockReset();
        mockedAxios.mockResolvedValue({ data: {} });
        await execute(`${prefix}list_orders`, envFor(origin), {});
        expect(sent().url).toBe(`${origin}/api/orders`);
      }
    });

    it('sends the raw shop key in the Authorization header, never Bearer and never in the URL', async () => {
      expect(a.connector.authType).toBe('API_KEY');
      expect(a.connector.authConfig).toEqual({ headerName: 'Authorization', apiKey: `{{${KEY_VAR}}}` });
      expect(needsBrowserAuthorization(a as never)).toBe(false);
      expect(a.envVarMeta[KEY_VAR].secret).toBe(true);
      const key = new RegExp(a.envVarMeta[KEY_VAR].pattern!);
      expect(key.test(KEY)).toBe(true);
      expect(key.test(`Bearer ${KEY}`)).toBe(false);
      mockedAxios.mockResolvedValue({ data: {} });
      await execute(`${prefix}get_account`, envFor(origins[0]), {});
      expect(sent().url).toBe(`${origins[0]}/api/account`);
      expect(sent().headers.Authorization).toBe(KEY);
      expect(JSON.stringify(sent().params ?? {})).not.toContain(KEY);
      expect(sent().url).not.toContain(KEY);
    });

    it('sends shop_id on every call when the shop id is set, and leaves it out otherwise', async () => {
      expect(a.optionalEnvVars).toEqual([SHOP_VAR]);
      expect(new RegExp(a.envVarMeta[SHOP_VAR].pattern!).test('2001')).toBe(true);
      for (const t of a.tools) expect(`${t.name}:${JSON.stringify(t.endpointMapping.queryParams?.shop_id)}`).toBe(`${t.name}:"\${${SHOP_VAR}}"`);
      mockedAxios.mockResolvedValue({ data: {} });
      await execute(`${prefix}list_offers`, { ...envFor(origins[0]), [SHOP_VAR]: '2001' }, {});
      expect(sent().params.shop_id).toBe('2001');
      mockedAxios.mockClear();
      await execute(`${prefix}list_offers`, envFor(origins[0]), {});
      expect(sent().params).not.toHaveProperty('shop_id');
      mockedAxios.mockClear();
      // The install form saves an optional field left empty as "".
      await execute(`${prefix}list_offers`, { ...envFor(origins[0]), [SHOP_VAR]: '' }, {});
      expect(sent().params).not.toHaveProperty('shop_id');
    });

    it('prefixes every tool with its own slug and keeps no tool name of the source adapter', () => {
      const names = a.tools.map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
      for (const name of names) {
        expect(name.startsWith(prefix)).toBe(true);
        expect(name).not.toContain(SOURCE_PREFIX);
      }
    });

    it('has the method and path pairs of intl/mirakl.json, tool by tool', () => {
      expect(a.tools.map((t) => `${sourceName(t.name)} ${t.endpointMapping.method} ${t.endpointMapping.path}`)).toEqual(
        source.tools.map((t) => `${t.name} ${t.endpointMapping.method} ${t.endpointMapping.path}`),
      );
    });

    it('sends what intl/mirakl.json sends: same parameters, query, bodies and annotations', () => {
      for (const [i, t] of a.tools.entries()) {
        expect({ tool: t.name, call: callShape(t, SHOP_VAR) }).toEqual({ tool: t.name, call: callShape(source.tools[i], SOURCE_SHOP) });
      }
    });

    it('installs the same tools switched off as intl/mirakl.json', () => {
      const off = (tools: Tool[]) => tools.filter((t) => t.enabled === false).map((t) => t.name);
      expect(off(a.tools).map(sourceName)).toEqual(off(source.tools));
      expect(off(a.tools).length).toBeGreaterThan(0);
    });

    it('names every tool in the instructions and points only at tools that exist', () => {
      const names = new Set(a.tools.map((t) => t.name));
      for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
      const pattern = new RegExp(`\\b${prefix}[a-z0-9_]+`, 'g');
      const mentioned = [a.instructions, ...strings(a.tools), ...strings(a.verifyHints), ...strings(a.setupGuide)].flatMap((text) => text.match(pattern) ?? []);
      expect(mentioned.length).toBeGreaterThan(a.tools.length);
      for (const name of mentioned) expect(names).toContain(name);
      expect(a.instructions.startsWith(`## ${a.name}\n`)).toBe(true);
      expect(JSON.stringify(adapter)).not.toMatch(/[–—]/);
    });

    it('reads as the retailer own connector: Mirakl only in the aliases and once in the instructions', () => {
      // A host name may contain the word (and is escaped in a pattern); prose may not.
      const prose = (text: string) => expected.hosts.reduce((out, host) => out.split(host).join(''), text.replace(/\\\./g, '.'));
      const count = (text: string) => (prose(text).match(/mirakl/gi) ?? []).length;
      // `import * as adapter` also carries the whole file again under `default`.
      const { aliases, instructions, default: _whole, ...rest } = a as RetailerAdapter & { default?: unknown };
      expect(strings(rest).filter((text) => count(text) > 0)).toEqual([]);
      expect(count(instructions)).toBe(1);
      expect(aliases.some((alias) => /mirakl/i.test(alias))).toBe(true);
      expect(a.name).not.toMatch(/mirakl/i);
    });

    it('guides the setup with an API key: sign-in page only, every variable asked once, checked by the probe', () => {
      expect(a.setupGuide.effort).toBe('api_key');
      const steps = a.setupGuide.steps;
      expect(steps.map((s) => s.id)).toEqual(multi ? ['country', 'open-account', 'api-key'] : ['open-account', 'api-key']);
      const open = steps.find((s) => s.id === 'open-account')!;
      expect(open.action!.url).toBe(multi ? `{{${URL_VAR}}}/login` : `${origins[0]}/login`);
      expect(steps.flatMap((s) => s.fields ?? [])).toEqual([...a.requiredEnvVars, ...a.optionalEnvVars]);
      // The last step checks the key with the probe; checkBeforeAuthorization is for browser sign-ins only.
      expect(steps.some((s) => s.saveAndCheck)).toBe(false);
      expect(a.checkBeforeAuthorization).toBeUndefined();
      for (const status of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[status]).toMatch(/\S/);
      expect(a.verifyHints['401']).toContain(KEY_VAR);
    });
  });

  const live = process.env[`RUN_${upper}_LIVE`] === '1' ? describe : describe.skip;

  live(`${expected.slug} adapter: live seller platform (reads only)`, () => {
    const liveKey = process.env[KEY_VAR];
    const liveUrl = process.env[URL_VAR];
    const env: Record<string, string> = { [KEY_VAR]: liveKey ?? '', ...(multi ? { [URL_VAR]: liveUrl ?? '' } : {}) };
    const liveShop = process.env[SHOP_VAR];
    if (liveShop) env[SHOP_VAR] = liveShop;
    const withKey = liveKey && (!multi || (liveUrl && origins.includes(liveUrl))) ? it : it.skip;
    beforeAll(() => {
      mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
    });
    const run = (name: string, params: Record<string, unknown> = {}): Promise<any> => execute(`${prefix}${name}`, env, params);

    it.each(origins)('%s answers GET /api/version without a key', async (origin) => {
      const response = await mockedAxios.__actual.get(`${origin}/api/version`, { timeout: 20_000, validateStatus: () => true });
      expect(response.status).toBe(200);
    }, 30_000);

    withKey('reads the shop, orders and offers', async () => {
      const account = await run('get_account');
      expect(account.shop_id).toBeDefined();
      const orders = await run('list_orders', { max: 2, order: 'desc' });
      expect(Array.isArray(orders.orders)).toBe(true);
      const offers = await run('list_offers', { max: 2 });
      expect(Array.isArray(offers.offers)).toBe(true);
    }, 120_000);
  });
}
