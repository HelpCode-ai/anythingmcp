import { createHmac } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { WebhookIngestController } from './webhook-ingest.controller';

const SECRET = 'whsec_test_secret_for_controller_spec';
const CONNECTOR_ID = 'conn_1';

function stripeHeader(body: string, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

function fakeConnector(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTOR_ID,
    organizationId: 'org1',
    isActive: true,
    webhookEnabled: true,
    webhookProvider: 'stripe',
    webhookSecret: 'encrypted:does-not-matter-decrypt-is-mocked',
    ...overrides,
  };
}

function makeReq(raw: Buffer | undefined) {
  return { rawBody: raw } as any;
}

describe('WebhookIngestController', () => {
  let connectors: { findByIdInternal: jest.Mock; decryptWebhookSecret: jest.Mock };
  let webhookEvents: { recordEvent: jest.Mock };
  let controller: WebhookIngestController;

  beforeEach(() => {
    connectors = {
      findByIdInternal: jest.fn().mockResolvedValue(fakeConnector()),
      decryptWebhookSecret: jest.fn().mockReturnValue(SECRET),
    };
    webhookEvents = { recordEvent: jest.fn().mockResolvedValue(true) };
    controller = new WebhookIngestController(connectors as any, webhookEvents as any);
  });

  it('accepts a valid Stripe delivery, records it, and answers ok', async () => {
    const body = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });
    const raw = Buffer.from(body);
    const res = await controller.receive(CONNECTOR_ID, makeReq(raw), stripeHeader(body));
    expect(res).toEqual({ ok: true });
    expect(webhookEvents.recordEvent).toHaveBeenCalledWith({
      connectorId: CONNECTOR_ID,
      organizationId: 'org1',
      provider: 'stripe',
      eventType: 'payment_intent.succeeded',
      externalId: 'evt_1',
      payload: { id: 'evt_1', type: 'payment_intent.succeeded' },
    });
  });

  it('rejects an unknown connector id', async () => {
    connectors.findByIdInternal.mockRejectedValue(new Error('not found'));
    const body = JSON.stringify({ id: 'evt_1' });
    await expect(
      controller.receive('does_not_exist', makeReq(Buffer.from(body)), stripeHeader(body)),
    ).rejects.toThrow(UnauthorizedException);
    expect(webhookEvents.recordEvent).not.toHaveBeenCalled();
  });

  it('rejects a disabled connector with the same error as an unknown one', async () => {
    connectors.findByIdInternal.mockResolvedValue(fakeConnector({ isActive: false }));
    const body = JSON.stringify({ id: 'evt_1' });
    await expect(
      controller.receive(CONNECTOR_ID, makeReq(Buffer.from(body)), stripeHeader(body)),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a connector with webhooks not enabled', async () => {
    connectors.findByIdInternal.mockResolvedValue(fakeConnector({ webhookEnabled: false }));
    const body = JSON.stringify({ id: 'evt_1' });
    await expect(
      controller.receive(CONNECTOR_ID, makeReq(Buffer.from(body)), stripeHeader(body)),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a connector whose provider is not stripe', async () => {
    connectors.findByIdInternal.mockResolvedValue(fakeConnector({ webhookProvider: 'other' }));
    const body = JSON.stringify({ id: 'evt_1' });
    await expect(
      controller.receive(CONNECTOR_ID, makeReq(Buffer.from(body)), stripeHeader(body)),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a bad signature', async () => {
    const body = JSON.stringify({ id: 'evt_1' });
    await expect(
      controller.receive(CONNECTOR_ID, makeReq(Buffer.from(body)), stripeHeader(body, 'wrong_secret')),
    ).rejects.toThrow(UnauthorizedException);
    expect(webhookEvents.recordEvent).not.toHaveBeenCalled();
  });

  it('rejects a missing raw body', async () => {
    await expect(
      controller.receive(CONNECTOR_ID, makeReq(undefined), 't=1,v1=abc'),
    ).rejects.toThrow(UnauthorizedException);
    expect(connectors.findByIdInternal).not.toHaveBeenCalled();
  });

  it('rejects a body over the size cap before touching the signature or the connector lookup', async () => {
    const raw = Buffer.alloc(257 * 1024, 'x');
    await expect(
      controller.receive(CONNECTOR_ID, makeReq(raw), 't=1,v1=abc'),
    ).rejects.toThrow(UnauthorizedException);
    expect(connectors.findByIdInternal).not.toHaveBeenCalled();
  });

  it('still answers ok on a duplicate (redelivered) event, without erroring', async () => {
    webhookEvents.recordEvent.mockResolvedValue(false);
    const body = JSON.stringify({ id: 'evt_1' });
    const res = await controller.receive(CONNECTOR_ID, makeReq(Buffer.from(body)), stripeHeader(body));
    expect(res).toEqual({ ok: true });
  });

  it('stores an empty payload rather than throwing when the body is not valid JSON', async () => {
    const body = 'not json';
    const res = await controller.receive(CONNECTOR_ID, makeReq(Buffer.from(body)), stripeHeader(body));
    expect(res).toEqual({ ok: true });
    expect(webhookEvents.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ payload: {}, eventType: undefined, externalId: undefined }),
    );
  });
});
