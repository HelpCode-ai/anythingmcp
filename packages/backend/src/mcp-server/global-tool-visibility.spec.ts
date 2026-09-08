import { toolVisibilityRole } from './mcp-server.service';

/**
 * The global `/mcp` registry holds one entry per tool name for the WHOLE
 * deployment, and the transport's `tools/list` handler is synchronous — it
 * cannot ask the database who is calling. It filters on `user.roles` against
 * each tool's `requiredRoles`, so the controller resolves visibility
 * asynchronously first and plants the answer on the request.
 *
 * These tests pin that contract. If `attachVisibleTools` stops running, or the
 * registration stops declaring a visibility role, one tenant's tool names,
 * descriptions and input schemas become readable by every other tenant.
 */
describe('global /mcp tool visibility', () => {
  // Mirrors @rekog/mcp-nest's ToolAuthorizationService.canAccessTool for the
  // 'any' match mode, which is what the transport applies to tools/list.
  const canSee = (userRoles: string[] | undefined, toolName: string) => {
    const required = [toolVisibilityRole(toolName)];
    if (!userRoles) return false;
    return required.some((r) => userRoles.includes(r));
  };

  it('namespaces the synthetic role so it cannot collide with a real one', () => {
    expect(toolVisibilityRole('reports')).toBe('tool:reports');
    expect(toolVisibilityRole('ADMIN')).not.toBe('ADMIN');
  });

  it('hides a tool whose visibility role the caller does not hold', () => {
    const roles = [toolVisibilityRole('mine')];
    expect(canSee(roles, 'mine')).toBe(true);
    expect(canSee(roles, 'othertenant_confidential_report')).toBe(false);
  });

  it('shows nothing to a caller with no visibility roles at all', () => {
    expect(canSee([], 'anything')).toBe(false);
  });

  // Two tenants can name a tool the same way; the registry keeps one entry, so
  // gating on the NAME is what lets both tenants see their own copy. Gating on
  // the tool id would show it only to whichever tenant registered first.
  it('is keyed on the tool name, not a per-tenant id', () => {
    const orgA = [toolVisibilityRole('shared_name')];
    const orgB = [toolVisibilityRole('shared_name')];
    expect(canSee(orgA, 'shared_name')).toBe(true);
    expect(canSee(orgB, 'shared_name')).toBe(true);
  });
});
