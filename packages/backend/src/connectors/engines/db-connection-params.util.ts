/**
 * Connection-string query parameters that make a database driver read a path
 * on the server's own disk (or, for `options`, pass startup options to the
 * server). On AnythingMCP Cloud the server's disk belongs to every workspace,
 * so these are removed from a tenant's connection string before the driver
 * sees it. Self-hosted instances keep them: there the operator owns the disk.
 *
 * - pg (`pg-connection-string`): `sslcert`, `sslkey` and `sslrootcert` are
 *   read with `fs.readFileSync`; `options` is sent as server startup options.
 *   Keys are matched as written (the parser is case-sensitive).
 * - mongodb: `tlsCAFile`, `tlsCRLFile` and `tlsCertificateKeyFile` are read
 *   with `fs.promises.readFile`. The driver matches option names without
 *   regard to case, so this list does too.
 *
 * The other drivers need nothing here: mysql2 takes TLS material as strings
 * and refuses LOCAL INFILE without a stream factory (which a URL cannot
 * supply); the mssql, Oracle and SAP HANA configs are built from the host,
 * port, path and a fixed list of parameters only.
 */
export const CLOUD_BLOCKED_POSTGRES_PARAMS = ['sslcert', 'sslkey', 'sslrootcert', 'options'] as const;
export const CLOUD_BLOCKED_MONGODB_PARAMS = ['tlsCAFile', 'tlsCRLFile', 'tlsCertificateKeyFile'] as const;

/**
 * Decode one `key=value` pair's key the way the drivers do: as
 * `URLSearchParams` does, and also after pg-connection-string's pre-encoding
 * step (applied when the string has a space or a malformed `%` escape). A
 * pair is removed when either reading names a blocked key, so a key the
 * driver would decode to a blocked name cannot slip through.
 */
function decodedKeys(pair: string, preEncode: boolean): string[] {
  const rawKey = pair.split('=')[0];
  const keys = new Set<string>();
  const read = (k: string) => {
    for (const key of new URLSearchParams(`${k}=`).keys()) keys.add(key);
  };
  read(rawKey);
  if (preEncode) {
    try {
      read(encodeURI(rawKey).replace(/%25(\d\d)/g, '%$1'));
    } catch {
      // encodeURI throws on a lone surrogate; the raw reading still applies.
    }
  }
  return [...keys];
}

/**
 * Remove the given query parameters from a connection string, leaving every
 * other character as it was (credentials, hosts, the remaining parameters and
 * their order). Returns the new string and the names that were removed, never
 * their values.
 */
export function stripConnectionParams(
  connectionString: string,
  blocked: readonly string[],
  options: { caseInsensitive?: boolean } = {},
): { connectionString: string; removed: string[] } {
  // The query starts at the first `?` and ends at `#`: a `?` cannot occur
  // unencoded before it (it ends the authority and the path).
  const hashAt = connectionString.indexOf('#');
  const beforeHash = hashAt === -1 ? connectionString : connectionString.slice(0, hashAt);
  const fragment = hashAt === -1 ? '' : connectionString.slice(hashAt);
  const queryAt = beforeHash.indexOf('?');
  if (queryAt === -1) return { connectionString, removed: [] };

  const norm = (k: string) => (options.caseInsensitive ? k.toLowerCase() : k);
  const blockedSet = new Set(blocked.map(norm));
  const preEncode = / |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(connectionString);

  const removed = new Set<string>();
  const kept = beforeHash
    .slice(queryAt + 1)
    .split('&')
    .filter((pair) => {
      const hit = decodedKeys(pair, preEncode).find((k) => blockedSet.has(norm(k)));
      if (hit === undefined) return true;
      removed.add(blocked.find((b) => norm(b) === norm(hit)) ?? hit);
      return false;
    });
  if (removed.size === 0) return { connectionString, removed: [] };

  const query = kept.join('&');
  return {
    connectionString: `${beforeHash.slice(0, queryAt)}${query ? `?${query}` : ''}${fragment}`,
    removed: [...removed],
  };
}
