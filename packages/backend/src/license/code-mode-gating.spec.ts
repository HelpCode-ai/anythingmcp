import { LicenseGuardService } from './license-guard.service';
import { codeToolCapForPlan, inlineCodeAllowedForPlan, effectiveCodeModePlan } from './code-mode-quotas';
import {
  monthlyCodeRunCapForPlan,
  concurrentCodeRunCapForPlan,
  startOfUtcMonth,
} from './code-run-quotas';

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

  it('promotes a card-backed trial to the team experience, leaves others alone', () => {
    // A trial with a card on file is treated as Team for code mode.
    expect(effectiveCodeModePlan('trial', true)).toBe('team');
    expect(codeToolCapForPlan(effectiveCodeModePlan('trial', true))).toBe(20);
    expect(inlineCodeAllowedForPlan(effectiveCodeModePlan('trial', true))).toBe(true);
    // A free (card-less) trial is unchanged: tools-only, cap 3, no inline.
    expect(effectiveCodeModePlan('trial', false)).toBe('trial');
    expect(codeToolCapForPlan(effectiveCodeModePlan('trial', false))).toBe(3);
    expect(inlineCodeAllowedForPlan(effectiveCodeModePlan('trial', false))).toBe(false);
    // The card flag only lifts a trial, nothing else.
    expect(effectiveCodeModePlan('starter', true)).toBe('starter');
    expect(effectiveCodeModePlan('community', true)).toBe('community');
    expect(effectiveCodeModePlan(null, true)).toBe('community');
  });
});

describe('code-run-quotas', () => {
  it('caps monthly code runs per plan (null = unlimited)', () => {
    expect(monthlyCodeRunCapForPlan('trial')).toBe(100);
    expect(monthlyCodeRunCapForPlan('starter')).toBe(500);
    expect(monthlyCodeRunCapForPlan('team')).toBe(5000);
    expect(monthlyCodeRunCapForPlan('business')).toBe(5000);
    expect(monthlyCodeRunCapForPlan('enterprise')).toBeNull();
    expect(monthlyCodeRunCapForPlan('mystery')).toBeNull(); // unknown -> community (unlimited)
  });

  it('lets features.maxCodeRunsPerMonth override the monthly cap', () => {
    expect(monthlyCodeRunCapForPlan('starter', 2000)).toBe(2000);
    expect(monthlyCodeRunCapForPlan('team', null)).toBeNull();
    expect(monthlyCodeRunCapForPlan('starter', 'nope')).toBe(500); // bad override ignored
    expect(monthlyCodeRunCapForPlan('starter', -1)).toBe(500);
  });

  it('caps concurrency per plan', () => {
    expect(concurrentCodeRunCapForPlan('trial')).toBe(1);
    expect(concurrentCodeRunCapForPlan('starter')).toBe(1);
    expect(concurrentCodeRunCapForPlan('team')).toBe(3);
    expect(concurrentCodeRunCapForPlan('business')).toBe(3);
    expect(concurrentCodeRunCapForPlan('enterprise')).toBe(10);
    expect(concurrentCodeRunCapForPlan('mystery')).toBeNull();
  });

  it('startOfUtcMonth is the first of the month at UTC midnight', () => {
    const d = startOfUtcMonth(new Date('2026-11-17T09:30:00Z'));
    expect(d.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });
});

describe('LicenseGuardService.codeModePlanForOrg', () => {
  it('resolves a card-backed trial to team, a free trial to trial', async () => {
    const cardTrial = { plan: 'trial', status: 'active', billing: { status: 'trialing' } };
    await expect(guard({ cloud: true, license: cardTrial, codeToolCount: 0 }).codeModePlanForOrg('org1')).resolves.toBe('team');
    await expect(guard({ cloud: true, license: { plan: 'trial', status: 'active' }, codeToolCount: 0 }).codeModePlanForOrg('org1')).resolves.toBe('trial');
    await expect(guard({ cloud: true, license: { plan: 'team' }, codeToolCount: 0 }).codeModePlanForOrg('org1')).resolves.toBe('team');
    await expect(guard({ cloud: false, license: null, codeToolCount: 0 }).codeModePlanForOrg('org1')).resolves.toBe('community');
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

  it('is true for a card-backed trial (billing.status trialing), false for a free trial', async () => {
    const cardTrial = { plan: 'trial', status: 'active', billing: { status: 'trialing' } };
    await expect(guard({ cloud: true, license: cardTrial, codeToolCount: 0 }).canUseInlineCode('org1')).resolves.toBe(true);
    // A free trial has no Stripe billing.
    await expect(guard({ cloud: true, license: { plan: 'trial', status: 'active' }, codeToolCount: 0 }).canUseInlineCode('org1')).resolves.toBe(false);
    // A trial whose subscription is not trialing (e.g. past_due) is not a live card trial.
    await expect(
      guard({ cloud: true, license: { plan: 'trial', status: 'active', billing: { status: 'past_due' } }, codeToolCount: 0 }).canUseInlineCode('org1'),
    ).resolves.toBe(false);
  });
});

describe('LicenseGuardService.checkCanCreateCodeTool — card-backed trial cap', () => {
  it('lets a card-backed trial create up to the Team cap (20), not the trial cap (3)', async () => {
    const cardTrial = { plan: 'trial', status: 'active', billing: { status: 'trialing' }, features: {} };
    // 5 tools would already exceed the free-trial cap of 3, but a card trial is Team.
    await expect(guard({ cloud: true, license: cardTrial, codeToolCount: 5 }).checkCanCreateCodeTool('org1')).resolves.toBeUndefined();
    // At the Team cap it blocks, naming the team plan.
    await expect(
      guard({ cloud: true, license: cardTrial, codeToolCount: 20 }).checkCanCreateCodeTool('org1'),
    ).rejects.toThrow(/20 code tools on the team plan/);
  });

  it('a free trial still caps at 3', async () => {
    const freeTrial = { plan: 'trial', status: 'active', features: {} };
    await expect(
      guard({ cloud: true, license: freeTrial, codeToolCount: 3 }).checkCanCreateCodeTool('org1'),
    ).rejects.toThrow(/3 code tools on the trial plan/);
  });
});
