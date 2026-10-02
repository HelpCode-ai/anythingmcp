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
