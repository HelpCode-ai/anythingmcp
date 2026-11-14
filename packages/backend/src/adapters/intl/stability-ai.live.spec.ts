import * as adapter from './stability-ai.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Stability AI REST API (docs.stability.ai/api-reference, OpenAPI at docs.stability.ai/openapi.json
 * and docs.stability.ai/openapi-v1.json): base https://api.stability.ai, Bearer key, generation
 * and edit endpoints take multipart/form-data and answer base64 JSON with Accept: application/json.
 * Live part (free reads only: balance, account, engines):
 *   STABILITY_API_KEY=... RUN_STABILITY_AI_LIVE=1 npx jest src/adapters/intl/stability-ai
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; format?: string; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; bodyEncoding?: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: { images?: { paths: string[] }; binary?: unknown; transform?: unknown };
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean }>;
  probe: { tool: string };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};
const READS = ['stability_ai_get_balance', 'stability_ai_get_account', 'stability_ai_list_engines', 'stability_ai_get_result', 'stability_ai_get_audio_result'];
const ASYNC = ['stability_ai_upscale_creative', 'stability_ai_replace_background_and_relight', 'stability_ai_generate_audio'];
const paid = () => a.tools.filter((t) => !READS.includes(t.name));

describe('stability-ai adapter: static spec conformance', () => {
  it('authenticates with the API key as a Bearer token on api.stability.ai', () => {
    expect(a.requiredEnvVars).toEqual(['STABILITY_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://api.stability.ai');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{STABILITY_API_KEY}}' });
    expect(a.envVarMeta.STABILITY_API_KEY.secret).toBe(true);
    expect(new RegExp(a.envVarMeta.STABILITY_API_KEY.pattern ?? '').test('sk-AbCdEf0123456789AbCdEf0123456789AbCdEf0123456789')).toBe(true);
  });

  it('maps the free v1 account endpoints and the two result endpoints', () => {
    expect(tool('stability_ai_get_balance').endpointMapping).toEqual({ method: 'GET', path: '/v1/user/balance' });
    expect(tool('stability_ai_get_account').endpointMapping).toEqual({ method: 'GET', path: '/v1/user/account' });
    expect(tool('stability_ai_list_engines').endpointMapping).toEqual({ method: 'GET', path: '/v1/engines/list' });
    expect(tool('stability_ai_get_result').endpointMapping).toEqual({ method: 'GET', path: '/v2beta/results/{id}', headers: { Accept: 'application/json' } });
    expect(tool('stability_ai_get_result').responseMapping?.images?.paths).toEqual(['image']);
    expect(tool('stability_ai_get_audio_result').endpointMapping).toEqual({ method: 'GET', path: '/v2beta/audio/results/{id}', headers: { Accept: 'audio/*' } });
    expect(tool('stability_ai_get_audio_result').responseMapping?.binary).toBeDefined();
  });

  it('sends every generation as multipart/form-data with pictures fetched from URLs', () => {
    const paths: Record<string, string> = {
      stability_ai_generate_image_core: '/v2beta/stable-image/generate/core',
      stability_ai_generate_image_ultra: '/v2beta/stable-image/generate/ultra',
      stability_ai_generate_image_sd3: '/v2beta/stable-image/generate/sd3',
      stability_ai_upscale_fast: '/v2beta/stable-image/upscale/fast',
      stability_ai_upscale_conservative: '/v2beta/stable-image/upscale/conservative',
      stability_ai_upscale_creative: '/v2beta/stable-image/upscale/creative',
      stability_ai_remove_background: '/v2beta/stable-image/edit/remove-background',
      stability_ai_erase: '/v2beta/stable-image/edit/erase',
      stability_ai_inpaint: '/v2beta/stable-image/edit/inpaint',
      stability_ai_outpaint: '/v2beta/stable-image/edit/outpaint',
      stability_ai_search_and_replace: '/v2beta/stable-image/edit/search-and-replace',
      stability_ai_search_and_recolor: '/v2beta/stable-image/edit/search-and-recolor',
      stability_ai_replace_background_and_relight: '/v2beta/stable-image/edit/replace-background-and-relight',
      stability_ai_control_sketch: '/v2beta/stable-image/control/sketch',
      stability_ai_control_structure: '/v2beta/stable-image/control/structure',
      stability_ai_control_style: '/v2beta/stable-image/control/style',
      stability_ai_control_style_transfer: '/v2beta/stable-image/control/style-transfer',
      stability_ai_generate_audio: '/v2beta/audio/stable-audio/text-to-audio',
    };
    expect(paid().map((t) => t.name).sort()).toEqual(Object.keys(paths).sort());
    for (const t of paid()) {
      expect(t.endpointMapping).toMatchObject({ method: 'POST', path: paths[t.name], bodyEncoding: 'form-data' });
      for (const [field, v] of Object.entries(t.endpointMapping.bodyMapping ?? {})) {
        if (v && typeof v === 'object') {
          const param = String((v as { __file: string }).__file).slice(1);
          expect(param.endsWith('_url')).toBe(true);
          expect(t.parameters?.properties?.[param].format).toBe('uri');
          expect(field).toBe(param.replace(/_url$/, ''));
        }
      }
    }
    expect(tool('stability_ai_upscale_fast').endpointMapping.bodyMapping).toEqual({ image: { __file: '$image_url' }, output_format: '$output_format' });
    expect(tool('stability_ai_inpaint').endpointMapping.bodyMapping).toMatchObject({ image: { __file: '$image_url' }, mask: { __file: '$mask_url' }, prompt: '$prompt' });
    expect(tool('stability_ai_control_style_transfer').endpointMapping.bodyMapping).toMatchObject({ init_image: { __file: '$init_image_url' }, style_image: { __file: '$style_image_url' } });
    expect(tool('stability_ai_generate_audio').endpointMapping.bodyMapping).toMatchObject({ model: 'stable-audio-3', prompt: '$prompt', duration: '$duration' });
    expect(tool('stability_ai_generate_image_sd3').parameters?.properties?.model.enum).toEqual(['sd3.5-large', 'sd3.5-large-turbo', 'sd3.5-medium', 'sd3.5-flash']);
  });

  it('asks synchronous jobs for base64 JSON and returns the picture as an image; asynchronous jobs return the id', () => {
    for (const t of paid()) {
      if (ASYNC.includes(t.name)) {
        expect(`${t.name}:${JSON.stringify(t.responseMapping)}`).toBe(`${t.name}:undefined`);
        expect(t.description).toMatch(/stability_ai_get_(audio_)?result/);
      } else {
        expect(t.endpointMapping.headers).toEqual({ Accept: 'application/json' });
        expect(t.responseMapping?.images?.paths).toEqual(['image']);
      }
    }
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a70000000049454e44ae426082', 'hex').toString('base64');
    const out = applyResponseTransform({ image: png, finish_reason: 'SUCCESS', seed: 42 }, tool('stability_ai_generate_image_core').responseMapping as never);
    expect(out.images).toHaveLength(1);
    expect(out.value).toMatchObject({ finish_reason: 'SUCCESS', seed: 42 });
  });

  it('marks every paid tool as a non-read-only write that says it costs credits', () => {
    for (const t of paid()) {
      expect(t.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
      expect(`${t.name}:${/COSTS CREDITS/.test(t.description)}`).toBe(`${t.name}:true`);
      expect(`${t.name}:${/Confirm with the user/.test(t.description)}`).toBe(`${t.name}:true`);
    }
    for (const n of READS) {
      expect(tool(n).endpointMapping.method).toBe('GET');
      expect(tool(n).description).toMatch(/Free\.$/);
    }
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith('stability_ai_')).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('probes with a free read and documents every tool in the instructions', () => {
    expect(READS).toContain(a.probe.tool);
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_STABILITY_AI_LIVE === '1' && process.env.STABILITY_API_KEY ? describe : describe.skip;
live('stability-ai adapter: live (free reads only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Authorization: `Bearer ${process.env.STABILITY_API_KEY}`, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return res.json();
  };
  it('reads the balance, the account and the engines', async () => {
    expect(typeof ((await get('/v1/user/balance')) as { credits: number }).credits).toBe('number');
    expect(Array.isArray(((await get('/v1/user/account')) as { organizations: unknown[] }).organizations)).toBe(true);
    expect(Array.isArray(await get('/v1/engines/list'))).toBe(true);
  }, 30_000);
});
