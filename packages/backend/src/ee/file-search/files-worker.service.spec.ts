// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import { FilesWorkerService } from './files-worker.service';

describe('FilesWorkerService.closeInterruptedRuns', () => {
  const make = (executeRaw: jest.Mock, tenants: string[] | Error = ['org-a', 'org-b']) => {
    const orgs: string[] = [];
    const repo: any = {
      tenantsWithFileSearch: jest.fn(async () => {
        if (tenants instanceof Error) throw tenants;
        return tenants;
      }),
      withTenant: jest.fn(async (org: string, fn: any) => (orgs.push(org), fn({ $executeRaw: executeRaw }))),
    };
    const prisma: any = { $executeRaw: jest.fn(async () => { throw new Error('query outside withTenant'); }) };
    return { svc: new FilesWorkerService(prisma, repo, {} as any, {} as any), orgs, prisma };
  };

  it('marks running runs without a live lease as partial, one workspace at a time', async () => {
    const executeRaw = jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    const { svc, orgs, prisma } = make(executeRaw);
    await expect(svc.closeInterruptedRuns()).resolves.toBe(3);
    expect(orgs).toEqual(['org-a', 'org-b']);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    const sql = (executeRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(sql).toContain("SET status = 'partial'");
    expect(sql).toContain("r.status = 'running'");
    expect(sql).toContain('lease_until > now()');
    expect(sql).toContain('r.organization_id = ?');
    expect(executeRaw.mock.calls[0].slice(1)).toEqual(['org-a', 'org-a']);
    expect(executeRaw.mock.calls[1].slice(1)).toEqual(['org-b', 'org-b']);
  });

  it('never throws, so the worker still starts', async () => {
    const executeRaw = jest.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(1);
    await expect(make(executeRaw).svc.closeInterruptedRuns()).resolves.toBe(1);
    await expect(make(jest.fn(), new Error('db down')).svc.closeInterruptedRuns()).resolves.toBe(0);
  });
});

describe('FilesWorkerService.logDatabaseMode', () => {
  const make = (v: any) => {
    const svc = new FilesWorkerService({} as any, { visibility: jest.fn(async () => v) } as any, {} as any, {} as any);
    const logger = (svc as any).logger;
    const log = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    return { svc, log, warn };
  };

  it('names the mode and warns when folders exist but no source is visible', async () => {
    const { svc, log, warn } = make({ mode: 'rls', connectors: 2, visibleSources: 0 });
    await svc.logDatabaseMode();
    expect(log.mock.calls[0][0]).toMatch(/subject to Row-Level Security/);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/no file_sources row is visible/);
  });

  it('stays quiet when the sources are visible', async () => {
    const { svc, log, warn } = make({ mode: 'amcp_files', connectors: 2, visibleSources: 2 });
    await svc.logDatabaseMode();
    expect(log.mock.calls[0][0]).toMatch(/role amcp_files/);
    expect(warn).not.toHaveBeenCalled();
  });
});
