import * as adapter from './ocr-space.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * OCR.space OCR API (ocr.space/ocrapi): POST /parse/image as a form, key in the apikey header.
 * Built from a customer's hand-built Cloud connector (OCR of an image URL); checked on 22 Oct 2026 with
 * OCR.space's public demo key rather than the customer's quota.
 * Live part: OCR_SPACE_API_KEY=... RUN_OCR_SPACE_LIVE=1 npx jest src/adapters/intl/ocr-space (one OCR request).
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  unlisted?: boolean;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; headers?: Record<string, string> };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings.
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
const PREFIX = 'ocr_space_';
const WRITES: string[] = [];
// Tool names of the customers' own connectors for this API on the Cloud (read 22 Oct 2026).
const HAND_BUILT: string[] = ["telegram_file_ocr"];

describe('ocr-space adapter: static spec conformance', () => {

  it('sends the key in the apikey header and posts a form to /parse/image', () => {
    expect(a.requiredEnvVars).toEqual(['OCR_SPACE_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://api.ocr.space');
    expect(a.connector.authConfig).toEqual({ headerName: 'apikey', apiKey: '{{OCR_SPACE_API_KEY}}' });
    expect(a.envVarMeta?.OCR_SPACE_API_KEY.secret).toBe(true);
    for (const t of a.tools) expect(t.endpointMapping).toMatchObject({ method: 'POST', path: '/parse/image', bodyEncoding: 'form-urlencoded' });
    expect(tool('ocr_space_read_url').endpointMapping.bodyMapping).toMatchObject({ url: '$url', OCREngine: '$engine', isTable: '$is_table' });
    expect(tool('ocr_space_make_searchable_pdf').endpointMapping.bodyMapping).toMatchObject({ isCreateSearchablePdf: true });
  });

  it('reports OCR failures that arrive with HTTP 200 as errors', () => {
    const cfg = (a.connector as unknown as { config: { errorWhen: unknown[] } }).config;
    expect(cfg.errorWhen).toEqual([{ path: 'IsErroredOnProcessing', equals: true, messagePath: 'ErrorMessage', status: 400 }]);
  });

  it('returns the text per page without the word coordinates', () => {
    const out = applyResponseTransform(
      { OCRExitCode: 1, IsErroredOnProcessing: false, ParsedResults: [{ ParsedText: 'Total 12,50', FileParseExitCode: 1, TextOverlay: { Lines: [{ Words: [] }] } }] },
      tool('ocr_space_read_url').responseMapping as never,
    ).value;
    expect(out).toEqual({ OCRExitCode: 1, IsErroredOnProcessing: false, pages: [{ text: 'Total 12,50', exitCode: 1 }] });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('writes are annotated, the risky ones installed switched off; reads are GET or marked read-only', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual([...WRITES].sort());
    for (const t of a.tools) {
      if (t.annotations?.readOnlyHint === false) continue;
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      if (t.endpointMapping.method !== 'GET') expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
    }
    for (const n of WRITES) expect(tool(n).annotations?.readOnlyHint).toBe(false);
  });

  it('never reuses the tool names of hand-built Cloud connectors for the same API', () => {
    const names = new Set(a.tools.map((t) => t.name));
    for (const n of HAND_BUILT) expect(`${n}:${names.has(n)}`).toBe(`${n}:false`);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    const probe = tool(a.probe.tool);
    expect(probe.annotations?.readOnlyHint === false).toBe(false);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});

const live = process.env.RUN_OCR_SPACE_LIVE === '1' && process.env.OCR_SPACE_API_KEY ? describe : describe.skip;
live('ocr-space adapter: live (one OCR request)', () => {
  it('reads the probe image', async () => {
    const body = new URLSearchParams({ url: a.probe.params?.url as string, OCREngine: '2', language: 'auto' });
    const res = (await (await fetch(`${a.connector.baseUrl}/parse/image`, { method: 'POST', headers: { apikey: process.env.OCR_SPACE_API_KEY ?? '' }, body })).json()) as { OCRExitCode: number; ParsedResults: Array<{ ParsedText: string }> };
    expect(res.OCRExitCode).toBe(1);
    expect(res.ParsedResults[0].ParsedText).toMatch(/Solar cell/);
  }, 60_000);
});
