import { NotFoundException } from '@nestjs/common';
import { KgLearningService, effectiveLearning, memberContributes } from './kg-learning.service';

const ORG = 'org-A';

describe('effectiveLearning', () => {
  it.each([
    // mode, optOut, workspaceDefault, expected
    ['inherit', false, true, true],
    ['inherit', false, false, false],
    ['on', false, false, true],
    ['off', false, true, false],
    ['on', true, true, false],
    ['inherit', true, true, false],
    ['garbage', false, true, true],
  ])('%s / optOut=%s / default=%s → %s', (mode, optOut, def, expected) => {
    expect(effectiveLearning(mode as string, optOut as boolean, def as boolean)).toBe(expected);
  });
});

describe('memberContributes', () => {
  function deps(member: unknown, workspaceDefault = true) {
    const prisma = {
      organizationMember: { findUnique: jest.fn().mockResolvedValue(member) },
    };
    const staticSvc = { getFlag: jest.fn().mockResolvedValue(workspaceDefault) };
    return { prisma, staticSvc };
  }

  it('is false without a user (static instance credentials)', async () => {
    const { prisma, staticSvc } = deps({ learningMode: 'on', learningOptOut: false, deactivatedAt: null });
    expect(await memberContributes(prisma as any, staticSvc as any, ORG, undefined)).toBe(false);
    expect(prisma.organizationMember.findUnique).not.toHaveBeenCalled();
  });

  it('is false for a caller who is not a member of the workspace', async () => {
    const { prisma, staticSvc } = deps(null);
    expect(await memberContributes(prisma as any, staticSvc as any, ORG, 'client:abc')).toBe(false);
  });

  it('is false for a deactivated member', async () => {
    const { prisma, staticSvc } = deps({
      learningMode: 'on',
      learningOptOut: false,
      deactivatedAt: new Date(),
    });
    expect(await memberContributes(prisma as any, staticSvc as any, ORG, 'u1')).toBe(false);
  });

  it('follows the workspace switch for inherit and looks the member up in this workspace', async () => {
    const { prisma, staticSvc } = deps({ learningMode: 'inherit', learningOptOut: false, deactivatedAt: null });
    expect(await memberContributes(prisma as any, staticSvc as any, ORG, 'u1')).toBe(true);
    expect(prisma.organizationMember.findUnique.mock.calls[0][0].where).toEqual({
      userId_organizationId: { userId: 'u1', organizationId: ORG },
    });
    expect(staticSvc.getFlag).toHaveBeenCalledWith(ORG, 'kg_capture_intent', false);
  });

  it('honours an admin off even when the workspace switch is on', async () => {
    const { prisma, staticSvc } = deps({ learningMode: 'off', learningOptOut: false, deactivatedAt: null });
    expect(await memberContributes(prisma as any, staticSvc as any, ORG, 'u1')).toBe(false);
  });
});

describe('KgLearningService', () => {
  const ctx = { actorUserId: 'admin', ip: '1.2.3.4', userAgent: 'jest' };

  function make(members: Array<{ userId: string; learningMode: string; learningOptOut: boolean }>, workspaceDefault = false) {
    const prisma = {
      organizationMember: {
        findMany: jest.fn(async ({ where }: any) =>
          members.filter((m) => where.userId.in.includes(m.userId)),
        ),
        findUnique: jest.fn(async ({ where }: any) =>
          members.find((m) => m.userId === where.userId_organizationId.userId) ?? null,
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn().mockResolvedValue({}),
      },
      toolInvocation: { updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
    };
    const staticSvc = { getFlag: jest.fn().mockResolvedValue(workspaceDefault) };
    const securityEvents = { log: jest.fn().mockResolvedValue(undefined) };
    const svc = new KgLearningService(prisma as any, staticSvc as any, securityEvents as any);
    return { svc, prisma, securityEvents };
  }

  it('sets the mode of members of this workspace only and logs one event per changed member', async () => {
    const { svc, prisma, securityEvents } = make([
      { userId: 'u1', learningMode: 'inherit', learningOptOut: false },
      { userId: 'u2', learningMode: 'on', learningOptOut: false },
    ]);
    const res = await svc.setMode(ORG, ['u1', 'u2', 'stranger'], 'on', ctx);

    expect(res).toEqual({ updated: 1, notFound: ['stranger'], intentsCleared: 0 });
    expect(prisma.organizationMember.findMany.mock.calls[0][0].where.organizationId).toBe(ORG);
    expect(prisma.organizationMember.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, userId: { in: ['u1'] } },
      data: { learningMode: 'on' },
    });
    expect(securityEvents.log).toHaveBeenCalledTimes(1);
    expect(securityEvents.log.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        event: 'LEARNING_CHANGED',
        organizationId: ORG,
        actorUserId: 'admin',
        targetUserId: 'u1',
        metadata: { from: 'inherit', to: 'on', via: 'admin' },
      }),
    );
  });

  it('clears captured intents only for members whose learning ends up off, in this workspace', async () => {
    const { svc, prisma } = make([
      { userId: 'u1', learningMode: 'on', learningOptOut: false },
      { userId: 'u2', learningMode: 'on', learningOptOut: false },
    ]);
    const res = await svc.setMode(ORG, ['u1', 'u2'], 'off', ctx, { clearIntents: true });

    expect(res.intentsCleared).toBe(3);
    expect(prisma.toolInvocation.updateMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        userId: { in: ['u1', 'u2'] },
        OR: [{ intent: { not: null } }, { learnable: true }],
      },
      data: { intent: null, learnable: false },
    });
  });

  it('does not clear intents when the members stay on', async () => {
    const { svc, prisma } = make([{ userId: 'u1', learningMode: 'off', learningOptOut: false }]);
    await svc.setMode(ORG, ['u1'], 'on', ctx, { clearIntents: true });
    expect(prisma.toolInvocation.updateMany).not.toHaveBeenCalled();
  });

  it('lets a member opt out, but opting back in only restores the admin setting', async () => {
    const members = [{ userId: 'u1', learningMode: 'off', learningOptOut: true }];
    const { svc, prisma } = make(members, true);
    const res = await svc.setOptOut(ORG, 'u1', false, { actorUserId: 'u1' });
    expect(prisma.organizationMember.update).toHaveBeenCalledWith({
      where: { userId_organizationId: { userId: 'u1', organizationId: ORG } },
      data: { learningOptOut: false },
    });
    // The mock row is not mutated, but the admin's "off" decides either way.
    expect(res.effective).toBe(false);
  });

  it('erases the member\'s own intents when opting out with clearIntents', async () => {
    const { svc, prisma } = make([{ userId: 'u1', learningMode: 'on', learningOptOut: false }]);
    const res = await svc.setOptOut(ORG, 'u1', true, { actorUserId: 'u1' }, { clearIntents: true });
    expect(res.intentsCleared).toBe(3);
    expect(prisma.toolInvocation.updateMany.mock.calls[0][0].where).toEqual({
      organizationId: ORG,
      userId: { in: ['u1'] },
      OR: [{ intent: { not: null } }, { learnable: true }],
    });
  });

  it('refuses a user who is not a member of the workspace', async () => {
    const { svc } = make([]);
    await expect(svc.getForMember(ORG, 'nobody')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.setOptOut(ORG, 'nobody', true, { actorUserId: 'nobody' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
