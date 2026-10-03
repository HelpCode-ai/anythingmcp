import { Logger } from '@nestjs/common';
import { decrypt, encrypt } from './encryption.util';

/**
 * A connector's variables (`connectors.env_vars`) hold its API keys,
 * passwords and tokens. They are stored encrypted, as
 *
 *   { "$enc": "<AES-256-GCM of the JSON object>" }
 *
 * and decrypted on every read. Both directions happen in one place, a Prisma
 * extension on PrismaService (see `envVarsAtRestExtension`), so the code that
 * reads `connector.envVars` keeps seeing a plain object and none of its many
 * call sites can forget a step.
 *
 * Compatibility:
 * - Rows written before this existed are plain objects and are read as they
 *   are; the boot pass in PrismaService encrypts them.
 * - Keys stored next to `$enc` (an operator's SQL `env_vars || '{"X":"y"}'`)
 *   are read too and win over the encrypted ones; the next save encrypts them.
 * - `ENV_VARS_AT_REST=plaintext` turns encryption off and makes the boot pass
 *   decrypt every row: set it and restart once before rolling back to a
 *   version that does not know `$enc`.
 */
export const ENC_KEY = '$enc';

/** Binds the ciphertext to this column: a blob copied from another encrypted field does not decrypt here. */
const AAD = 'connectors.env_vars';

const logger = new Logger('EnvVarsAtRest');

type Json = Record<string, unknown>;

/** A JSON object. Not Prisma.JsonNull / DbNull, which are class instances. */
function isPlainObject(value: unknown): value is Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function isEncryptedEnvVars(value: unknown): boolean {
  return isPlainObject(value) && typeof value[ENC_KEY] === 'string';
}

export function plaintextAtRest(): boolean {
  return (process.env.ENV_VARS_AT_REST || '').trim().toLowerCase() === 'plaintext';
}

function key(): string {
  const value = process.env.ENCRYPTION_KEY;
  if (!value) throw new Error('ENCRYPTION_KEY is not set: connector variables cannot be encrypted or read');
  return value;
}

/** What to write to the column. Leaves anything that is not a non-empty object alone. */
export function sealEnvVars(value: unknown): unknown {
  if (plaintextAtRest() || !isPlainObject(value) || isEncryptedEnvVars(value)) return value;
  if (Object.keys(value).length === 0) return value;
  return { [ENC_KEY]: encrypt(JSON.stringify(value), key(), AAD) };
}

/**
 * What the application sees. A row that cannot be decrypted (wrong key)
 * reads as having no variables: every call then stops at the placeholder
 * guard with "still empty", instead of sending ciphertext to an API.
 */
export function openEnvVars(value: unknown): unknown {
  if (!isEncryptedEnvVars(value)) return value;
  const { [ENC_KEY]: sealed, ...plain } = value as Json;
  try {
    const opened = JSON.parse(decrypt(sealed as string, key(), AAD));
    return { ...(isPlainObject(opened) ? opened : {}), ...plain };
  } catch (err: any) {
    logger.error(`connector variables could not be decrypted (wrong ENCRYPTION_KEY?): ${err?.message ?? err}`);
    return { ...plain };
  }
}

const WRITE_OPERATIONS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
]);

function sealData(data: unknown): void {
  if (Array.isArray(data)) {
    data.forEach(sealData);
    return;
  }
  if (isPlainObject(data) && 'envVars' in data) {
    data.envVars = sealEnvVars(data.envVars);
  }
}

/**
 * The extension itself, kept free of the client type so it can be unit
 * tested. Reads: a result override of `envVars`, which Prisma applies at
 * every level (findMany, include from another model, select, transactions).
 * Writes: the top-level connector operations; the codebase has no nested
 * connector writes (a test keeps it that way).
 */
export const envVarsAtRestExtension = {
  name: 'env-vars-at-rest',
  result: {
    connector: {
      envVars: {
        needs: { envVars: true },
        compute: (connector: { envVars: unknown }) => openEnvVars(connector.envVars),
      },
    },
  },
  query: {
    connector: {
      async $allOperations({
        operation,
        args,
        query,
      }: {
        operation: string;
        args: any;
        query: (args: any) => Promise<unknown>;
      }) {
        if (WRITE_OPERATIONS.has(operation) && args) {
          if (operation === 'upsert') {
            sealData(args.create);
            sealData(args.update);
          } else {
            sealData(args.data);
          }
        }
        return query(args);
      },
    },
  },
} as const;
