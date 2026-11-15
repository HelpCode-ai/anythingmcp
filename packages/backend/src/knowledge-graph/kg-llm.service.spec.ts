import { KgLlmService } from './kg-llm.service';

const ORG = 'org-A';

function setKgEnv() {
  process.env.KG_LLM_ENABLED = 'true';
  process.env.KG_LLM_BASE_URL = 'http://localhost:11434/v1';
  process.env.KG_LLM_MODEL = 'qwen2.5';
  delete process.env.KG_LLM_API_KEY;
}

function clearKgEnv() {
  delete process.env.KG_LLM_ENABLED;
  delete process.env.KG_LLM_BASE_URL;
  delete process.env.KG_LLM_MODEL;
}

function okJson(body: any) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
}

function make(prisma: any) {
  const kgStatic = { isEnabled: async () => true, getFlag: async () => true };
  return new KgLlmService(prisma, kgStatic as any);
}

function nodes() {
  return [0, 1].map((i) => ({
    id: `n${i}`,
    entity: `ent${i}`,
    fields: [{ name: 'email' }],
    outputFields: [],
    connector: { name: 'crm' },
  }));
}

/** Unusable custom reply must not store the hash (test 1 for #816 review). */
describe('KgLlmService.enrich custom skip', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    setKgEnv();
    global.fetch = jest.fn();
  });
  afterEach(() => {
    global.fetch = realFetch;
    clearKgEnv();
    jest.restoreAllMocks();
  });

  it('does not update kg_llm_hash on an unusable reply and stays retryable', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      okJson({ choices: [{ message: { content: 'Sure, here are some thoughts...' } }] }),
    );
    const prisma = {
      kgNode: { findMany: jest.fn().mockResolvedValue(nodes()) },
      orgSettings: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
    };
    const res = await make(prisma).enrich(ORG);
    expect(res).toEqual({ suggested: 0, skipped: true, model: 'qwen2.5' });
    expect(prisma.orgSettings.upsert).not.toHaveBeenCalled();

    // Retry with a usable reply stores the hash normally.
    (global.fetch as jest.Mock).mockResolvedValue(
      okJson({ choices: [{ message: { content: '{"relationships":[]}' } }] }),
    );
    const retry = await make(prisma).enrich(ORG);
    expect(retry.suggested).toBe(0);
    expect(retry.skipped).toBeUndefined();
    expect(prisma.orgSettings.upsert).toHaveBeenCalledTimes(1);
  });
});

/** The dashboard offers the scheduled switch only where the job can run. */
describe('KgLlmService.scheduledAvailable', () => {
  afterEach(() => {
    clearKgEnv();
    delete process.env.KG_LLM_CRON_ENABLED;
  });

  it('needs the AI features and the scheduled job turned on', () => {
    const svc = make({});
    setKgEnv();
    expect(svc.scheduledAvailable()).toBe(false);
    process.env.KG_LLM_CRON_ENABLED = 'true';
    expect(svc.scheduledAvailable()).toBe(true);
    clearKgEnv();
    expect(svc.scheduledAvailable()).toBe(false);
  });
});
