import { INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdaptersPublicController } from './adapters.controller';
import { AdaptersService } from './adapters.service';
import { ENRICHED_INSTRUCTIONS_MIN_CHARS, toAdapterSummary } from './catalog-summary';

// Next's data cache refuses items over 2 MB; the website's catalog fetch must stay well under it.
const NEXT_DATA_CACHE_LIMIT = 2 * 1024 * 1024;

function service(mode?: string): AdaptersService {
  const svc = Object.create(AdaptersService.prototype) as AdaptersService;
  (svc as any).configService = { get: (k: string) => (k === 'DEPLOYMENT_MODE' ? mode : undefined) };
  (svc as any).publicCatalogCache = new Map();
  return svc;
}

describe('GET /api/adapters?fields=slim (AdaptersService.publicCatalog)', () => {
  const svc = service('cloud');
  const full = JSON.parse(svc.publicCatalog('full').body);
  const slimBody = svc.publicCatalog('slim').body;
  const slim = JSON.parse(slimBody);

  it('lists the same adapters as the full catalog, in the same order', () => {
    expect(slim.map((a: any) => a.slug)).toEqual(full.map((a: any) => a.slug));
    expect(full).toEqual(JSON.parse(JSON.stringify(svc.listAll())));
  });

  it('is far below the 2 MB data-cache limit', () => {
    const bytes = Buffer.byteLength(slimBody, 'utf8');
    expect(bytes).toBeLessThan(NEXT_DATA_CACHE_LIMIT / 4);
    expect(bytes).toBeLessThan(Buffer.byteLength(svc.publicCatalog('full').body, 'utf8') / 4);
  });

  it('leaves out the heavy fields and keeps what the catalog pages read', () => {
    for (const a of slim) {
      for (const heavy of ['instructions', 'prerequisites', 'probe', 'aliases', 'appRegistrationUrl', 'optionalEnvVars']) {
        expect(a).not.toHaveProperty(heavy);
      }
      for (const field of ['slug', 'name', 'description', 'region', 'category', 'icon', 'docsUrl', 'requiredEnvVars', 'toolCount', 'enriched']) {
        expect(a).toHaveProperty(field);
      }
      for (const m of Object.values(a.envVarMeta ?? {}) as object[]) {
        expect(Object.keys(m).every((k) => k === 'kind' || k === 'secret')).toBe(true);
      }
    }
  });

  it('flags the adapters whose setup instructions make a page worth indexing', () => {
    const bySlug = new Map(full.map((a: any) => [a.slug, a]));
    for (const a of slim) {
      const instructions: string | undefined = (bySlug.get(a.slug) as any).instructions;
      expect(a.enriched).toBe((instructions?.trim().length ?? 0) >= ENRICHED_INSTRUCTIONS_MIN_CHARS);
    }
    expect(slim.some((a: any) => a.enriched)).toBe(true);
  });

  it('keeps the kind and secret flags of each variable', () => {
    const s = toAdapterSummary({
      slug: 'x', name: 'X', description: 'd', region: 'intl', category: 'c', icon: 'x', docsUrl: 'u',
      requiredEnvVars: ['X_URL', 'X_KEY'], toolCount: 1, version: 'v', authType: 'API_KEY',
      instructions: 'short',
      envVarMeta: {
        X_URL: { kind: 'address', label: 'URL', help: 'Your server' },
        X_KEY: { kind: 'credential', secret: true, link: 'https://x.test' },
        X_OTHER: { label: 'Only a label' },
      },
    } as any);
    expect(s.envVarMeta).toEqual({ X_URL: { kind: 'address' }, X_KEY: { kind: 'credential', secret: true } });
    expect(s.enriched).toBe(false);
  });

  it('is built once per deployment mode and keeps its ETag', () => {
    const first = svc.publicCatalog('slim');
    expect(svc.publicCatalog('slim')).toBe(first);
    expect(first.etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(svc.publicCatalog('full').etag).not.toBe(first.etag);
  });

  it('follows the deployment mode: self-host-only adapters only off the cloud', () => {
    const selfHosted = service(undefined);
    const cloudSlugs = new Set(slim.map((a: any) => a.slug));
    const selfHostSlugs = JSON.parse(selfHosted.publicCatalog('slim').body).map((a: any) => a.slug);
    expect(selfHostSlugs.length).toBeGreaterThanOrEqual(cloudSlugs.size);
    expect(slim.some((a: any) => a.selfHostOnly)).toBe(false);
  });
});

describe('AdaptersPublicController over HTTP', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    const svc = service('cloud');
    const moduleRef = await Test.createTestingModule({
      // A bucket of 2 per minute: anything rate limited answers 429 on the third call.
      imports: [ThrottlerModule.forRoot([{ ttl: 60_000, limit: 2 }])],
      controllers: [AdaptersPublicController],
      providers: [
        { provide: AdaptersService, useValue: svc },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
    base = `${await app.getUrl()}/api/adapters`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('is not rate limited', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${base}?fields=slim`);
      statuses.push(res.status);
      await res.arrayBuffer();
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
  });

  it('sends JSON with an ETag and Cache-Control, and 304 on revalidation', async () => {
    const res = await fetch(`${base}?fields=slim`);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('cache-control')).toMatch(/public, max-age=\d+/);
    const etag = res.headers.get('etag');
    expect(etag).toBeTruthy();
    expect(Array.isArray(await res.json())).toBe(true);

    const again = await fetch(`${base}?fields=slim`, { headers: { 'If-None-Match': etag! } });
    expect(again.status).toBe(304);
  });

  it('keeps the full list as before when fields is omitted', async () => {
    const res = await fetch(base);
    const body = await res.json();
    expect(body[0]).toHaveProperty('slug');
    expect(body.some((a: any) => typeof a.instructions === 'string')).toBe(true);
  });

  it('refuses an unknown fields value', async () => {
    const res = await fetch(`${base}?fields=everything`);
    expect(res.status).toBe(400);
  });

  it("serves one adapter's instructions, and 404 for an unknown slug", async () => {
    const full = await (await fetch(base)).json();
    const withInstructions = full.find((a: any) => typeof a.instructions === 'string');
    const res = await fetch(`${base}/${withInstructions.slug}/instructions`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: withInstructions.slug, instructions: withInstructions.instructions });

    const missing = await fetch(`${base}/no-such-adapter/instructions`);
    expect(missing.status).toBe(404);
  });
});
