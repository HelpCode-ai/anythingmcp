import * as fs from 'fs';
import * as path from 'path';
import {
  findSecretInHeader,
  findSecretInQueryParam,
  findSecretLiterals,
  isCredentialHeaderName,
  looksHighEntropy,
  redactSecretLiterals,
  redactSecretsDeep,
} from './secret-literals.util';

// Fake credentials of the right shape, assembled at runtime so no scanner
// mistakes this file for a leak.
const TG_ID = '7123456789';
const TG_SECRET = ['AAH', 'k3jd9QwErTyUiOp', 'AsDfGhJkLzXcVbN', 'm12'].join('');
const TG = `${TG_ID}:${TG_SECRET}`;
const STRIPE = ['sk', 'live', '51HxYzAbCdEfGhIjKlMnOpQr'].join('_');
const GOOGLE = ['AI', 'zaSyB1x2y3z4A5B6C7D8E9F0gHiJkLmNoPqRs'].join('');
const OPENAI = ['sk', 'proj', 'Ab12Cd34Ef56Gh78Ij90KlMnOpQr'].join('-');
const GITHUB = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_');
const SLACK = ['xoxb', '123456789012', '1234567890123', 'AbCdEfGhIjKlMnOpQrStUvWx'].join('-');
const SHOPIFY = ['shpat', '0123456789abcdef0123456789abcdef'].join('_');
const GITLAB = ['glpat', 'xYz12AbC34dEf56GhI78j'].join('-');
const META = `EAA${'Gm0PX4ZCpsBAKZB1x2y3z4A5B6C7D8E9F0gHiJkLmNoPqRsTuVwXyZ'.repeat(2)}`;
const JWT_TOKEN = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ',
  'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
].join('.');
const OPAQUE = 'q8ZtW3nRk2LxV9pMbH4cJs7YdF6gTe1A'; // 32 chars, random

