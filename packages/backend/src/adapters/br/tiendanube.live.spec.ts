import * as adapter from './tiendanube.json';
const a = adapter as unknown as {
  instructions: string;
  requiredEnvVars: string[];
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string> };
  probe: { tool: string };
  tools: Array<{
    name: string;
    enabled?: boolean;
    parameters?: { properties?: Record<string, unknown>; required?: string[] };
    endpointMapping: { method: string; path: string; queryParams?: Record<string, string>; bodyMapping?: Record<string, string> };
    annotations?: Record<string, boolean>;
  }>;
};

describe('tiendanube adapter: static spec conformance', () => {
  it('targets the dated API version with the store id in the path', () => {
    expect(a.connector.baseUrl).toBe('https://api.tiendanube.com/2025-03/{{TIENDANUBE_STORE_ID}}');
    expect(a.requiredEnvVars).toEqual(['TIENDANUBE_STORE_ID', 'TIENDANUBE_ACCESS_TOKEN']);
  });

  it('sends the token as a bearer token', () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig.token).toBe('{{TIENDANUBE_ACCESS_TOKEN}}');
  });

  it('identifies itself with a User-Agent that carries a contact, or the API answers 400', () => {
    expect(a.connector.headers['User-Agent']).toMatch(/\(.+@.+\)/);
  });

  it('probes with the store endpoint', () => {
    expect(a.probe.tool).toBe('tiendanube_get_store');
    expect(a.tools.find((t) => t.name === 'tiendanube_get_store')?.endpointMapping.path).toBe('/store');
  });

  it('every declared parameter reaches the request', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      const used = new Set<string>();
      for (const [, p] of m.path.matchAll(/\{(\w+)\}/g)) used.add(p);
      for (const v of Object.values({ ...(m.queryParams ?? {}), ...(m.bodyMapping ?? {}) })) used.add(String(v).replace(/^\$/, ''));
      for (const p of Object.keys(t.parameters?.properties ?? {})) expect(`${t.name}:${used.has(p)}`).toBe(`${t.name}:true`);
    }
  });

  it('never sends published and visibility together (the API answers 422)', () => {
    for (const t of a.tools) {
      const body = Object.keys(t.endpointMapping.bodyMapping ?? {});
      expect(body.includes('published') && body.includes('visibility')).toBe(false);
    }
  });

  it('manages product images on the documented routes; removing one installs switched off', () => {
    const t = (n: string) => a.tools.find((x) => x.name === n)!;
    expect(t('tiendanube_list_product_images').endpointMapping).toMatchObject({ method: 'GET', path: '/products/{product_id}/images' });
    expect(t('tiendanube_add_product_image').endpointMapping).toEqual({
      method: 'POST',
      path: '/products/{product_id}/images',
      bodyMapping: { src: '$src', attachment: '$attachment', filename: '$filename', position: '$position', alt: '$alt' },
    });
    expect(t('tiendanube_update_product_image').endpointMapping).toEqual({
      method: 'PUT',
      path: '/products/{product_id}/images/{image_id}',
      bodyMapping: { position: '$position', alt: '$alt', src: '$src' },
    });
    expect(t('tiendanube_delete_product_image').endpointMapping).toEqual({ method: 'DELETE', path: '/products/{product_id}/images/{image_id}' });
    expect(t('tiendanube_delete_product_image').enabled).toBe(false);
    expect(t('tiendanube_delete_product_image').annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    for (const n of ['tiendanube_add_product_image', 'tiendanube_update_product_image']) expect(t(n).annotations?.readOnlyHint).toBe(false);
    expect(t('tiendanube_update_product_image').parameters?.required).toEqual(['product_id', 'image_id']);
  });

  it('path parameters are required and every tool is named in the instructions', () => {
    for (const t of a.tools) {
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(`${t.name}:${(t.parameters?.required ?? []).includes(p)}`).toBe(`${t.name}:true`);
      expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    }
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});
