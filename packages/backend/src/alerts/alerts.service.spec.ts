import { BadRequestException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { AlertsService } from './alerts.service';
import { outboundRequest } from '../common/outbound-http';

jest.mock('../common/outbound-http', () => ({
  outboundRequest: jest.fn(),
}));

const mockedOutboundRequest = outboundRequest as jest.Mock;

const ENCRYPTION_KEY = 'a'.repeat(48);

function makeOrgSettings() {
  const store = new Map<string, string>();
  return {
    async get(organizationId: string, key: string) {
      return store.get(`${organizationId}:${key}`) ?? null;
    },
    async getJson(organizationId: string, key: string) {
      const raw = store.get(`${organizationId}:${key}`);
      return raw ? JSON.parse(raw) : null;
    },
    async set(organizationId: string, key: string, value: string) {
      store.set(`${organizationId}:${key}`, value);
    },
    async setJson(organizationId: string, key: string, value: unknown) {
      store.set(`${organizationId}:${key}`, JSON.stringify(value));
    },
    async delete(organizationId: string, key: string) {
      store.delete(`${organizationId}:${key}`);
    },
  };
}

function makePrisma() {
  return {
    connector: { findFirst: jest.fn().mockResolvedValue({ id: 'conn1', name: 'SAP' }) },
    mcpTool: { findUnique: jest.fn().mockResolvedValue({ name: 'get_orders' }) },
  };
}

/** isConnected: false exercises the in-memory fallback path used throughout these tests. */
function makeDisconnectedRedis() {
  return {
    isConnected: false,
    incr: jest.fn(),
    expire: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    ttl: jest.fn(),
  };
}

function makeConfigService(cloud = false) {
  return {
    get: (key: string) =>
      key === 'ENCRYPTION_KEY'
        ? ENCRYPTION_KEY
        : key === 'FRONTEND_URL'
          ? 'https://app.test'
          : key === 'DEPLOYMENT_MODE'
            ? (cloud ? 'cloud' : 'self-hosted')
            : undefined,
  };
}

function buildService(overrides: { prisma?: any; orgSettings?: any; redis?: any; cloud?: boolean } = {}) {
  const prisma = overrides.prisma ?? makePrisma();
  const orgSettings = overrides.orgSettings ?? makeOrgSettings();
  const redis = overrides.redis ?? makeDisconnectedRedis();
  const service = new AlertsService(prisma as any, orgSettings as any, redis as any, makeConfigService(overrides.cloud) as any);
  return { service, prisma, orgSettings, redis };
}

describe('AlertsService', () => {
  beforeEach(() => {
    mockedOutboundRequest.mockReset();
    mockedOutboundRequest.mockResolvedValue({ status: 200 });
  });

  it('dispatches exactly once at the failure threshold, then the cooldown suppresses the next', async () => {
    const { service } = buildService();
    await service.saveConfig('org1', {
      url: 'https://hooks.example.com/x',
      type: 'json',
      threshold: 3,
      windowMinutes: 10,
      cooldownMinutes: 30,
    });

    await service.recordFailure({ organizationId: 'org1', connectorId: 'conn1', toolId: 'tool1', error: 'boom' });
    await service.recordFailure({ organizationId: 'org1', connectorId: 'conn1', toolId: 'tool1', error: 'boom' });
    expect(mockedOutboundRequest).not.toHaveBeenCalled();

    await service.recordFailure({ organizationId: 'org1', connectorId: 'conn1', toolId: 'tool1', error: 'boom' });
    expect(mockedOutboundRequest).toHaveBeenCalledTimes(1);

    // Past the threshold, still within the cooldown: no second dispatch.
    await service.recordFailure({ organizationId: 'org1', connectorId: 'conn1', toolId: 'tool1', error: 'boom' });
    await service.recordFailure({ organizationId: 'org1', connectorId: 'conn1', toolId: 'tool1', error: 'boom' });
    expect(mockedOutboundRequest).toHaveBeenCalledTimes(1);
  });

  it('keeps per-organization counters isolated even for the same connectorId', async () => {
    const { service } = buildService();
    await service.saveConfig('org1', { url: 'https://hooks.example.com/a', type: 'json', threshold: 2 });
    await service.saveConfig('org2', { url: 'https://hooks.example.com/b', type: 'json', threshold: 2 });

    await service.recordFailure({ organizationId: 'org1', connectorId: 'conn1', toolId: 't', error: 'e' });
    await service.recordFailure({ organizationId: 'org2', connectorId: 'conn1', toolId: 't', error: 'e' });
    expect(mockedOutboundRequest).not.toHaveBeenCalled();

    await service.recordFailure({ organizationId: 'org1', connectorId: 'conn1', toolId: 't', error: 'e' });
    expect(mockedOutboundRequest).toHaveBeenCalledTimes(1);

    await service.recordFailure({ organizationId: 'org2', connectorId: 'conn1', toolId: 't', error: 'e' });
    expect(mockedOutboundRequest).toHaveBeenCalledTimes(2);
  });

  it('never throws out of recordFailure when dispatch fails', async () => {
    const { service } = buildService();
    await service.saveConfig('org1', { url: 'https://hooks.example.com/x', type: 'json', threshold: 1 });
    mockedOutboundRequest.mockRejectedValue(new Error('network down'));

    await expect(
      service.recordFailure({ organizationId: 'org1', connectorId: 'conn1', toolId: 't', error: 'e' }),
    ).resolves.toBeUndefined();
  });

  it('never throws out of recordFailure when reading the config itself fails', async () => {
    const orgSettings = { getJson: jest.fn().mockRejectedValue(new Error('db down')) };
    const { service } = buildService({ orgSettings });

    await expect(
      service.recordFailure({ organizationId: 'org1', connectorId: 'conn1', toolId: 't', error: 'e' }),
    ).resolves.toBeUndefined();
  });

  it('does nothing when no webhook is configured for the organization', async () => {
    const { service } = buildService();
    await service.recordFailure({ organizationId: 'org-without-config', connectorId: 'conn1', toolId: 't', error: 'e' });
    expect(mockedOutboundRequest).not.toHaveBeenCalled();
  });

  it('signs the dispatched payload with the generated secret', async () => {
    const { service } = buildService();
    const { secret } = await service.saveConfig('org1', {
      url: 'https://hooks.example.com/x',
      type: 'json',
      threshold: 1,
    });
    expect(secret).toBeDefined();

    await service.recordFailure({ organizationId: 'org1', connectorId: 'conn1', toolId: 'tool1', error: 'boom' });

    const call = mockedOutboundRequest.mock.calls[0][0];
    const timestamp = call.headers['X-AnythingMCP-Timestamp'];
    const expectedSignature = `sha256=${createHmac('sha256', secret!)
      .update(`${timestamp}.${call.data}`)
      .digest('hex')}`;
    expect(call.headers['X-AnythingMCP-Signature']).toBe(expectedSignature);
    expect(call.headers['X-AnythingMCP-Event']).toBe('connector.failing');
  });

  it('getConfig never returns the secret', async () => {
    const { service } = buildService();
    await service.saveConfig('org1', { url: 'https://hooks.example.com/x', type: 'json' });
    const config = await service.getConfig('org1');
    expect(config).not.toHaveProperty('secretEnc');
    expect(JSON.stringify(config)).not.toContain('secretEnc');
  });

  it('only returns a secret from saveConfig on create or when rotateSecret is set', async () => {
    const { service } = buildService();
    const first = await service.saveConfig('org1', { url: 'https://hooks.example.com/x', type: 'json' });
    expect(first.secret).toBeDefined();

    const second = await service.saveConfig('org1', { url: 'https://hooks.example.com/x', type: 'json', threshold: 10 });
    expect(second.secret).toBeUndefined();

    const rotated = await service.saveConfig('org1', { url: 'https://hooks.example.com/x', type: 'json', rotateSecret: true });
    expect(rotated.secret).toBeDefined();
    expect(rotated.secret).not.toBe(first.secret);
  });

  it('reads the webhook config once a minute per organization, not on every failure', async () => {
    const orgSettings = makeOrgSettings();
    const getJson = jest.spyOn(orgSettings, 'getJson');
    const { service } = buildService({ orgSettings });
    for (let i = 0; i < 5; i++) {
      await service.recordFailure({ organizationId: 'org-none', connectorId: 'conn1', toolId: 't', error: 'e' });
    }
    expect(getJson).toHaveBeenCalledTimes(1);

    // Saving a webhook takes effect at once, not after the cache expires.
    await service.saveConfig('org-none', { url: 'https://hooks.example.com/x', type: 'json', threshold: 1 });
    await service.recordFailure({ organizationId: 'org-none', connectorId: 'conn1', toolId: 't', error: 'e' });
    expect(mockedOutboundRequest).toHaveBeenCalledTimes(1);
  });

  it('escapes the connector name and the vendor error in a Slack message', async () => {
    const prisma = makePrisma();
    prisma.connector.findFirst.mockResolvedValue({ id: 'conn1', name: 'Shop <!channel>' });
    const { service } = buildService({ prisma });
    await service.saveConfig('org1', { url: 'https://hooks.slack.com/x', type: 'slack', threshold: 1 });
    await service.recordFailure({
      organizationId: 'org1',
      connectorId: 'conn1',
      toolId: 't',
      error: 'see <https://evil.example|Reset password>',
    });
    const text = JSON.parse(mockedOutboundRequest.mock.calls[0][0].data).text as string;
    expect(text).toContain('Shop &lt;!channel&gt;');
    expect(text).toContain('&lt;https://evil.example|Reset password&gt;');
    expect(text).not.toContain('<!channel>');
  });

  it('only looks up the connector inside the organization that failed', async () => {
    const { service, prisma } = buildService();
    await service.saveConfig('org1', { url: 'https://hooks.example.com/x', type: 'json', threshold: 1 });
    await service.recordFailure({ organizationId: 'org1', connectorId: 'conn1', toolId: 't', error: 'e' });
    expect(prisma.connector.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'conn1', organizationId: 'org1' } }),
    );
  });

  describe('SSRF: the webhook target must not inherit the connector allowlist', () => {
    const originalGuard = process.env.SSRF_GUARD;
    const originalAllowed = process.env.SSRF_ALLOWED_HOSTS;

    beforeEach(() => {
      process.env.SSRF_GUARD = 'enabled';
    });
    afterEach(() => {
      if (originalGuard === undefined) delete process.env.SSRF_GUARD;
      else process.env.SSRF_GUARD = originalGuard;
      if (originalAllowed === undefined) delete process.env.SSRF_ALLOWED_HOSTS;
      else process.env.SSRF_ALLOWED_HOSTS = originalAllowed;
    });

    it('on Cloud, rejects a private IP even when it is on the SSRF allowlist', async () => {
      process.env.SSRF_ALLOWED_HOSTS = '127.0.0.1';
      const { service } = buildService({ cloud: true });
      await expect(
        service.saveConfig('org1', { url: 'https://127.0.0.1/hook', type: 'json' }),
      ).rejects.toThrow(/not a public IP/);
    });

    it('on Cloud, requires https', async () => {
      const { service } = buildService({ cloud: true });
      await expect(
        service.saveConfig('org1', { url: 'http://hooks.example.com/hook', type: 'json' }),
      ).rejects.toThrow(/must use https/);
    });

    it('self-hosted, keeps the operator allowlist so an internal chat server can receive alerts', async () => {
      process.env.SSRF_ALLOWED_HOSTS = '127.0.0.1';
      const { service } = buildService();
      await expect(
        service.saveConfig('org1', { url: 'http://127.0.0.1/hook', type: 'json' }),
      ).resolves.toBeDefined();
    });

    it('rejects the cloud metadata address', async () => {
      const { service } = buildService();
      await expect(
        service.saveConfig('org1', { url: 'http://169.254.169.254/hook', type: 'json' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