describe('findSecretLiterals', () => {
  it('finds a Telegram bot token in the path, without the "bot" prefix', () => {
    const url = `https://api.telegram.org/bot${TG}/sendMessage`;
    const [f] = findSecretLiterals(url);
    expect(f.kind).toBe('telegram_bot_token');
    expect(f.value).toBe(TG);
    expect(url.slice(f.start, f.end)).toBe(TG);
    expect(f.pattern).toBe('bot<10 digits>:***(36)');
    expect(f.pattern).not.toContain(TG_SECRET.slice(0, 4));
  });

  it('finds a Telegram token in a bare path and in a base URL', () => {
    expect(findSecretLiterals(`/bot${TG}/getMe`)[0].kind).toBe('telegram_bot_token');
    expect(findSecretLiterals(`https://api.telegram.org/bot${TG}`)[0].value).toBe(TG);
  });

  it.each([
    ['Stripe', `/v1/charges?x=1&k=${STRIPE}`, 'sk_live_'],
    ['Google', `https://maps.googleapis.com/maps/api/geocode/json?q=${GOOGLE}`, 'AIza'],
    ['OpenAI', `/proxy/${OPENAI}/chat`, 'sk-'],
    ['GitHub', `/repos/${GITHUB}/x`, 'ghp_'],
    ['Slack', `/hooks/${SLACK}`, 'xox-'],
    ['Shopify', `/admin/${SHOPIFY}/orders.json`, 'shpat_'],
    ['GitLab', `/api/v4/${GITLAB}/projects`, 'glpat-'],
    ['Meta', `/v19.0/me/${META}`, 'EAA'],
  ])('finds a %s key by its prefix', (_name, url, label) => {
    const found = findSecretLiterals(url).filter((f) => f.kind === 'known_prefix');
    expect(found).toHaveLength(1);
    expect(found[0].label).toBe(label);
    expect(found[0].pattern.startsWith(label)).toBe(true);
  });

  it('finds a JWT', () => {
    const [f] = findSecretLiterals(`/session/${JWT_TOKEN}/info`);
    expect(f.kind).toBe('jwt');
    expect(f.value).toBe(JWT_TOKEN);
  });

  it.each(['key', 'api_key', 'apikey', 'api-key', 'token', 'access_token', 'secret', 'password', 'signature', 'sig', 'client_secret', 'apiKey'])(
    'finds a literal value of the %s query parameter',
    (name) => {
      const url = `https://api.example.com/v1/items?limit=10&${name}=a1b2c3d4e5f6&sort=asc`;
      const found = findSecretLiterals(url);
      expect(found).toHaveLength(1);
      expect(found[0].kind).toBe('secret_query_param');
      expect(found[0].value).toBe('a1b2c3d4e5f6');
      expect(found[0].pattern).toBe(`${name}=***(12)`);
    },
  );

  it('finds a long random token as a last resort', () => {
    const [f] = findSecretLiterals(`https://discord.example/api/webhooks/123/${OPAQUE}`);
    expect(f.kind).toBe('high_entropy');
    expect(f.value).toBe(OPAQUE);
  });

  it('treats an Apps Script deployment id as a secret (anyone holding it can call the web app)', () => {
    const id = 'AKfycbx7Lq2Wm9Rt4Yp1Zs8Kd3Nf6Hg5Jc0Vb2Xa7Qe9Uo4Ti1Ry6Ew3Mn8Pk5Lj2Hs';
    const [f] = findSecretLiterals(`https://script.google.com/macros/s/${id}/exec`);
    expect(f.kind).toBe('high_entropy');
    expect(f.value).toBe(id);
  });

  it('judges query values by name, not by randomness', () => {
    expect(findSecretLiterals(`https://api.example.com/x?state=${OPAQUE}`)).toEqual([]);
    expect(findSecretLiterals(`https://api.example.com/x?token=${OPAQUE}`)[0].kind).toBe('secret_query_param');
  });

  it.each([
    // placeholders are references, not literals
    'https://api.telegram.org/bot{{TELEGRAM_BOT_TOKEN}}/sendMessage',
    '/items?api_key={{API_KEY}}',
    '/items?api_key=${API_KEY}',
    '/items?token={token}',
    // ids that look random but are not secrets
    '/users/123e4567-e89b-12d3-a456-426614174000/orders',
    '/objects/123E4567E89B12D3A456426614174000',
    '/commits/9fceb02d0ae598e95dc970b74767f19372d61af8',
    '/blobs/da39a3ee5e6b4b0d3255bfef95601890afd80709da39a3ee5e6b4b0d3255bfef',
    '/v1/getAllCustomerOrdersByRegionAndCountry2024',
    '/api/v2/this-is-a-long-slug-for-an-article-2024-part-12',
    '/storage/v1/object/public/bucket/very_long_file_name_with_numbers_123.png',
    'https://subdomain.with.a.very.long.name.example.com/api',
    '/items?key=name&sort=key',
    '/items?key=YOUR_API_KEY',
    '/items?token=xxxxxxxxxxxx',
    '/items?signature=sha256',
    '/locale/sk-SK/strings',
    '/desk-items/sk-items-are-not-keys-at-all-really',
    'https://host.example:8443/path',
    '/time/20260101:120000',
    // ad-click ids in a pasted marketing URL (seen on the cloud, 12 Oct 2026)
    'https://www.example.com/product/?src=google&gbraid=0AAAAADf3sk2KhG8xZq1Pa9LmN4bVc7Yt&gclid=Cj0KCQjw9Ab2xYzBhCARIsAN3kQ7pLmN8vWqR2sT5uY1zXcV4bN6mK9jH3gF0dS2aQ1wE5rT7yU9iO3pL6',
  ])('does not flag %s', (url) => {
    expect(findSecretLiterals(url)).toEqual([]);
  });
});

