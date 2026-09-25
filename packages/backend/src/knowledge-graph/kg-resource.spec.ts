import { KgService } from './kg.service';

/**
 * describeForResource() is the body of the per-server MCP resource
 * `anythingmcp://server/<id>/knowledge-graph`. A client attaches it to the
 * model's context whole, so it must stay inside the caller's scope and stay
 * bounded.
 */
describe('KgService.describeForResource', () => {
  const ORG = 'org-A';

  const node = (id: string, connectorId: string, label: string, extra: Record<string, unknown> = {}) => ({
    id,
    entity: label.toLowerCase(),
    label,
    description: null,
    fields: [{ name: 'id' }, { name: `${label.toLowerCase()}_number` }],
    toolNames: [`${connectorId}_get_${label.toLowerCase()}`, `${connectorId}_list_${label.toLowerCase()}s`],
    connector: { name: connectorId === 'c1' ? 'CRM' : 'ERP' },
    ...extra,
  });

  function make({ nodes = [] as any[], edges = [] as any[], skills = [] as any[] } = {}) {
    const prisma = {
      kgNode: { findMany: jest.fn().mockResolvedValue(nodes) },
      kgEdge: { findMany: jest.fn().mockResolvedValue(edges) },
      kgSkillSuggestion: { findMany: jest.fn().mockResolvedValue(skills) },
    };
    const svc = new KgService(prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    return { svc, prisma };
  }

  it('reads only the given connectors, and only active edges with both ends in scope', async () => {
    const { svc, prisma } = make({ nodes: [node('n1', 'c1', 'Customer'), node('n2', 'c2', 'Order')] });
    await svc.describeForResource(ORG, { connectorIds: ['c1', 'c2'], mcpServerId: 'srv-1' });

    expect(prisma.kgNode.findMany.mock.calls[0][0].where).toEqual({
      organizationId: ORG,
      connectorId: { in: ['c1', 'c2'] },
    });
    expect(prisma.kgEdge.findMany.mock.calls[0][0].where).toEqual({
      organizationId: ORG,
      status: 'active',
      sourceNodeId: { in: ['n1', 'n2'] },
      targetNodeId: { in: ['n1', 'n2'] },
    });
  });

  it('touches no entity at all for a caller who may use no connector', async () => {
    const { svc, prisma } = make();
    const text = await svc.describeForResource(ORG, { connectorIds: [], mcpServerId: 'srv-1' });

    expect(prisma.kgNode.findMany).not.toHaveBeenCalled();
    expect(prisma.kgEdge.findMany).not.toHaveBeenCalled();
    expect(text).toContain('no entities for the connectors you can use');
  });

  it('lists entities with their connector, tools and fields, and how they connect', async () => {
    const { svc } = make({
      nodes: [node('n1', 'c1', 'Customer'), node('n2', 'c2', 'Order', { description: 'A sales order.' })],
      edges: [{ sourceNodeId: 'n2', targetNodeId: 'n1', kind: 'references', matchKey: 'customer_id', note: null }],
      skills: [{ title: 'Monthly revenue', whenToUse: 'When asked for revenue per month.' }],
    });
    const text = await svc.describeForResource(ORG, { connectorIds: ['c1', 'c2'], serverName: 'Sales' });

    expect(text).toContain('# Knowledge graph for Sales');
    expect(text).toContain('- **Customer** (CRM)');
    expect(text).toContain('- **Order** (ERP): A sales order.');
    expect(text).toContain('`c1_get_customer`');
    expect(text).toContain('`customer_number`');
    expect(text).toContain('- Order (ERP) refers to Customer (CRM) via `customer_id`');
    expect(text).toContain('- **Monthly revenue**: When asked for revenue per month.');
  });

  it('stays bounded on a large graph and says what it left out', async () => {
    const many = Array.from({ length: 170 }, (_, i) => node(`n${i}`, 'c1', `Thing${i}`));
    const { svc } = make({ nodes: many });
    const text = await svc.describeForResource(ORG, { connectorIds: ['c1'] });

    expect(text).toContain('## Entities (170)');
    expect(text).toContain('20 more entities not listed');
    expect(text).not.toContain('**Thing160**');
  });
});
