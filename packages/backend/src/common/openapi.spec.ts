import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { APP_VERSION } from './app-version';
import { API_KEY_SCHEME, buildOpenApiConfig, OPENAPI_TAGS } from './openapi';

const SRC = join(__dirname, '..');

function controllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...controllerFiles(p));
    else if (name.endsWith('.controller.ts')) out.push(p);
  }
  return out;
}

/** Every tag named in an `@ApiTags(...)` decorator under src/. */
function usedTags(): Set<string> {
  const tags = new Set<string>();
  for (const file of controllerFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const call of text.matchAll(/@ApiTags\(([^)]*)\)/g)) {
      for (const lit of call[1].matchAll(/['"]([^'"]+)['"]/g)) tags.add(lit[1]);
    }
  }
  return tags;
}

describe('OpenAPI document config', () => {
  const config = buildOpenApiConfig();

  it('declares every tag a controller uses, and none that no controller uses', () => {
    const declared = OPENAPI_TAGS.map((t) => t.name);
    const used = usedTags();
    expect(used.size).toBeGreaterThan(0);
    expect(declared.filter((t) => !used.has(t))).toEqual([]);
    expect([...used].filter((t) => !declared.includes(t))).toEqual([]);
    expect(new Set(declared).size).toBe(declared.length);
  });

  it('gives every tag a description and passes them to the document in order', () => {
    for (const tag of OPENAPI_TAGS) expect(tag.description.trim()).not.toBe('');
    expect(config.tags?.map((t) => t.name)).toEqual(OPENAPI_TAGS.map((t) => t.name));
  });

  it('reports the running version, not a hard-coded one', () => {
    expect(config.info.version).toBe(APP_VERSION);
    expect(buildOpenApiConfig('9.9.9').info.version).toBe('9.9.9');
  });

  it('declares the bearer scheme and the X-API-Key scheme the controllers reference', () => {
    const schemes = config.components?.securitySchemes ?? {};
    expect(schemes.bearer).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(schemes[API_KEY_SCHEME]).toMatchObject({ type: 'apiKey', in: 'header', name: 'X-API-Key' });
  });

  it('has a description with authentication, quick start and errors, plus license and links', () => {
    const d = config.info.description ?? '';
    for (const heading of ['## Authentication', '## Quick start', '## Rate limits', '## Errors']) {
      expect(d).toContain(heading);
    }
    for (const scope of ['MANAGEMENT_READ', 'MANAGEMENT_ADMIN', '`MCP`']) expect(d).toContain(scope);
    expect(config.info.license?.name).toBe('AGPL-3.0');
    expect(config.externalDocs?.url).toMatch(/^https:\/\/anythingmcp\.com\//);
  });
});
