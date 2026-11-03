import type { RegisteredTool } from './tool-registry';

/**
 * Test double helper: adds ToolRegistry's index reads to a mock that only
 * defines `getAllTools`, derived from it at call time, so a spec that
 * changes `getAllTools` (mockReturnValue) changes them too.
 */
export function withRegistryIndexes<T extends { getAllTools: () => RegisteredTool[] }>(
  registry: T,
): T & {
  getToolsForOrganization: (organizationId: string) => RegisteredTool[];
  getToolsForConnectors: (connectorIds: Iterable<string>) => RegisteredTool[];
} {
  return Object.assign(registry, {
    getToolsForOrganization: (organizationId: string) =>
      registry.getAllTools().filter((t) => t.organizationId === organizationId),
    getToolsForConnectors: (connectorIds: Iterable<string>) => {
      const ids = new Set(connectorIds);
      return registry.getAllTools().filter((t) => ids.has(t.connectorId));
    },
  });
}
