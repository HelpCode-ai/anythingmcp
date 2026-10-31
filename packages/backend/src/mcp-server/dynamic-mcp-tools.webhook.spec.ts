import { Logger } from '@nestjs/common';
import { DynamicMcpTools } from './dynamic-mcp-tools';
import type { RegisteredTool } from './tool-registry';

/**
 * The `*_recent_events` builtin is a read of WebhookEventsService, never an
 * engine call — this proves the dispatch wiring in executeWithEngine()
 * actually reaches it with the right connector/org scope, which
 * webhook-events.service.spec.ts (service-level) and
 * webhook-ingest.controller.spec.ts (the HTTP endpoint) do not cover.
 */
function build(webhookEvents: { recentEvents: jest.Mock }) {
  const reject = { execute: jest.fn().mockRejectedValue(new Error('should never reach an engine')) };
  const executor = new DynamicMcpTools(
    { getTool: () => tool, getToolForOrg: () => tool } as any,
    { logInvocation: jest.fn().mockResolvedValue(undefined) } as any,
    { get: jest.fn().mockResolvedValue(null), set: jest.fn() } as any,
    { checkLicenseActive: jest.fn().mockResolvedValue(undefined) } as any,
    { isCloud: () => false } as any,
    {} as any,
    reject as any,
    reject as any,
    reject as any,
    reject as any,
    reject as any,
    { scheduleObservationalIngest: jest.fn() } as any,
    webhookEvents as any,
  );
  return { executor };
}

const tool: RegisteredTool = {
  id: 't1',
  connectorId: 'conn_stripe_1',
  organizationId: 'org-1',
  name: 'stripe_recent_events',
  description: 'x',
  parameters: { type: 'object', properties: { limit: { type: 'integer' }, since: { type: 'string' } } },
  connectorType: 'REST',
  connectorConfig: {
    baseUrl: 'https://api.stripe.com',
    authType: 'BEARER_TOKEN',
    authConfig: JSON.stringify({ token: 'sk_test_x' }),
  } as any,
  endpointMapping: { method: 'webhook_recent_events', path: '' },
};

describe('DynamicMcpTools with the webhook recent-events builtin', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });
  afterAll(() => jest.restoreAllMocks());

  it('reads events scoped to the tool\'s own connectorId and organizationId, never any engine', async () => {
    const events = [{ id: 'e1', provider: 'stripe', eventType: 'payment_intent.succeeded', externalId: 'evt_1', payload: { id: 'evt_1' }, receivedAt: new Date() }];
    const webhookEvents = { recentEvents: jest.fn().mockResolvedValue(events) };
    const { executor } = build(webhookEvents);

    const res = await executor.executeTool('stripe_recent_events', { limit: 5, since: '2026-01-01T00:00:00Z' });

    expect(webhookEvents.recentEvents).toHaveBeenCalledWith('conn_stripe_1', 'org-1', {
      limit: 5,
      since: '2026-01-01T00:00:00Z',
    });
    expect(res.isError).toBeUndefined();
    // Round-tripped through JSON, so receivedAt comes back as an ISO string.
    expect(JSON.parse(res.content[0].text)).toEqual({
      events: events.map((e) => ({ ...e, receivedAt: e.receivedAt.toISOString() })),
    });
  });

  it('never leaks one connector\'s events to a tool call for another connector', async () => {
    const webhookEvents = { recentEvents: jest.fn().mockResolvedValue([]) };
    const { executor } = build(webhookEvents);

    await executor.executeTool('stripe_recent_events', {});

    const [connectorIdArg, organizationIdArg] = webhookEvents.recentEvents.mock.calls[0];
    expect(connectorIdArg).toBe(tool.connectorId);
    expect(organizationIdArg).toBe(tool.organizationId);
  });

  it('works with no params at all (limit/since both optional)', async () => {
    const webhookEvents = { recentEvents: jest.fn().mockResolvedValue([]) };
    const { executor } = build(webhookEvents);

    const res = await executor.executeTool('stripe_recent_events', {});
    expect(res.isError).toBeUndefined();
    expect(webhookEvents.recentEvents).toHaveBeenCalledWith('conn_stripe_1', 'org-1', {
      limit: undefined,
      since: undefined,
    });
  });
});
