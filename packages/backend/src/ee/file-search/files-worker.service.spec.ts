// Licensed under the AnythingMCP Commercial License, see packages/backend/src/ee/LICENSE.
import { FilesWorkerService } from './files-worker.service';

describe('FilesWorkerService.closeInterruptedRuns', () => {
  const make = (executeRaw: jest.Mock) => new FilesWorkerService({ $executeRaw: executeRaw } as any, {} as any, {} as any, {} as any);

  it('marks running runs without a live lease as partial', async () => {
    const executeRaw = jest.fn().mockResolvedValue(2);
    await expect(make(executeRaw).closeInterruptedRuns()).resolves.toBe(2);
    const sql = (executeRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(sql).toContain("SET status = 'partial'");
    expect(sql).toContain("r.status = 'running'");
    expect(sql).toContain('lease_until > now()');
  });

  it('never throws, so the worker still starts', async () => {
    const executeRaw = jest.fn().mockRejectedValue(new Error('db down'));
    await expect(make(executeRaw).closeInterruptedRuns()).resolves.toBe(0);
  });
});
