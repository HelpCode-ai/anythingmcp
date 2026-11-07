import { ForbiddenException } from '@nestjs/common';
import { DynamicMcpTools } from './dynamic-mcp-tools';
import type { RegisteredTool } from './tool-registry';
import {
  BLOCKED_CALL_WINDOW_MS,
  BlockedCallThrottle,
  TrialBlockedCallRecorder,
  trialEndedToolResult,
} from './trial-blocked-call';
import { TrialEndedException } from '../license/license-guard.service';
import { trialReactivationUrl } from '../license/license-checkout';

const ENDED = new Date('2026-10-28T09:00:00Z');

function makeTool(adapterSlug?: string): RegisteredTool {
  return {
    id: 'tool-1',
    connectorId: 'conn-1',
    organizationId: 'org-1',
    name: 'etsy_list_listings',
    description: 'List listings',
    parameters: { type: 'object', properties: {} },
    connectorType: 'REST',
    connectorConfig: {
      baseUrl: 'https://api.example.com',
      authType: 'NONE',
      ...(adapterSlug ? { config: { adapterSlug } } : {}),
    },
    endpointMapping: { method: 'GET', path: '/listings' },
  };
}

function makePrisma(opts: { recent?: boolean; clientName?: string | null } = {}) {
  return {
    productEvent: { findFirst: jest.fn().mockResolvedValue(opts.recent ? { id: 'e1' } : null) },
    oAuthClient: {
      findUnique: jest.fn().mockResolvedValue(opts.clientName ? { clientName: opts.clientName } : null),
    },
  };
}

describe('trialReactivationUrl', () => {
  it('links the Cloud dashboard (the ended-trial wall) with the mcp_blocked source, no token', () => {
    const url = trialReactivationUrl({ MARKETING_URL: 'https://site.test/', FRONTEND_URL: 'https://cloud.test/' } as any);
    expect(url).toBe('https://cloud.test/?source=mcp_blocked');
    expect(url).not.toMatch(/token|email/i);
  });

  it('falls back to the public sites', () => {
    expect(trialReactivationUrl({} as any)).toBe('https://cloud.anythingmcp.com/?source=mcp_blocked');
  });
});

describe('trialEndedToolResult', () => {
  it('says when the trial ended, that nothing is lost, and asks the AI to show the link', () => {
    expect(trialEndedToolResult(ENDED, 'https://x.test').error).toContain('subscribe to a plan in the AnythingMCP dashboard');
    const r = trialEndedToolResult(ENDED, 'https://cloud.test/?source=mcp_blocked');
    expect(r.error).toContain('trial ended on 28 October 2026');
    expect(r.error).toContain('connectors and settings are kept');
    expect(r.error).toContain('Show this link to the user: https://cloud.test/?source=mcp_blocked');
    expect(r.error.endsWith('https://cloud.test/?source=mcp_blocked')).toBe(true);
    expect(r.reactivateUrl).toBe('https://cloud.test/?source=mcp_blocked');
  });

  it('still reads well without an end date', () => {
    expect(trialEndedToolResult(null, 'https://x.test').error).toContain('trial has ended.');
  });
});

describe('BlockedCallThrottle', () => {
  it('gives one slot per workspace and tool per hour', () => {
    const t = new BlockedCallThrottle();
    const now = 1_000_000;
    expect(t.take('o1', 'a', now)).toBe(true);
    expect(t.take('o1', 'a', now + 1000)).toBe(false);
    expect(t.take('o1', 'b', now + 1000)).toBe(true);
    expect(t.take('o2', 'a', now + 1000)).toBe(true);
    expect(t.take('o1', 'a', now + BLOCKED_CALL_WINDOW_MS - 1)).toBe(false);
    expect(t.take('o1', 'a', now + BLOCKED_CALL_WINDOW_MS)).toBe(true);
  });

  it('stays bounded: expired entries go first, then the oldest', () => {
    const t = new BlockedCallThrottle(1000, 3);
    t.take('o', 'a', 0);
    t.take('o', 'b', 0);
    t.take('o', 'c', 500);
    t.take('o', 'd', 1200); // a and b expired: pruned
    expect(t.size).toBe(2);
    t.take('o', 'e', 1300);
    t.take('o', 'f', 1300); // full, nothing expired: the oldest (c) goes
    expect(t.size).toBe(3);
    expect(t.take('o', 'c', 1301)).toBe(true);
  });
});

