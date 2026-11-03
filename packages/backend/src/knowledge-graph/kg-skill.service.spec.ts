import { ConflictException, NotFoundException } from '@nestjs/common';
import { KgSkillService } from './kg-skill.service';

function okJson(body: any) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
}

/** Tenant isolation + defaults for manual skill creation. Prisma/LLM mocked. */
describe('KgSkillService.create', () => {
  const ORG = 'org-A';
  const OTHER = 'org-B';

  function make(prisma: any) {
    return new KgSkillService(prisma, {} as any);
  }

  it('rejects an MCP server from another org', async () => {
    const prisma = {
      mcpServerConfig: { findUnique: jest.fn().mockResolvedValue({ organizationId: OTHER }) },
      kgSkillSuggestion: { create: jest.fn() },
    };
    await expect(
      make(prisma).create(ORG, { title: 'T', instruction: 'I', mcpServerId: 'srv' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.kgSkillSuggestion.create).not.toHaveBeenCalled();
  });

  it('rejects a connector from another org', async () => {
    const prisma = {
      connector: { findUnique: jest.fn().mockResolvedValue({ organizationId: OTHER }) },
      kgSkillSuggestion: { create: jest.fn() },
    };
    await expect(
      make(prisma).create(ORG, { title: 'T', instruction: 'I', connectorId: 'c1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('requires title + instruction', async () => {
    const prisma = { kgSkillSuggestion: { create: jest.fn() } };
    await expect(make(prisma).create(ORG, { title: '', instruction: '' })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('creates an applied, server-scoped skill by default', async () => {
    const create = jest.fn().mockResolvedValue({ id: 's1' });
    const prisma = {
      mcpServerConfig: { findUnique: jest.fn().mockResolvedValue({ organizationId: ORG }) },
      kgSkillSuggestion: { create },
    };
    await make(prisma).create(ORG, { title: 'Quote net price', instruction: 'Use get_price', mcpServerId: 'srv' });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: ORG,
          mcpServerId: 'srv',
          connectorId: null,
          title: 'Quote net price',
          status: 'applied',
        }),
      }),
    );
  });
});

/** Unusable custom replies must leave pending suggestions untouched (test 2 for #816 review). */
describe('KgSkillService custom skip', () => {
  const ORG = 'org-A';
  const realFetch = global.fetch;

  function setKgEnv() {
    process.env.KG_LLM_BASE_URL = 'http://localhost:11434/v1';
    process.env.KG_LLM_MODEL = 'qwen2.5';
    delete process.env.KG_LLM_API_KEY;
  }
  function clearKgEnv() {
    delete process.env.KG_LLM_BASE_URL;
    delete process.env.KG_LLM_MODEL;
  }

  beforeEach(() => {
    setKgEnv();
    global.fetch = jest.fn();
  });
  afterEach(() => {
    global.fetch = realFetch;
    clearKgEnv();
    jest.restoreAllMocks();
  });

  function generatePrisma() {
    return {
      toolInvocation: {
        findMany: jest.fn().mockResolvedValue([
          {
            intent: 'quote net price',
            status: 'SUCCESS',
            tool: { name: 'get_price', connector: { name: 'Billing' } },
          },
        ]),
      },
      connector: { findMany: jest.fn().mockResolvedValue([{ id: 'c1', name: 'Billing' }]) },
      orgSettings: { findUnique: jest.fn().mockResolvedValue(null) },
      kgSkillSuggestion: { deleteMany: jest.fn(), create: jest.fn() },
    };
  }

  it('generate() leaves pending suggestions untouched on an unusable reply', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      okJson({ choices: [{ message: { content: 'Sure, here are some thoughts...' } }] }),
    );
    const prisma = generatePrisma();
    const svc = new KgSkillService(prisma as any, { isEnabled: async () => true } as any);
    const res = await svc.generate(ORG);
    expect(res).toEqual({ created: 0, skipped: true, model: 'qwen2.5' });
    expect(prisma.kgSkillSuggestion.deleteMany).not.toHaveBeenCalled();
    expect(prisma.kgSkillSuggestion.create).not.toHaveBeenCalled();
  });

  it('generate() still replaces pending suggestions on a usable reply', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      okJson({
        choices: [
          {
            message: {
              content: JSON.stringify({
                skills: [{ connector: 'Billing', title: 'T', instruction: 'I', confidence: 0.5 }],
              }),
            },
          },
        ],
      }),
    );
    const prisma = generatePrisma();
    const svc = new KgSkillService(prisma as any, { isEnabled: async () => true } as any);
    const res = await svc.generate(ORG);
    expect(res.created).toBe(1);
    expect(res.skipped).toBeUndefined();
    expect(prisma.kgSkillSuggestion.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('consolidate() leaves applied skills untouched on an unusable reply', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      okJson({ choices: [{ message: { content: 'Sure, here are some thoughts...' } }] }),
    );
    const applied = [0, 1].map((i) => ({
      id: `s${i}`,
      title: `rule ${i}`,
      whenToUse: 'w',
      instruction: 'do it',
      connector: { name: 'Billing' },
    }));
    const prisma = {
      kgSkillSuggestion: { findMany: jest.fn().mockResolvedValue(applied), deleteMany: jest.fn() },
      connector: { findMany: jest.fn() },
    };
    const svc = new KgSkillService(prisma as any, { isEnabled: async () => true } as any);
    const res = await svc.consolidate(ORG);
    expect(res).toEqual(
      expect.objectContaining({ before: 2, after: 2, model: 'qwen2.5' }),
    );
    expect(prisma.kgSkillSuggestion.deleteMany).not.toHaveBeenCalled();
  });
});

