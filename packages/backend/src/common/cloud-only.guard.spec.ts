import { NotFoundException } from '@nestjs/common';
import { CloudOnlyGuard } from './cloud-only.guard';

describe('CloudOnlyGuard', () => {
  it('lets the request through in cloud', () => {
    const guard = new CloudOnlyGuard({ isCloud: () => true } as any);
    expect(guard.canActivate({} as any)).toBe(true);
  });

  it('answers 404 on a self-hosted instance', () => {
    const guard = new CloudOnlyGuard({ isCloud: () => false } as any);
    expect(() => guard.canActivate({} as any)).toThrow(NotFoundException);
  });
});
