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