/**
 * Generation used to delete every pending skill in its scope, including
 * Agent Skills Finder suggestions awaiting approval and manual pending ones.
 * It now replaces only its own previous output (`source: 'llm'`).
 */
describe('KgSkillService provenance', () => {
  const ORG = 'org-A';
  const realFetch = global.fetch;

  beforeEach(() => {
    process.env.KG_LLM_BASE_URL = 'http://localhost:11434/v1';
    process.env.KG_LLM_MODEL = 'qwen2.5';
    delete process.env.KG_LLM_API_KEY;
    global.fetch = jest.fn().mockResolvedValue(
      okJson({
        choices: [
          {
            message: {
              content: JSON.stringify({ skills: [{ title: 'T', instruction: 'I', confidence: 0.5 }] }),
            },
          },
        ],
      }),
    );
  });
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.KG_LLM_BASE_URL;
    delete process.env.KG_LLM_MODEL;
  });

  it('server generation deletes only its own pending llm rows and tags new ones llm', async () => {
    const prisma = {
      mcpServerConfig: {
        findUnique: jest.fn().mockResolvedValue({ id: 'srv', name: 'S', organizationId: ORG }),
      },
      mcpServerConnector: { findMany: jest.fn().mockResolvedValue([]) },
      kgNode: { findMany: jest.fn().mockResolvedValue([]) },
      toolInvocation: { findMany: jest.fn().mockResolvedValue([]) },
      orgSettings: { findUnique: jest.fn().mockResolvedValue(null) },
      kgSkillSuggestion: { deleteMany: jest.fn(), create: jest.fn() },
    };
    const svc = new KgSkillService(prisma as any, { isEnabled: async () => true } as any);
    await svc.generate(ORG, { mcpServerId: 'srv' });

    expect(prisma.kgSkillSuggestion.deleteMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, status: 'pending', source: 'llm', mcpServerId: 'srv' },
    });
    expect(prisma.kgSkillSuggestion.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ source: 'llm', status: 'pending', mcpServerId: 'srv' }),
    );
  });

  it('connector generation deletes only its own pending llm rows', async () => {
    const prisma = {
      toolInvocation: {
        findMany: jest.fn().mockResolvedValue([
          { intent: 'x', status: 'SUCCESS', tool: { name: 't', connector: { name: 'C' } } },
        ]),
      },
      connector: { findMany: jest.fn().mockResolvedValue([]) },
      orgSettings: { findUnique: jest.fn().mockResolvedValue(null) },
      kgSkillSuggestion: { deleteMany: jest.fn(), create: jest.fn() },
    };
    const svc = new KgSkillService(prisma as any, { isEnabled: async () => true } as any);
    await svc.generate(ORG);

    expect(prisma.kgSkillSuggestion.deleteMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, status: 'pending', source: 'llm', mcpServerId: null },
    });
  });
});

