import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  ENC_KEY,
  envVarsAtRestExtension,
  isEncryptedEnvVars,
  openEnvVars,
  sealEnvVars,
} from './env-vars-at-rest';
import { encrypt } from './encryption.util';

const KEY = 'k'.repeat(48);

describe('connector variables at rest', () => {
  const saved = { key: process.env.ENCRYPTION_KEY, mode: process.env.ENV_VARS_AT_REST };
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = KEY;
    delete process.env.ENV_VARS_AT_REST;
  });
  afterAll(() => {
    process.env.ENCRYPTION_KEY = saved.key;
    if (saved.mode === undefined) delete process.env.ENV_VARS_AT_REST;
    else process.env.ENV_VARS_AT_REST = saved.mode;
  });

  it('stores an object as one ciphertext that holds none of its values', () => {
    const sealed = sealEnvVars({ LEXWARE_API_KEY: 'secret-123', TENANT: 'acme' }) as Record<string, string>;
    expect(Object.keys(sealed)).toEqual([ENC_KEY]);
    expect(JSON.stringify(sealed)).not.toContain('secret-123');
    expect(JSON.stringify(sealed)).not.toContain('LEXWARE_API_KEY');
    expect(openEnvVars(sealed)).toEqual({ LEXWARE_API_KEY: 'secret-123', TENANT: 'acme' });
  });

  it('reads rows written before encryption as they are', () => {
    expect(openEnvVars({ A: '1' })).toEqual({ A: '1' });
    expect(openEnvVars(null)).toBeNull();
    expect(openEnvVars({})).toEqual({});
  });

  it('lets keys added next to the ciphertext (by SQL) win, until the next save encrypts them', () => {
    const sealed = sealEnvVars({ MOTIS_URL: 'old', OTHER: 'x' }) as Record<string, string>;
    expect(openEnvVars({ ...sealed, MOTIS_URL: 'new' })).toEqual({ MOTIS_URL: 'new', OTHER: 'x' });
  });

  it('leaves empty objects, nulls, Prisma null markers and already sealed values alone', () => {
    class JsonNull {}
    const marker = new JsonNull();
    expect(sealEnvVars({})).toEqual({});
    expect(sealEnvVars(null)).toBeNull();
    expect(sealEnvVars(marker)).toBe(marker);
    const sealed = sealEnvVars({ A: '1' });
    expect(sealEnvVars(sealed)).toBe(sealed);
  });

  it('does not decrypt a blob encrypted for another field', () => {
    const foreign = { [ENC_KEY]: encrypt(JSON.stringify({ A: '1' }), KEY, 'connector-oauth') };
    expect(openEnvVars(foreign)).toEqual({});
  });

  it('reads as empty, never as ciphertext, under the wrong key', () => {
    const sealed = sealEnvVars({ A: '1' });
    process.env.ENCRYPTION_KEY = 'z'.repeat(48);
    expect(openEnvVars(sealed)).toEqual({});
  });

  it('writes plain objects when ENV_VARS_AT_REST=plaintext, and still reads sealed ones', () => {
    const sealed = sealEnvVars({ A: '1' });
    process.env.ENV_VARS_AT_REST = 'plaintext';
    expect(sealEnvVars({ A: '1' })).toEqual({ A: '1' });
    expect(isEncryptedEnvVars(sealed)).toBe(true);
    expect(openEnvVars(sealed)).toEqual({ A: '1' });
  });

  describe('the Prisma extension', () => {
    const run = async (operation: string, args: any) => {
      const query = jest.fn(async (a: any) => a);
      await envVarsAtRestExtension.query.connector.$allOperations({ operation, args, query });
      return query.mock.calls[0][0];
    };

    it.each(['create', 'update', 'updateMany', 'updateManyAndReturn'])('seals data.envVars on %s', async (op) => {
      const out = await run(op, { data: { name: 'x', envVars: { K: 'v' } } });
      expect(isEncryptedEnvVars(out.data.envVars)).toBe(true);
      expect(out.data.name).toBe('x');
    });

    it.each(['createMany', 'createManyAndReturn'])('seals every row on %s', async (op) => {
      const out = await run(op, { data: [{ envVars: { K: '1' } }, { envVars: { K: '2' } }] });
      expect(out.data.every((d: any) => isEncryptedEnvVars(d.envVars))).toBe(true);
    });

    it('seals both branches of an upsert', async () => {
      const out = await run('upsert', { where: { id: 'c1' }, create: { envVars: { K: '1' } }, update: { envVars: { K: '2' } } });
      expect(isEncryptedEnvVars(out.create.envVars)).toBe(true);
      expect(isEncryptedEnvVars(out.update.envVars)).toBe(true);
    });

    it('does not touch reads or writes without envVars', async () => {
      expect(await run('findMany', { where: { envVars: { not: null } } })).toEqual({ where: { envVars: { not: null } } });
      expect(await run('update', { where: { id: 'c1' }, data: { name: 'y' } })).toEqual({ where: { id: 'c1' }, data: { name: 'y' } });
    });

    it('decrypts on read', () => {
      const sealed = sealEnvVars({ K: 'v' });
      expect(envVarsAtRestExtension.result.connector.envVars.compute({ envVars: sealed })).toEqual({ K: 'v' });
    });
  });

  it('the codebase writes connectors only at the top level, where the extension seals them', () => {
    // A nested write (organization.update({ data: { connectors: { create } } }))
    // would bypass the query extension and store variables in clear.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.name === 'generated' || entry.name === 'node_modules') continue;
        if (entry.isDirectory()) walk(path);
        else if (path.endsWith('.ts') && !path.endsWith('.spec.ts')) {
          const text = readFileSync(path, 'utf8');
          if (/connectors?\s*:\s*\{\s*(create|createMany|connectOrCreate|upsert|update|updateMany)\b/.test(text)) {
            offenders.push(path);
          }
        }
      }
    };
    walk(join(__dirname, '..', '..'));
    expect(offenders).toEqual([]);
  });
});
