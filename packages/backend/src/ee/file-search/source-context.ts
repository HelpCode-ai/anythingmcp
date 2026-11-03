// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import { decrypt } from '../../common/crypto/encryption.util';
import {
  localRootsFromEnv,
  parseFileSearchConfig,
  pickSecrets,
  type FileSearchSecrets,
} from '../../file-search/file-search-config';
import type { FileSearchConfig } from '../../file-search/file-search.types';
import { driverFor } from './sources';
import type { ConnectResult } from './sources/source.types';

export function isCloud(): boolean {
  return process.env.DEPLOYMENT_MODE === 'cloud';
}

export interface ConnectorRow {
  id: string;
  name: string;
  organizationId: string;
  config: unknown;
  authConfig: string | null;
  isActive: boolean;
}

/** Settings and decrypted secrets of a connector. Secrets live only in the worker process. */
export function sourceOf(c: ConnectorRow): { config: FileSearchConfig; secrets: FileSearchSecrets } {
  const raw = (c.config as { fileSearch?: unknown } | null)?.fileSearch;
  const config = parseFileSearchConfig(raw, { cloud: isCloud(), localRoots: localRootsFromEnv(), connectorName: c.name });
  let secrets: FileSearchSecrets = {};
  if (c.authConfig) {
    const key = process.env.ENCRYPTION_KEY;
    if (!key) throw new Error('ENCRYPTION_KEY is not set in the files worker');
    secrets = pickSecrets(JSON.parse(decrypt(c.authConfig, key)));
  }
  return { config, secrets };
}

export async function openSource(c: ConnectorRow): Promise<ConnectResult & { config: FileSearchConfig }> {
  const { config, secrets } = sourceOf(c);
  const r = await driverFor(config.protocol).connect(config, secrets, { cloud: isCloud() });
  return { ...r, config };
}