describe('KgSkillService.create source', () => {
  const ORG = 'org-A';

  function prismaFor() {
    return {
      mcpServerConfig: { findUnique: jest.fn().mockResolvedValue({ organizationId: ORG }) },
      kgSkillSuggestion: { create: jest.fn().mockResolvedValue({ id: 's1' }) },
    };
  }

  it('records manual by default', async () => {
    const prisma = prismaFor();
    await new KgSkillService(prisma as any, {} as any).create(ORG, {
      title: 'T',
      instruction: 'I',
      mcpServerId: 'srv',
    });
    expect(prisma.kgSkillSuggestion.create.mock.calls[0][0].data.source).toBe('manual');
  });

  it('records finder when the Skills Finder files it', async () => {
    const prisma = prismaFor();
    await new KgSkillService(prisma as any, {} as any).create(ORG, {
      title: 'T',
      instruction: 'I',
      mcpServerId: 'srv',
      status: 'pending',
      source: 'finder',
    });
    expect(prisma.kgSkillSuggestion.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ source: 'finder', status: 'pending' }),
    );
  });
});

describe('KgSkillService.activeSkillsText', () => {
  it('filters by organization as well as by the given ids', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const svc = new KgSkillService({ kgSkillSuggestion: { findMany } } as any, {} as any);
    await svc.activeSkillsText('org-A', 'srv-1', ['c-1']);
    expect(findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ organizationId: 'org-A', status: 'applied' }),
    );
  });
});

describe('KgSkillService delivery modes', () => {
  const ORG = 'org-A';
  const row = (i: number, extra: Partial<any> = {}) => ({
    id: `s${i}`,
    title: `Skill ${i}`,
    whenToUse: `when ${i}`,
    instruction: `rule ${i}`,
    body: null,
    version: 1,
    ...extra,
  });
  const svcWith = (rows: any[]) =>
    new KgSkillService({ kgSkillSuggestion: { findMany: jest.fn().mockResolvedValue(rows) } } as any, {} as any);

  it('inline keeps the existing format for skills without a procedure', async () => {
    const text = await svcWith([row(1)]).activeSkillsText(ORG, 'srv', [], 'inline');
    expect(text).toBe('## Workspace skills\n- Skill 1 (when: when 1): rule 1');
  });

  it('inline references a procedure instead of pasting it', async () => {
    const text = await svcWith([row(1, { body: 'STEP-BY-STEP' })]).activeSkillsText(ORG, 'srv', [], 'inline');
    expect(text).toContain('skill_get "s1"');
    expect(text).not.toContain('STEP-BY-STEP');
  });

  it('full pastes the procedure (shared guide)', async () => {
    const text = await svcWith([row(1, { body: 'STEP-BY-STEP' })]).activeSkillsText(ORG, 'srv', [], 'full');
    expect(text).toContain('STEP-BY-STEP');
  });

  it('auto stays inline while small and switches to the index when large', async () => {
    const small = await svcWith([row(1)]).activeSkillsText(ORG, 'srv', [], 'auto');
    expect(small).toContain('rule 1');

    const big = Array.from({ length: 40 }, (_, i) => row(i, { instruction: 'x'.repeat(300) }));
    const text = (await svcWith(big).activeSkillsText(ORG, 'srv', [], 'auto'))!;
    expect(text).toContain('call `skill_get`');
    expect(text).toContain('- `s0` Skill 0: when 0');
    expect(text).not.toContain('x'.repeat(300));
  });

  it('index lists up to its budget and points to skills_list for the rest', async () => {
    const many = Array.from({ length: 200 }, (_, i) => row(i, { whenToUse: 'w'.repeat(150) }));
    const text = (await svcWith(many).activeSkillsText(ORG, 'srv', [], 'index'))!;
    expect(text.length).toBeLessThan(8_200);
    expect(text).toMatch(/…and \d+ more: call `skills_list`/);
  });
});

