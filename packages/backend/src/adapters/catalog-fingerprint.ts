import { createHash } from 'node:crypto';

/**
 * Content-addressed versioning for catalog adapters.
 *
 * A connector installed from a catalog adapter stores a copy of the adapter's
 * tools in `mcp_tools`. To detect later that the catalog moved on (so the
 * connector is stale — see the catalog re-sync feature), we fingerprint the
 * parts of an adapter that are copied into a connector and compare hashes.
 *
 * The hash is deterministic (keys sorted, tools ordered by name) so the same
 * adapter content always yields the same version, with no manual bumping.
 */

/** Stable JSON: object keys sorted recursively so key order never affects the hash. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = canonicalize(obj[key]);
    }
    return out;
  }
  return value;
}

export function hashContent(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex')
    .slice(0, 12);
}

type FingerprintTool = {
  name: string;
  description?: string;
  parameters?: unknown;
  endpointMapping?: unknown;
  responseMapping?: unknown;
  useProxy?: boolean;
};

type FingerprintAdapter = {
  instructions?: string;
  connector?: { name?: string; type?: string; baseUrl?: string; authType?: string };
  tools: FingerprintTool[];
};

/**
 * The canonical per-tool shape used both for the adapter version and for the
 * connector ↔ catalog diff. Only fields we actually copy into `mcp_tools`.
 */
export function toolFingerprint(tool: FingerprintTool) {
  return {
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.parameters ?? {},
    endpointMapping: tool.endpointMapping ?? {},
    responseMapping: tool.responseMapping ?? null,
    useProxy: tool.useProxy === true,
  };
}

/** Stable version string for an adapter's installable content. */
export function computeAdapterVersion(adapter: FingerprintAdapter): string {
  const tools = [...adapter.tools]
    .map(toolFingerprint)
    .sort((a, b) => a.name.localeCompare(b.name));
  return hashContent({
    instructions: adapter.instructions ?? '',
    connector: {
      name: adapter.connector?.name ?? '',
      type: adapter.connector?.type ?? '',
      baseUrl: adapter.connector?.baseUrl ?? '',
      authType: adapter.connector?.authType ?? '',
    },
    tools,
  });
}

/** Baseline hash for an adapter's instructions, to detect later user edits. */
export function hashInstructions(instructions: string | null | undefined): string {
  return hashContent({ instructions: instructions ?? '' });
}
