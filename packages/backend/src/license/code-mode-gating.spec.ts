import { LicenseGuardService } from './license-guard.service';
import { codeToolCapForPlan, inlineCodeAllowedForPlan } from './code-mode-quotas';

function guard({ cloud, license, codeToolCount }: { cloud: boolean; license: any; codeToolCount: number }) {
  const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ count: codeToolCount }]) };
  const licenseService = {
    getCurrentLicense: jest.fn().mockResolvedValue(license),
    getLatestInactiveLicense: jest.fn().mockResolvedValue(null),
  };
  const deployment = { isCloud: () => cloud };
  return new LicenseGuardService(prisma as any, licenseService as any, deployment as any);
}

describe('code-mode-quotas', () => {
  it('caps saved code tools per plan (null = unlimited)', () => {
    expect(codeToolCapForPlan('community')).toBe(3);
    expect(codeToolCapForPlan('trial')).toBe(3);
    expect(codeToolCapForPlan('starter')).toBe(5);
    expect(codeToolCapForPlan('team')).toBe(20);
    expect(codeToolCapForPlan('business')).toBe(20);
    expect(codeToolCapForPlan('enterprise')).toBeNull();
  });

  it('treats an unknown or missing plan as community', () => {
    expect(codeToolCapForPlan(null)).toBe(3);
    expect(codeToolCapForPlan(undefined)).toBe(3);
    expect(codeToolCapForPlan('mystery')).toBe(3);
  });

  it('lets features.maxCodeTools override the plan cap', () => {
    expect(codeToolCapForPlan('starter', 10)).toBe(10);
    expect(codeToolCapForPlan('team', null)).toBeNull();
    expect(codeToolCapForPlan('community', 0)).toBe(0);
    // A bad override is ignored and the plan cap stands.
    expect(codeToolCapForPlan('starter', 'nope')).toBe(5);
    expect(codeToolCapForPlan('starter', -1)).toBe(5);
  });

  it('allows inline code on Team and above only', () => {
    expect(inlineCodeAllowedForPlan('team')).toBe(true);
    expect(inlineCodeAllowedForPlan('business')).toBe(true);
    expect(inlineCodeAllowedForPlan('enterprise')).toBe(true);
    expect(inlineCodeAllowedForPlan('starter')).toBe(false);
    expect(inlineCodeAllowedForPlan('trial')).toBe(false);
    expect(inlineCodeAllowedForPlan('community')).toBe(false);
    expect(inlineCodeAllowedForPlan(null)).toBe(false);
  });
});

describe('LicenseGuardService.checkCanCreateCodeTool (per-plan cap, Cloud + self-hosted)', () => {
  it('self-hosted community blocks the 4th code tool', async () => {
    const g = guard({ cloud: false, license: { plan: 'community', features: {} }, codeToolCount: 3 });
    await expect(g.checkCanCreateCodeTool('org1')).rejects.toThrow(/Plan limit reached \(3 code tools on the community plan\)/);
  });

  it('self-hosted community allows under the cap', async () => {
    const g = guard({ cloud: false, license: { plan: 'community', features: {} }, codeToolCount: 2 });
    await expect(g.checkCanCreateCodeTool('org1')).resolves.toBeUndefined();
  });

  it('self-hosted with no licence is treated as community', async () => {
    const g = guard({ cloud: false, license: null, codeToolCount: 3 });
    await expect(g.checkCanCreateCodeTool('org1')).rejects.toThrow(/community plan/);
  });

  it('enterprise is unlimited', async () => {
    const g = guard({ cloud: false, license: { plan: 'enterprise', features: {} }, codeToolCount: 999 });
    await expect(g.checkCanCreateCodeTool('org1')).resolves.toBeUndefined();
  });

  it('a Team self-hosted key caps at 20', async () => {
    const g = guard({ cloud: false, license: { plan: 'team', features: {} }, codeToolCount: 20 });
    await expect(g.checkCanCreateCodeTool('org1')).rejects.toThrow(/20 code tools on the team plan/);
  });

  it('an Enterprise maxCodeTools override wins over the plan cap', async () => {
    const g = guard({ cloud: false, license: { plan: 'starter', features: { maxCodeTools: 10 } }, codeToolCount: 6 });
    await expect(g.checkCanCreateCodeTool('org1')).resolves.toBeUndefined();
  });

  it('without an organization there is nothing to count against', async () => {
    const g = guard({ cloud: false, license: { plan: 'community', features: {} }, codeToolCount: 99 });
    await expect(g.checkCanCreateCodeTool(undefined)).resolves.toBeUndefined();
  });
});

describe('LicenseGuardService.canUseInlineCode', () => {
  it('is true for Team and above', async () => {
    await expect(guard({ cloud: true, license: { plan: 'team' }, codeToolCount: 0 }).canUseInlineCode('org1')).resolves.toBe(true);
    await expect(guard({ cloud: false, license: { plan: 'enterprise' }, codeToolCount: 0 }).canUseInlineCode('org1')).resolves.toBe(true);
  });

  it('is false for Starter, Community and no licence', async () => {
    await expect(guard({ cloud: true, license: { plan: 'starter' }, codeToolCount: 0 }).canUseInlineCode('org1')).resolves.toBe(false);
    await expect(guard({ cloud: false, license: { plan: 'community' }, codeToolCount: 0 }).canUseInlineCode('org1')).resolves.toBe(false);
    await expect(guard({ cloud: false, license: null, codeToolCount: 0 }).canUseInlineCode('org1')).resolves.toBe(false);
  });
});