describe('KgSkillService.getForCaller', () => {
  it('reads only visible applied skills of the organization and counts the use', async () => {
    const skill = { id: 's1', title: 'T', whenToUse: '', instruction: 'I', body: null, version: 2 };
    const findFirst = jest.fn().mockResolvedValue(skill);
    const update = jest.fn().mockResolvedValue({});
    const svc = new KgSkillService({ kgSkillSuggestion: { findFirst, update } } as any, {} as any);

    expect(await svc.getForCaller('org-A', 'srv-1', ['c-1'], 's1')).toBe(skill);
    const where = findFirst.mock.calls[0][0].where;
    expect(where.AND[0]).toEqual({
      organizationId: 'org-A',
      status: 'applied',
      kind: { not: 'code' },
      OR: [{ mcpServerId: { in: ['srv-1'] } }, { connectorId: { in: ['c-1'] } }],
    });
    expect(where.AND[1]).toEqual({ OR: [{ id: 's1' }, { title: { equals: 's1', mode: 'insensitive' } }] });
    expect(update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { useCount: { increment: 1 }, lastUsedAt: expect.any(Date) },
    });
  });

  it('returns null without counting when the skill is not visible', async () => {
    const update = jest.fn();
    const svc = new KgSkillService(
      { kgSkillSuggestion: { findFirst: jest.fn().mockResolvedValue(null), update } } as any,
      {} as any,
    );
    expect(await svc.getForCaller('org-A', 'srv-1', [], 'other-org-skill')).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });
});

