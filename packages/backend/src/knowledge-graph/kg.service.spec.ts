import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { KgService } from './kg.service';

/**
 * Unit coverage for the manual-curation methods, focused on tenant isolation
 * (cross-org access must fail closed) and core behaviour. Prisma is mocked.
 */
describe('KgService — manual curation', () => {
  const ORG = 'org-A';
  const OTHER = 'org-B';

  function make(prisma: any) {
    return new KgService(
      prisma,
      {} as any, // redis
      {} as any, // roles
      {} as any, // static
      {} as any, // observational
      {} as any, // llm
    );
  }

  describe('updateNode', () => {
    it('rejects a node from another org', async () => {
      const prisma = {
        kgNode: { findUnique: jest.fn().mockResolvedValue({ organizationId: OTHER }), update: jest.fn() },
      };
      await expect(make(prisma).updateNode(ORG, 'n1', { label: 'x' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.kgNode.update).not.toHaveBeenCalled();
    });

    it('updates label + description for an owned node', async () => {
      const update = jest.fn().mockResolvedValue({ id: 'n1' });
      const prisma = {
        kgNode: { findUnique: jest.fn().mockResolvedValue({ organizationId: ORG }), update },
      };
      await make(prisma).updateNode(ORG, 'n1', { label: '  Customer  ', description: 'desc' });
      expect(update).toHaveBeenCalledWith({
        where: { id: 'n1' },
        data: { label: 'Customer', description: 'desc' },
      });
    });
  });

  describe('deleteNode', () => {
    it('rejects a node from another org', async () => {
      const prisma = {
        kgNode: { findUnique: jest.fn().mockResolvedValue({ organizationId: OTHER }), delete: jest.fn() },
      };
      await expect(make(prisma).deleteNode(ORG, 'n1')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.kgNode.delete).not.toHaveBeenCalled();
    });
  });

  describe('createNode', () => {
    it("rejects a connector from another org", async () => {
      const prisma = {
        connector: { findUnique: jest.fn().mockResolvedValue({ organizationId: OTHER }) },
        kgNode: { findUnique: jest.fn(), create: jest.fn() },
      };
      await expect(
        make(prisma).createNode(ORG, { connectorId: 'c1', label: 'Thing' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.kgNode.create).not.toHaveBeenCalled();
    });

    it('creates a MANUAL node with a slugified entity', async () => {
      const create = jest.fn().mockResolvedValue({ id: 'n1' });
      const prisma = {
        connector: { findUnique: jest.fn().mockResolvedValue({ organizationId: ORG }) },
        kgNode: { findUnique: jest.fn().mockResolvedValue(null), create },
      };
      await make(prisma).createNode(ORG, { connectorId: 'c1', label: 'Loyalty Tier!' });
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            organizationId: ORG,
            connectorId: 'c1',
            entity: 'loyalty_tier',
            label: 'Loyalty Tier!',
            source: 'MANUAL',
          }),
        }),
      );
    });

    it('rejects a duplicate entity on the same connector', async () => {
      const prisma = {
        connector: { findUnique: jest.fn().mockResolvedValue({ organizationId: ORG }) },
        kgNode: { findUnique: jest.fn().mockResolvedValue({ id: 'exists' }), create: jest.fn() },
      };
      await expect(
        make(prisma).createNode(ORG, { connectorId: 'c1', label: 'Customer' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('requires a connector', async () => {
      const prisma = { connector: { findUnique: jest.fn() }, kgNode: {} };
      await expect(
        make(prisma).createNode(ORG, { connectorId: '', label: 'X' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('updateEdge', () => {
    it('rejects an edge from another org', async () => {
      const prisma = {
        kgEdge: { findUnique: jest.fn().mockResolvedValue({ organizationId: OTHER }), update: jest.fn() },
      };
      await expect(make(prisma).updateEdge(ORG, 'e1', { status: 'active' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('marks the edge MANUAL when a description is set', async () => {
      const update = jest.fn().mockResolvedValue({ id: 'e1' });
      const prisma = {
        kgEdge: {
          findUnique: jest.fn().mockResolvedValue({
            organizationId: ORG,
            kind: 'references',
            sourceNodeId: 's',
            targetNodeId: 't',
          }),
          update,
        },
      };
      await make(prisma).updateEdge(ORG, 'e1', { note: 'because reasons' });
      expect(update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { note: 'because reasons', isManual: true },
      });
    });

    it('409s when retyping clashes with an existing edge', async () => {
      const prisma = {
        kgEdge: {
          findUnique: jest
            .fn()
            .mockResolvedValueOnce({
              organizationId: ORG,
              kind: 'references',
              sourceNodeId: 's',
              targetNodeId: 't',
            })
            .mockResolvedValueOnce({ id: 'other' }), // clash on the new kind
          update: jest.fn(),
        },
      };
      await expect(
        make(prisma).updateEdge(ORG, 'e1', { kind: 'same_identity' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.kgEdge.update).not.toHaveBeenCalled();
    });
  });

  describe('lookup scoping', () => {
    it('restricts entities + edges to the given connectors and drops out-of-scope edges', async () => {
      const nodes = [
        { id: 'n1', entity: 'customer', label: 'Customer', description: null, fields: [], toolNames: ['t'] },
      ]; // only in-scope node returned by the (mocked) scoped query
      const prisma = {
        kgSkillSuggestion: { findMany: jest.fn().mockResolvedValue([]) },
        kgNode: { findMany: jest.fn().mockResolvedValue(nodes) },
        kgEdge: {
          findMany: jest.fn().mockResolvedValue([
            { sourceNodeId: 'n1', targetNodeId: 'n1', kind: 'self', matchKey: null, note: null }, // same node, ignored
            { sourceNodeId: 'n1', targetNodeId: 'OUT', kind: 'references', matchKey: 'x', note: null }, // out of scope
          ]),
        },
      };
      const r = await make(prisma).lookup(ORG, 'customer', { connectorIds: ['c1'] });
      // the scoped node query must carry the connector filter
      expect(prisma.kgNode.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ organizationId: ORG, connectorId: { in: ['c1'] } }),
        }),
      );
      // edge to an out-of-scope node is filtered out (both endpoints must be in scope)
      expect(r.relatedTo.every((e: any) => e.to !== '?')).toBe(true);
      expect(r.entities.map((e: any) => e.entity)).toEqual(['customer']);
    });

    /**
     * A connector is in scope as soon as the caller's role allows one of its
     * tools. The graph of that connector still named every tool of it, so
     * kg_how_to_obtain told a member which tools exist beyond their role.
     */
    describe('with the tool names the caller may call', () => {
      const prismaFor = () => ({
        kgSkillSuggestion: { findMany: jest.fn().mockResolvedValue([]) },
        kgNode: {
          findMany: jest.fn().mockResolvedValue([
            { id: 'n1', entity: 'customer', label: 'Customer', description: null, fields: [{ name: 'customer_id' }], toolNames: ['crm_get_customer', 'crm_delete_customer'] },
            { id: 'n2', entity: 'invoice', label: 'Invoice', description: null, fields: [{ name: 'customer_id' }], toolNames: ['crm_list_invoices'] },
            { id: 'n3', entity: 'payroll', label: 'Payroll', description: null, fields: [{ name: 'customer_id' }], toolNames: ['crm_read_payroll'] },
            { id: 'n4', entity: 'customer_note', label: 'Customer note', description: 'Curated by hand', fields: [], toolNames: [] },
          ]),
        },
        kgEdge: {
          findMany: jest.fn().mockResolvedValue([
            { sourceNodeId: 'n2', targetNodeId: 'n1', kind: 'references', matchKey: 'customer_id', note: null },
            { sourceNodeId: 'n3', targetNodeId: 'n1', kind: 'references', matchKey: 'customer_id', note: null },
          ]),
        },
      });

      it('names only allowed tools and drops an entity that only denied tools reach', async () => {
        const r = await make(prismaFor()).lookup(ORG, 'customer_id', {
          connectorIds: ['c1'],
          allowedToolNames: new Set(['crm_get_customer', 'crm_list_invoices']),
        });
        const text = JSON.stringify(r);
        expect(text).not.toContain('crm_delete_customer');
        expect(text).not.toContain('crm_read_payroll');
        expect(text).not.toContain('Payroll');
        expect(r.entities.map((e: any) => e.entity).sort()).toEqual(['customer', 'invoice']);
        expect(r.entities.find((e: any) => e.entity === 'customer')!.tools).toEqual(['crm_get_customer']);
        expect(r.howToObtain).toEqual([
          expect.objectContaining({ fromEntity: 'Invoice', toEntity: 'Customer', viaTools: ['crm_list_invoices'] }),
        ]);
      });

      it('keeps an entity curated by hand, which no tool names', async () => {
        const r = await make(prismaFor()).lookup(ORG, 'customer_note', {
          connectorIds: ['c1'],
          allowedToolNames: new Set(['crm_get_customer']),
        });
        expect(r.entities.map((e: any) => e.entity)).toEqual(['customer_note']);
      });

      it('narrows nothing for a caller whose roles do not limit tools', async () => {
        for (const allowedToolNames of [null, undefined]) {
          const r = await make(prismaFor()).lookup(ORG, 'customer_id', { connectorIds: ['c1'], allowedToolNames });
          expect(r.entities.map((e: any) => e.entity).sort()).toEqual(['customer', 'invoice', 'payroll']);
          expect(r.entities.find((e: any) => e.entity === 'customer')!.tools).toEqual(['crm_get_customer', 'crm_delete_customer']);
          expect(r.howToObtain).toHaveLength(2);
        }
      });
    });
  });

  describe('enrich', () => {
    const redis = { isConnected: false };
    function withLlm(enrich: jest.Mock) {
      return new KgService({} as any, redis as any, {} as any, {} as any, {} as any, { enrich } as any);
    }

    it('turns a model failure into a 502 with a readable message', async () => {
      const svc = withLlm(jest.fn().mockRejectedValue(new Error('LLM returned unusable JSON: {"a":')));
      await expect(svc.enrich(ORG)).rejects.toMatchObject({
        status: 502,
        message: 'The AI model did not return a usable answer. Please try again.',
      });
    });

    it('keeps HTTP errors such as a disabled workspace as they are', async () => {
      const conflict = new ConflictException('AI enrichment is disabled for this workspace.');
      const svc = withLlm(jest.fn().mockRejectedValue(conflict));
      await expect(svc.enrich(ORG)).rejects.toBe(conflict);
    });
  });
});