describe('looksHighEntropy', () => {
  it('rejects UUIDs, hex and short tokens', () => {
    expect(looksHighEntropy('123e4567e89b12d3a456426614174000')).toBe(false);
    expect(looksHighEntropy('ABCDEF0123456789ABCDEF0123456789')).toBe(false);
    expect(looksHighEntropy('q8ZtW3nRk2LxV9pM')).toBe(false);
    expect(looksHighEntropy(OPAQUE)).toBe(true);
  });

  it('accepts most random 32-character keys', () => {
    // Deterministic pseudo-random generator, so the test never flakes.
    let seed = 42;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let flagged = 0;
    for (let i = 0; i < 1000; i++) {
      let key = '';
      for (let j = 0; j < 32; j++) key += alphabet[Math.floor(next() * alphabet.length)];
      if (looksHighEntropy(key)) flagged++;
    }
    expect(flagged).toBeGreaterThan(800);
  });
});

describe('findSecretInQueryParam', () => {
  it('flags a literal in a credential parameter', () => {
    expect(findSecretInQueryParam('api_key', 'a1b2c3d4e5f6')[0].kind).toBe('secret_query_param');
  });
  it('ignores references and non-credential names', () => {
    expect(findSecretInQueryParam('api_key', '$api_key')).toEqual([]);
    expect(findSecretInQueryParam('api_key', '{{API_KEY}}')).toEqual([]);
    expect(findSecretInQueryParam('api_key', '${API_KEY}')).toEqual([]);
    expect(findSecretInQueryParam('limit', '100')).toEqual([]);
    expect(findSecretInQueryParam('format', 'json')).toEqual([]);
  });
  it('flags a known key shape under any name', () => {
    expect(findSecretInQueryParam('q', GOOGLE)[0].kind).toBe('known_prefix');
  });
});

describe('findSecretInHeader', () => {
  it('flags a literal credential header, keeping the auth scheme out of the value', () => {
    const value = 'Bearer abcDEF123456ghi';
    const [f] = findSecretInHeader('Authorization', value);
    expect(f.kind).toBe('credential_header');
    expect(f.value).toBe('abcDEF123456ghi');
    expect(value.slice(0, f.start)).toBe('Bearer ');
  });
  it('flags X-Api-Key with a literal', () => {
    expect(findSecretInHeader('X-Api-Key', 'a1b2c3d4e5f6')[0].value).toBe('a1b2c3d4e5f6');
  });
  it('ignores references, ids and versions', () => {
    expect(findSecretInHeader('Authorization', 'Bearer {{TOKEN}}')).toEqual([]);
    expect(findSecretInHeader('X-Api-Key', '$api_key')).toEqual([]);
    expect(findSecretInHeader('Notion-Version', '2022-06-28')).toEqual([]);
    expect(findSecretInHeader('Harvest-Account-Id', '1234567')).toEqual([]);
    expect(findSecretInHeader('X-Api-Key-Id', 'ab12cd34ef')).toEqual([]);
    expect(findSecretInHeader('Accept', 'application/json')).toEqual([]);
  });
  it('flags a known key shape in any header', () => {
    expect(findSecretInHeader('X-Custom', STRIPE)[0].kind).toBe('known_prefix');
  });
  it('knows credential header names', () => {
    expect(isCredentialHeaderName('X-Shopify-Access-Token')).toBe(true);
    expect(isCredentialHeaderName('Private-Token')).toBe(true);
    expect(isCredentialHeaderName('X-Api-Key')).toBe(true);
    expect(isCredentialHeaderName('Content-Type')).toBe(false);
  });
});

describe('redaction', () => {
  it('redacts secrets in free text and given values', () => {
    const text = `GET https://api.telegram.org/bot${TG}/sendMessage failed, key=${OPAQUE}x`;
    const out = redactSecretLiterals(text);
    expect(out).not.toContain(TG_SECRET);
    expect(out).toContain('bot[REDACTED]/sendMessage');
    expect(redactSecretLiterals('token is hunter2-short', ['hunter2-short'])).toBe('token is [REDACTED]');
  });
  it('redacts deeply', () => {
    const out = redactSecretsDeep({ a: [`x ${STRIPE} y`], b: { c: 1 } });
    expect(out).toEqual({ a: ['x [REDACTED] y'], b: { c: 1 } });
  });
  it('copies only plain objects and arrays: a Date or a Buffer in a row survives', () => {
    const when = new Date(0);
    const buf = Buffer.from('hello');
    const out: any = redactSecretsDeep({ when, buf, note: 'pw hunter2-long' }, ['hunter2-long'], { patterns: false });
    expect(out.note).toBe('pw [REDACTED]');
    expect(out.when).toBe(when);
    expect(out.buf).toBe(buf);
  });
});