describe('KgSkillService.update versions', () => {
  const current = {
    id: 's1',
    organizationId: 'org-A',
    title: 'Old',
    whenToUse: 'w',
    instruction: 'old rule',
    body: null,
    version: 3,
  };

  function make() {
    const tx = {
      kgSkillVersion: { create: jest.fn() },
      kgSkillSuggestion: { update: jest.fn().mockResolvedValue({ id: 's1', version: 4 }) },
    };
    const prisma = {
      kgSkillSuggestion: {
        findUnique: jest.fn().mockResolvedValue(current),
        update: jest.fn().mockResolvedValue({ id: 's1' }),
      },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    return { svc: new KgSkillService(prisma as any, {} as any), prisma, tx };
  }

  it('keeps the previous content as a version and increments it on a content change', async () => {
    const { svc, tx } = make();
    await svc.update('org-A', 's1', { instruction: 'new rule', body: 'steps' }, 'u-1');
    expect(tx.kgSkillVersion.create).toHaveBeenCalledWith({
      data: {
        skillId: 's1',
        organizationId: 'org-A',
        version: 3,
        title: 'Old',
        whenToUse: 'w',
        instruction: 'old rule',
        body: null,
        editedByUserId: 'u-1',
      },
    });
    expect(tx.kgSkillSuggestion.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { instruction: 'new rule', body: 'steps', version: { increment: 1 } },
    });
  });

  it('does not version a status-only change', async () => {
    const { svc, prisma } = make();
    await svc.update('org-A', 's1', { status: 'dismissed' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.kgSkillSuggestion.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { status: 'dismissed' },
    });
  });

  it('refuses a skill of another organization', async () => {
    const { svc, prisma } = make();
    prisma.kgSkillSuggestion.findUnique.mockResolvedValue({ ...current, organizationId: 'org-B' });
    await expect(svc.update('org-A', 's1', { title: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('KgSkillService with folders', () => {
  const ORG = 'org-A';
  const tree = [
    { id: 'f-sales', parentId: null, name: 'Sales', description: 'Selling', roleIds: [], path: 'Sales', depth: 1 },
    { id: 'f-quotes', parentId: 'f-sales', name: 'Quotes', description: null, roleIds: [], path: 'Sales / Quotes', depth: 2 },
  ];
  const access = (ids: string[], all = false) => ({
    organizationId: ORG,
    all,
    ids: new Set(ids),
    folders: tree.filter((f) => ids.includes(f.id)),
  });
  const row = (i: number, folderId: string | null, extra: Partial<any> = {}) => ({
    id: `s${i}`,
    title: `Skill ${i}`,
    whenToUse: `when ${i}`,
    instruction: `rule ${i}`,
    body: null,
    version: 1,
    folderId,
    ...extra,
  });

  it('keeps skills in folders the caller may not see out of every query', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const svc = new KgSkillService({ kgSkillSuggestion: { findMany } } as any, {} as any);
    await svc.activeSkillsText(ORG, 'srv', [], 'auto', access(['f-sales']) as any);
    expect(findMany.mock.calls[0][0].where.AND).toEqual([
      { OR: [{ folderId: null }, { folderId: { in: ['f-sales'] } }] },
    ]);
  });

  it('adds no folder filter when the caller sees everything', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const svc = new KgSkillService({ kgSkillSuggestion: { findMany } } as any, {} as any);
    await svc.activeSkillsText(ORG, 'srv', [], 'auto', access(['f-sales', 'f-quotes'], true) as any);
    expect(findMany.mock.calls[0][0].where.AND).toBeUndefined();
  });

  it('groups the index by folder', async () => {
    const rows = [row(1, null), row(2, 'f-quotes')];
    const svc = new KgSkillService({ kgSkillSuggestion: { findMany: jest.fn().mockResolvedValue(rows) } } as any, {} as any);
    const text = (await svc.activeSkillsText(ORG, 'srv', [], 'index', access(['f-sales', 'f-quotes'], true) as any))!;
    expect(text).toContain('- `s1` Skill 1: when 1\n### Sales / Quotes\n- `s2` Skill 2: when 2');
  });

  it('summarises top-level folders when the grouped index does not fit', async () => {
    const rows = [row(0, null), ...Array.from({ length: 120 }, (_, i) => row(i + 1, 'f-quotes', { whenToUse: 'w'.repeat(150) }))];
    const svc = new KgSkillService({ kgSkillSuggestion: { findMany: jest.fn().mockResolvedValue(rows) } } as any, {} as any);
    const text = (await svc.activeSkillsText(ORG, 'srv', [], 'index', access(['f-sales', 'f-quotes'], true) as any))!;
    expect(text).toContain('- Folder "Sales" (120 skills): Selling');
    expect(text).toContain('- `s0` Skill 0');
    expect(text).not.toContain('`s5`');
  });

  it('shows the folder next to a skill in full text', async () => {
    const svc = new KgSkillService(
      { kgSkillSuggestion: { findMany: jest.fn().mockResolvedValue([row(1, 'f-quotes')]) } } as any,
      {} as any,
    );
    const text = await svc.activeSkillsText(ORG, 'srv', [], 'inline', access(['f-sales', 'f-quotes'], true) as any);
    expect(text).toBe('## Workspace skills\n- Skill 1 [Sales / Quotes] (when: when 1): rule 1');
  });

  it('lists a folder with its subfolders by path, and nothing for an unknown or hidden folder', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const svc = new KgSkillService({ kgSkillSuggestion: { findMany } } as any, {} as any);
    await svc.listForCaller(ORG, 'srv', [], undefined, access(['f-sales', 'f-quotes'], true) as any, 'sales');
    expect(findMany.mock.calls[0][0].where.AND[1]).toEqual({ folderId: { in: ['f-sales', 'f-quotes'] } });

    findMany.mockClear();
    expect(await svc.listForCaller(ORG, 'srv', [], undefined, access(['f-sales']) as any, 'Sales / Quotes')).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('KgSkillService.proposeFromErrors', () => {
  const ORG = 'org-A';
  const now = new Date('2026-10-19T12:00:00Z');
  const row = (userId: string, status: string, date: string, min: number) => ({
    toolId: 'tool-1',
    userId,
    status,
    input: { date },
    error: status === 'SUCCESS' ? null : 'Invalid date',
    createdAt: new Date(now.getTime() - 3_600_000 + min * 60_000),
  });

  function make(known: Array<{ title: string }> = []) {
    const failures = [row('u1', 'ERROR', '12.10.2026', 0), row('u1', 'ERROR', '13.10.2026', 20)];
    const successes = [row('u1', 'SUCCESS', '2026-10-12', 1), row('u1', 'SUCCESS', '2026-10-13', 21)];
    const prisma: any = {
      toolInvocation: {
        findMany: jest.fn(async ({ where }: any) => (where.status === 'SUCCESS' ? successes : failures)),
      },
      mcpTool: { findMany: jest.fn(async () => [{ id: 'tool-1', name: 'erp_create_order', connectorId: 'c-erp' }]) },
      kgSkillSuggestion: { findMany: jest.fn(async () => known), deleteMany: jest.fn(), create: jest.fn() },
    };
    return { svc: new KgSkillService(prisma, {} as any), prisma };
  }

  it('reads only learnable calls of this workspace and files a pending skill on the connector', async () => {
    const { svc, prisma } = make();
    const res = await svc.proposeFromErrors(ORG, { now });
    expect(res).toEqual({ created: 1, patterns: 1 });
    for (const [q] of prisma.toolInvocation.findMany.mock.calls) {
      expect(q.where).toEqual(expect.objectContaining({ organizationId: ORG, learnable: true }));
    }
    expect(prisma.mcpTool.findMany.mock.calls[0][0].where.connector).toEqual({ organizationId: ORG });
    expect(prisma.kgSkillSuggestion.deleteMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, status: 'pending', source: 'errors' },
    });
    expect(prisma.kgSkillSuggestion.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({
        organizationId: ORG,
        connectorId: 'c-erp',
        title: 'erp_create_order: `date` as "9999-99-99"',
        status: 'pending',
        source: 'errors',
        evidenceCount: 2,
      }),
    );
  });

  it('does not propose again what an admin already applied or dismissed', async () => {
    const { svc, prisma } = make([{ title: 'erp_create_order: `date` as "9999-99-99"' }]);
    expect((await svc.proposeFromErrors(ORG, { now })).created).toBe(0);
    expect(prisma.kgSkillSuggestion.create).not.toHaveBeenCalled();
  });
});

describe('KgSkillService consolidation proposals', () => {
  const ORG = 'org-A';
  const realFetch = global.fetch;
  beforeEach(() => {
    process.env.KG_LLM_BASE_URL = 'http://localhost:11434/v1';
    process.env.KG_LLM_MODEL = 'qwen2.5';
    delete process.env.KG_LLM_API_KEY;
  });
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.KG_LLM_BASE_URL;
    delete process.env.KG_LLM_MODEL;
  });
  const reply = (skills: any[]) =>
    (global.fetch = jest.fn().mockResolvedValue(okJson({ choices: [{ message: { content: JSON.stringify({ skills }) } }] })) as any);

  it('files merged skills as pending proposals that list what they replace, per folder', async () => {
    const current = [
      { id: 'a', title: 'A', whenToUse: '', instruction: 'x', connectorId: 'c1', folderId: 'f1' },
      { id: 'b', title: 'B', whenToUse: '', instruction: 'x', connectorId: 'c1', folderId: 'f1' },
      { id: 'c', title: 'C', whenToUse: '', instruction: 'y', connectorId: 'c1', folderId: null },
    ];
    reply([{ title: 'AB', instruction: 'x', replaces: ['s1', 's2', 's9'] }]);
    const prisma: any = {
      kgSkillSuggestion: { findMany: jest.fn().mockResolvedValue(current), deleteMany: jest.fn(), create: jest.fn() },
    };
    const svc = new KgSkillService(prisma, { isEnabled: async () => true } as any);
    const res = await svc.consolidate(ORG);

    // Only the folder with two skills went to the model.
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
    expect(res).toEqual(expect.objectContaining({ before: 3, after: 2, proposed: 1, replaced: 2 }));
    expect(prisma.kgSkillSuggestion.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({
        title: 'AB',
        status: 'pending',
        source: 'consolidation',
        replaces: ['a', 'b'],
        folderId: 'f1',
        connectorId: 'c1',
      }),
    );
    // Nothing applied was deleted or changed.
    expect(prisma.kgSkillSuggestion.deleteMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, status: 'pending', source: 'consolidation', mcpServerId: null },
    });
  });

  it('applying a proposal dismisses the skills it replaces, in this workspace', async () => {
    const tx: any = { kgSkillSuggestion: { updateMany: jest.fn(), update: jest.fn().mockResolvedValue({ id: 'p' }) } };
    const prisma: any = {
      kgSkillSuggestion: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p', organizationId: ORG, replaces: ['a', 'b'] }),
      },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    await new KgSkillService(prisma, {} as any).apply(ORG, 'p');
    expect(tx.kgSkillSuggestion.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, id: { in: ['a', 'b'] }, status: 'applied' },
      data: { status: 'dismissed' },
    });
    expect(tx.kgSkillSuggestion.update).toHaveBeenCalledWith({ where: { id: 'p' }, data: { status: 'applied' } });
  });
});

