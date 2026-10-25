import type { Connector, McpServer } from './api';

export interface OrgRecordsCache {
  connectors: Connector[];
  mcpServers: McpServer[];
}

// Module-level cache keyed by organizationId
export const recordsCache = new Map<string, OrgRecordsCache>();
export const inFlightRequests = new Map<string, Promise<OrgRecordsCache>>();

/**
 * Clear the module-level cache and any pending in-flight requests.
 * Used on logout, organization switch, or session invalidation to avoid data leakage.
 */
export function clearCommandPaletteCache(): void {
  recordsCache.clear();
  inFlightRequests.clear();
}

export function getCachedOrgRecords(orgId: string): OrgRecordsCache | null {
  return recordsCache.get(orgId) ?? null;
}