describe('resource ids that look random', () => {
  // Shapes of real Google and Microsoft ids (generated, not real documents).
  const SHEET = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
  const DRIVE = '1Zx8Kq3Lm9Np2Rt5Vw7Yb4Dc6Fh8Jk0Mn';
  const GRAPH_DRIVE = 'b!aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7bC9dE1fG3hI5jK7lM';
  const GRAPH_MESSAGE = 'AAMkADg3NTY5MDg4LWMzYmQtNDQzNi05OTRkLTdjNGQ2ZTA1ZWQ2YgBGAAAAAAB';
  it.each([
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET}/values/Sheet1!A1:D5`,
    `/v4/spreadsheets/${SHEET}:batchUpdate`,
    `https://docs.google.com/spreadsheets/d/${SHEET}/edit`,
    `https://docs.google.com/document/d/${SHEET}/edit`,
    `https://www.googleapis.com/drive/v3/files/${DRIVE}`,
    `https://graph.microsoft.com/v1.0/drives/${GRAPH_DRIVE}/items`,
    `/v1.0/me/messages/${GRAPH_MESSAGE}`,
    // an ARN tail is `<account>:<name>`, not a bot token
    '/topics/arn:aws:sns:us-east-1:123456789012:my-very-long-topic-name-for-orders-processing',
  ])('does not flag %s', (url) => {
    expect(findSecretLiterals(url)).toEqual([]);
  });

  it('still flags a token after a non-collection segment', () => {
    expect(findSecretLiterals(`/macros/s/${SHEET}/exec`)[0].kind).toBe('high_entropy');
  });
});

/**
 * Every adapter of the catalog is a negative case: its base URL, paths, query
 * parameters, headers and parameter defaults are templates and ids written by
 * us, and none of them may look like a secret. A rule that fires here would
 * move a catalog value into a variable on every install.
 */
describe('the catalog has no secret-looking literals', () => {
  const root = path.join(__dirname, '..', 'adapters');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.json')) files.push(p);
    }
  };
  walk(root);

  it('has adapters to check', () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it('flags nothing in any adapter', () => {
    const hits: string[] = [];
    const report = (file: string, where: string, found: Array<{ pattern: string }>) => {
      for (const f of found) hits.push(`${path.relative(root, file)} ${where}: ${f.pattern}`);
    };
    let checked = 0;
    for (const file of files) {
      const adapter = JSON.parse(fs.readFileSync(file, 'utf8'));
      const connector = adapter.connector;
      if (!connector) continue;
      if (connector.type !== 'DATABASE') {
        report(file, 'baseUrl', findSecretLiterals(connector.baseUrl ?? ''));
      }
      for (const [k, v] of Object.entries(connector.headers ?? {})) {
        report(file, `headers.${k}`, findSecretInHeader(k, v));
      }
      for (const tool of adapter.tools ?? []) {
        const em = tool.endpointMapping ?? {};
        checked++;
        if (typeof em.path === 'string') report(file, `${tool.name}.path`, findSecretLiterals(em.path));
        for (const [k, v] of Object.entries(em.queryParams ?? {})) {
          report(file, `${tool.name}.query.${k}`, findSecretInQueryParam(k, v));
        }
        for (const [k, v] of Object.entries(em.headers ?? {})) {
          report(file, `${tool.name}.headers.${k}`, findSecretInHeader(k, v));
        }
        for (const [k, p] of Object.entries((tool.parameters?.properties ?? {}) as Record<string, any>)) {
          if (typeof p?.default === 'string') {
            report(file, `${tool.name}.param.${k}`, findSecretInQueryParam(k, p.default));
          }
        }
        report(file, `${tool.name}.name`, findSecretLiterals(tool.name ?? ''));
      }
    }
    expect(checked).toBeGreaterThan(5000);
    expect(hits).toEqual([]);
  });
});