describe('KgSkillService review fixes', () => {
  const ORG = 'org-A';

  it('hides the history of a skill in a folder the caller may not see', async () => {
    const prisma: any = {
      kgSkillSuggestion: { findUnique: jest.fn().mockResolvedValue({ id: 's1', organizationId: ORG, folderId: 'f-secret' }) },
      kgSkillVersion: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const svc = new KgSkillService(prisma, {} as any);
    const hidden = { organizationId: ORG, all: false, ids: new Set(['f-other']), folders: [] };
    await expect(svc.versions(ORG, 's1', hidden as any)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.kgSkillVersion.findMany).not.toHaveBeenCalled();
    await expect(svc.versions(ORG, 's1', { ...hidden, all: true } as any)).resolves.toEqual([]);
  });

  it('activating a merge proposal through PATCH also dismisses what it replaces', async () => {
    const tx: any = { kgSkillSuggestion: { updateMany: jest.fn(), update: jest.fn().mockResolvedValue({ id: 'p' }) } };
    const prisma: any = {
      kgSkillSuggestion: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p', organizationId: ORG, status: 'pending', replaces: ['a', 'b'] }),
      },
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    await new KgSkillService(prisma, {} as any).update(ORG, 'p', { status: 'applied' });
    expect(tx.kgSkillSuggestion.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, id: { in: ['a', 'b'] }, status: 'applied' },
      data: { status: 'dismissed' },
    });
  });

  it('keeps the shared guide bounded', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `s${i}`,
      title: `T${i}`,
      whenToUse: '',
      instruction: 'rule',
      body: 'x'.repeat(19_000),
      version: 1,
      folderId: null,
    }));
    const svc = new KgSkillService({ kgSkillSuggestion: { findMany: jest.fn().mockResolvedValue(rows) } } as any, {} as any);
    const text = (await svc.activeSkillsText(ORG, 'srv', [], 'full'))!;
    expect(text.length).toBeLessThan(30_000);
    expect(text).toContain('skill_get "s0"');
  });
});