describe('TrialBlockedCallRecorder', () => {
  const input = { organizationId: 'org-1', userId: 'u1', toolName: 'etsy_list_listings', adapterSlug: 'etsy', oauthClientId: 'cl-1' };

  it('logs the event with the tool, the adapter and the client name', async () => {
    const prisma = makePrisma({ clientName: 'Claude' });
    const events = { log: jest.fn().mockResolvedValue(undefined) };
    await new TrialBlockedCallRecorder(prisma as any, events as any).record(input, 5_000_000);
    expect(prisma.productEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          event: 'trial_expired_call_blocked',
          organizationId: 'org-1',
          createdAt: { gte: new Date(5_000_000 - BLOCKED_CALL_WINDOW_MS) },
          metadata: { path: ['toolName'], equals: 'etsy_list_listings' },
        }),
      }),
    );
    expect(events.log).toHaveBeenCalledWith({
      event: 'trial_expired_call_blocked',
      organizationId: 'org-1',
      userId: 'u1',
      metadata: { toolName: 'etsy_list_listings', adapterSlug: 'etsy', client: 'Claude' },
    });
  });

  it('leaves out what it does not know', async () => {
    const prisma = makePrisma();
    const events = { log: jest.fn().mockResolvedValue(undefined) };
    await new TrialBlockedCallRecorder(prisma as any, events as any).record({ organizationId: 'org-1', toolName: 't' });
    expect(prisma.oAuthClient.findUnique).not.toHaveBeenCalled();
    expect(events.log).toHaveBeenCalledWith({
      event: 'trial_expired_call_blocked',
      organizationId: 'org-1',
      userId: null,
      metadata: { toolName: 't' },
    });
  });

  it('writes one row per workspace and tool an hour, from memory and from the table', async () => {
    const prisma = makePrisma();
    const events = { log: jest.fn().mockResolvedValue(undefined) };
    const rec = new TrialBlockedCallRecorder(prisma as any, events as any);
    await rec.record(input, 0);
    await rec.record(input, 60_000);
    await rec.record(input, 120_000);
    expect(events.log).toHaveBeenCalledTimes(1);
    expect(prisma.productEvent.findFirst).toHaveBeenCalledTimes(1);

    // Another process (or a restart) already wrote one in the hour: nothing new.
    const seen = makePrisma({ recent: true });
    const events2 = { log: jest.fn() };
    await new TrialBlockedCallRecorder(seen as any, events2 as any).record(input);
    expect(events2.log).not.toHaveBeenCalled();
  });

  it('never throws', async () => {
    const prisma = { productEvent: { findFirst: jest.fn().mockRejectedValue(new Error('db down')) } };
    const events = { log: jest.fn() };
    await expect(new TrialBlockedCallRecorder(prisma as any, events as any).record(input)).resolves.toBeUndefined();
    expect(events.log).not.toHaveBeenCalled();
  });
});

describe('DynamicMcpTools — a call refused by the licence check', () => {
  function build(refusal: Error, opts: { tool?: RegisteredTool | undefined; events?: any; prisma?: any } = {}) {
    const tool = 'tool' in opts ? opts.tool : makeTool('etsy');
    const restEngine = { execute: jest.fn() };
    const events = opts.events ?? { log: jest.fn().mockResolvedValue(undefined) };
    const prisma = opts.prisma ?? makePrisma({ clientName: 'Claude' });
    const executor = new DynamicMcpTools(
      { getTool: () => tool, getToolForOrg: () => tool } as any,
      { logInvocation: jest.fn() } as any,
      { get: jest.fn(), set: jest.fn() } as any,
      { checkLicenseActive: jest.fn().mockRejectedValue(refusal) } as any,
      { isCloud: () => true } as any,
      prisma as any,
      restEngine as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { scheduleObservationalIngest: jest.fn() } as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      undefined,
      events as any,
    );
    return { executor, restEngine, events, prisma };
  }
  const ctx = { organizationId: 'org-1', userId: 'u1', oauthClientId: 'cl-1' };
  const flush = () => new Promise((r) => setImmediate(r));

  it('gives an ended trial the reactivation link and records the blocked call', async () => {
    const { executor, restEngine, events } = build(new TrialEndedException(ENDED));
    const res = await executor.executeTool('etsy_list_listings', {}, ctx);
    expect(res.isError).toBe(true);
    const body = JSON.parse(res.content[0].text);
    expect(body.error).toContain('trial ended on 28 October 2026');
    expect(body.error).toContain('Show this link to the user: ');
    expect(body.reactivateUrl).toMatch(/\/\?source=mcp_blocked$/);
    expect(body.reactivateUrl).not.toContain('/pricing');
    expect(restEngine.execute).not.toHaveBeenCalled();
    await flush();
    expect(events.log).toHaveBeenCalledWith({
      event: 'trial_expired_call_blocked',
      organizationId: 'org-1',
      userId: 'u1',
      metadata: { toolName: 'etsy_list_listings', adapterSlug: 'etsy', client: 'Claude' },
    });
  });

  it('answers without waiting for the event, and a failing event changes nothing', async () => {
    let release!: () => void;
    const slow = {
      productEvent: { findFirst: jest.fn(() => new Promise((r) => (release = () => r(null)))) },
      oAuthClient: { findUnique: jest.fn().mockRejectedValue(new Error('db down')) },
    };
    const { executor } = build(new TrialEndedException(ENDED), { prisma: slow });
    const res = await executor.executeTool('etsy_list_listings', {}, ctx);
    expect(JSON.parse(res.content[0].text).reactivateUrl).toBeDefined();
    release();
    await flush();
  });

  it('records nothing for a tool the caller cannot reach', async () => {
    const { executor, events } = build(new TrialEndedException(ENDED), { tool: undefined });
    const res = await executor.executeTool('nope', {}, ctx);
    expect(JSON.parse(res.content[0].text).reactivateUrl).toBeDefined();
    await flush();
    expect(events.log).not.toHaveBeenCalled();
  });

  it.each([
    ['a workspace without a licence', 'This workspace has no active license. Ask a workspace administrator to activate one.'],
    ['an expired paid licence', "This workspace's license has expired. Ask a workspace administrator to renew it."],
  ])('keeps the plain message, with no link and no event, for %s', async (_case, message) => {
    const { executor, events } = build(new ForbiddenException(message));
    const res = await executor.executeTool('etsy_list_listings', {}, ctx);
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text)).toEqual({ error: message });
    expect(res.content[0].text).not.toContain('pricing');
    await flush();
    expect(events.log).not.toHaveBeenCalled();
  });
});