/** Agent-proposed code tools: inert proposals an admin approves into a tool. */
describe('KgSkillService.proposeCodeTool', () => {
  const ORG = 'org-A';
  const base = {
    connectorId: 'c1',
    usesConnectorIds: ['c1', 'c2'],
    name: 'Sum two tools',
    description: 'Adds the results of tool_a and tool_b',
    code: "const a = await amcp.run('tool_a', {}); return a;",
    rationale: 'Seen three times this week',
    mcpServerId: 'srv',
  };

  it('stores a pending, invoker, read-only code proposal with its payload', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'p1' });
    const svc = new KgSkillService({ kgSkillSuggestion: { create } } as any, {} as any);
    const res = await svc.proposeCodeTool(ORG, base);
    expect(res).toEqual({ id: 'p1' });
    const data = create.mock.calls[0][0].data;
    expect(data).toEqual(
      expect.objectContaining({
        organizationId: ORG,
        connectorId: 'c1',
        mcpServerId: 'srv',
        kind: 'code',
        source: 'agent',
        status: 'pending',
        title: 'Sum two tools',
      }),
    );
    // Payload is the candidate McpTool; authority is locked down at proposal time.
    expect(data.payload.endpointMapping).toEqual(
      expect.objectContaining({ method: 'code', runAs: 'invoker', allowWrites: false }),
    );
    expect(data.payload.endpointMapping.uses).toEqual([{ connectorId: 'c1' }, { connectorId: 'c2' }]);
    expect(data.payload.connectorId).toBe('c1');
    // The program is only in the payload, never in `body` (a servable field).
    expect(data.body).toBeUndefined();
  });

  it('rejects an empty name, empty code, or no connectors', async () => {
    const create = jest.fn();
    const svc = new KgSkillService({ kgSkillSuggestion: { create } } as any, {} as any);
    await expect(svc.proposeCodeTool(ORG, { ...base, name: '  ' })).rejects.toThrow(/name/i);
    await expect(svc.proposeCodeTool(ORG, { ...base, code: '' })).rejects.toThrow(/code/i);
    await expect(svc.proposeCodeTool(ORG, { ...base, usesConnectorIds: [] })).rejects.toThrow(/connector/i);
    expect(create).not.toHaveBeenCalled();
  });

  it('never activates a code proposal through apply()', async () => {
    const update = jest.fn();
    const svc = new KgSkillService(
      {
        kgSkillSuggestion: {
          findUnique: jest.fn().mockResolvedValue({ id: 'p1', organizationId: ORG, kind: 'code' }),
          update,
        },
      } as any,
      {} as any,
    );
    await expect(svc.apply(ORG, 'p1')).rejects.toThrow(/proposal/i);
    expect(update).not.toHaveBeenCalled();
  });
});

/** A code proposal must never be served to a model as a skill. */
describe('KgSkillService code proposals are not served', () => {
  const ORG = 'org-A';
  it('excludes kind="code" from the active-skills query', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const svc = new KgSkillService({ kgSkillSuggestion: { findMany } } as any, {} as any);
    await svc.activeSkillsText(ORG, 'srv', ['c1']);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'applied', kind: { not: 'code' } }),
      }),
    );
  });
});
