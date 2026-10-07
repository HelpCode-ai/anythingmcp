import * as adapter from './xero.json';
import { AdapterDefinition, getAdapter } from '../catalog';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateDeep } from '../../common/env-interpolation.util';
import * as outboundHttp from '../../common/outbound-http';
import * as ssrf from '../../common/ssrf.util';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { AxiosResponse } from 'axios';
import { AdaptersService } from '../adapters.service';
import { ConnectorsService } from '../../connectors/connectors.service';
import { McpOAuthCallbackController } from '../../connectors/mcp-oauth-callback.controller';
import { decrypt } from '../../common/crypto/encryption.util';
import { computeSetupState } from '../../connectors/connector-setup-status.util';

const a = adapter as unknown as AdapterDefinition & { probe: { tool: string } };
const tenantId = '44444444-4444-4444-8444-444444444444';
const expectedPaths = [
  '/Organisation',
  '/Invoices',
  '/Invoices/11111111-1111-4111-8111-111111111111',
  '/Contacts',
  '/Contacts/22222222-2222-4222-8222-222222222222',
  '/Accounts',
  '/Accounts/33333333-3333-4333-8333-333333333333',
  '/Reports/TrialBalance',
  '/Reports/ProfitAndLoss',
];

describe('Xero adapter: static conformance', () => {
  it('registers a REST accounting adapter for the official Accounting base URL', () => {
    expect(getAdapter('xero')).toMatchObject({ region: 'intl', category: 'accounting' });
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://api.xero.com/api.xro/2.0');
  });

  it('uses authorisation code and rotating refresh tokens with Basic client authentication', () => {
    expect(a.requiredEnvVars).toEqual(['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET', 'XERO_TENANT_ID']);
    expect(a.optionalEnvVars).toEqual(['XERO_REFRESH_TOKEN']);
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toMatchObject({
      clientId: '{{XERO_CLIENT_ID}}',
      clientSecret: '{{XERO_CLIENT_SECRET}}',
      refreshToken: '{{XERO_REFRESH_TOKEN}}',
      grant: 'refresh_token',
      authorizationUrl: 'https://login.xero.com/identity/connect/authorize',
      tokenUrl: 'https://identity.xero.com/connect/token',
      tokenAuthMethod: 'client_secret_basic',
      extraHeaders: { 'xero-tenant-id': '{{XERO_TENANT_ID}}' },
    });
    expect(String(a.connector.authConfig?.scopes).split(' ').sort()).toEqual([
      'openid', 'offline_access', 'accounting.invoices.read', 'accounting.contacts.read',
      'accounting.settings.read', 'accounting.reports.trialbalance.read',
      'accounting.reports.profitandloss.read',
    ].sort());
  });

  it('has nine GET-only tools with examples and a parameter-free organisation probe', () => {
    expect(a.tools).toHaveLength(9);
    for (const tool of a.tools) {
      expect(tool.endpointMapping.method).toBe('GET');
      expect(tool.endpointMapping.path).toMatch(/^\/(Organisation|Invoices|Contacts|Accounts|Reports\/)/);
      expect(tool.endpointMapping.bodyMapping).toBeUndefined();
      expect(tool.endpointMapping.bodyTemplate).toBeUndefined();
      expect(tool.endpointMapping.headers).toBeUndefined();
      expect(tool.parameters.examples).toEqual(expect.arrayContaining([expect.any(Object)]));
      expect(tool.parameters.additionalProperties).toBe(false);
    }
    const probe = a.tools.find((tool) => tool.name === a.probe.tool)!;
    expect(probe.name).toBe('xero_get_organisation');
    expect(probe.parameters.required ?? []).toEqual([]);
    expect(probe.parameters.examples).toEqual([{}]);
    expect(a.connector.healthcheckPath).toBe('/Organisation');
  });

  it('documents callbacks, tenant selection, granular consent and rate limiting', () => {
    expect(a.instructions).toContain('https://cloud.anythingmcp.com/api/mcp-oauth/callback');
    expect(a.instructions).toContain('<your AnythingMCP server URL>/api/mcp-oauth/callback');
    expect(a.instructions).toContain('GET https://api.xero.com/connections');
    expect(a.instructions).toContain('tenantId');
    expect(a.instructions).toContain('Retry-After');
    expect(a.instructions).toContain('consent is additive');
  });
});

describe('Xero adapter: REST request mapping', () => {
  let engine: RestEngine;
  let send: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(ssrf, 'assertSafeOutboundUrl').mockResolvedValue(undefined);
    send = jest.spyOn(outboundHttp, 'outboundRequest').mockResolvedValue({
      data: { Status: 'OK' }, status: 200, headers: {},
    } as AxiosResponse);
    engine = new RestEngine(
      { getAccessToken: jest.fn().mockResolvedValue('synthetic-access-token') } as unknown as OAuth2TokenService,
      {} as LoginTokenService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  const config = {
    ...a.connector,
    authConfig: interpolateDeep(a.connector.authConfig, {
      XERO_CLIENT_ID: 'synthetic-client', XERO_CLIENT_SECRET: 'synthetic-secret',
      XERO_REFRESH_TOKEN: '', XERO_TENANT_ID: tenantId,
    }),
  };

  it.each(a.tools.map((tool, index) => ({ tool, expectedPath: expectedPaths[index] })))(
    'sends $tool.name with bearer auth and the resolved tenant header', async ({ tool, expectedPath }) => {
      const example = (tool.parameters.examples as Record<string, unknown>[])[0];
      await engine.execute(config, tool.endpointMapping as { method: string }, applySchemaDefaults(tool.parameters, example));
      const request = send.mock.calls[0][0];
      expect(request).toMatchObject({
        method: 'GET', url: a.connector.baseUrl + expectedPath,
        headers: { Authorization: 'Bearer synthetic-access-token', 'xero-tenant-id': tenantId, Accept: 'application/json' },
      });
      expect(request.data).toBeUndefined();
      expect(JSON.stringify(request)).not.toContain('{{');
      expect(request.url).not.toContain('synthetic-');
    },
  );

  it.each(['xero_list_invoices', 'xero_list_contacts'])('bounds an empty %s call to the first page', async (name) => {
    const tool = a.tools.find((item) => item.name === name)!;
    await engine.execute(config, tool.endpointMapping as { method: string }, applySchemaDefaults(tool.parameters, {}));
    expect(send.mock.calls[0][0].params).toEqual({ page: 1, pageSize: 100 });
  });

  it('keeps filters as query values and does not paginate accounts', async () => {
    const tool = a.tools.find((item) => item.name === 'xero_list_accounts')!;
    const params = { where: 'Name=="Example & Co"', order: 'Code ASC' };
    await engine.execute(config, tool.endpointMapping as { method: string }, params);
    expect(send.mock.calls[0][0].params).toEqual(params);
  });

  it.each([
    ['xero_list_invoices', { page: 2, pageSize: 50, where: 'Type=="ACCREC"', order: 'InvoiceNumber ASC' }],
    ['xero_list_contacts', { page: 2, pageSize: 50, searchTerm: 'Example & Co', where: 'ContactStatus=="ACTIVE"', order: 'Name ASC', includeArchived: false }],
  ])('maps all exposed %s list queries', async (name, params) => {
    const tool = a.tools.find((item) => item.name === name)!;
    await engine.execute(config, tool.endpointMapping as { method: string }, params as Record<string, unknown>);
    expect(send.mock.calls[0][0].params).toEqual(params);
  });

  it.each([
    ['xero_list_invoices', { Invoices: [{ InvoiceID: 'synthetic-invoice' }] }],
    ['xero_list_contacts', { Contacts: [{ ContactID: 'synthetic-contact' }] }],
  ])('preserves the %s response envelope', async (name, envelope) => {
    send.mockResolvedValueOnce({ data: envelope, status: 200, headers: {} } as AxiosResponse);
    const tool = a.tools.find((item) => item.name === name)!;
    await expect(engine.execute(config, tool.endpointMapping as { method: string }, {})).resolves.toEqual(envelope);
  });

  it.each([
    ['xero_get_trial_balance', { date: '2026-06-30', paymentsOnly: false }],
    ['xero_get_profit_and_loss', { fromDate: '2026-07-01', toDate: '2026-09-30', paymentsOnly: false, periods: 1, timeframe: 'QUARTER' }],
  ])('maps %s report dates and preserves accrual basis', async (name, params) => {
    const tool = a.tools.find((item) => item.name === name)!;
    await engine.execute(config, tool.endpointMapping as { method: string }, params as Record<string, unknown>);
    expect(send.mock.calls[0][0].params).toEqual(params);
  });

  it.each([
    ['xero_get_invoice', 'invoiceId', '/Invoices'],
    ['xero_get_contact', 'contactId', '/Contacts'],
    ['xero_get_account', 'accountId', '/Accounts'],
  ])('encodes %s identifiers so they cannot change the path', async (name, parameter, path) => {
    const tool = a.tools.find((item) => item.name === name)!;
    await engine.execute(config, tool.endpointMapping as { method: string }, { [parameter]: 'id/other?query#fragment' });
    expect(send.mock.calls[0][0].url).toBe(a.connector.baseUrl + path + '/id%2Fother%3Fquery%23fragment');
  });

  it.each([undefined, ''])('installs and authorises with optional refresh token %s', async (refreshToken) => {
    const encryptionKey = 'x'.repeat(48);
    const settings = { get: (key: string) => key === 'ENCRYPTION_KEY' ? encryptionKey : undefined };
    let row: any;
    const prisma = {
      connector: {
        create: jest.fn(async ({ data }) => (row = { id: 'xero-test', ...data })),
        findUnique: jest.fn(async () => row),
        update: jest.fn(async ({ data }) => (row = { ...row, ...data })),
      },
      mcpTool: { createMany: jest.fn(async ({ data }) => ({ count: data.length })) },
    };
    const registry = { reloadConnectorTools: jest.fn().mockResolvedValue(undefined) };
    engine = new RestEngine(new OAuth2TokenService(prisma as any, settings as any), {} as LoginTokenService);
    const connectors = Object.assign(Object.create(ConnectorsService.prototype), {
      encryptionKey, prisma, restEngine: engine,
      findById: jest.fn(async () => row), findByIdInternal: jest.fn(async () => row),
    }) as ConnectorsService;
    const service = new AdaptersService(prisma as any, registry as any, settings as any, connectors);
    const credentials = {
      XERO_CLIENT_ID: 'synthetic-client', XERO_CLIENT_SECRET: 'synthetic-secret', XERO_TENANT_ID: tenantId,
      ...(refreshToken === undefined ? {} : { XERO_REFRESH_TOKEN: refreshToken }),
    };
    const installed = await service.importAdapter('xero', 'user-1', 'org-1', credentials);
    const initial = JSON.parse(decrypt(row.authConfig, encryptionKey));
    expect(installed).toMatchObject({ toolsCreated: 9, probe: null });
    expect(computeSetupState({ ...row, authConfig: initial })).toEqual({ status: 'needs_authorization', missing: [] });
    expect(send).not.toHaveBeenCalled();

    const oauth = {
      takePendingFlow: jest.fn().mockResolvedValue({ flow: {
        ...initial, connectorId: row.id, userId: 'user-1', codeVerifier: 'synthetic-verifier',
        redirectUri: 'https://cloud.anythingmcp.com/api/mcp-oauth/callback',
      } }),
      exchangeCodeForTokens: jest.fn().mockResolvedValue({
        accessToken: 'synthetic-authorised-token', refreshToken: 'synthetic-rotated-token', expiresIn: 1800,
      }),
    };
    const callback = new McpOAuthCallbackController(
      oauth as any, connectors, {} as any, prisma as any, registry as any, settings as any, {} as any,
    );
    await callback.complete({ user: { sub: 'user-1' } }, { state: 'synthetic-state', code: 'synthetic-code' });
    const saved = JSON.parse(decrypt(row.authConfig, encryptionKey));
    expect(saved).toMatchObject({
      accessToken: 'synthetic-authorised-token', refreshToken: 'synthetic-rotated-token',
      extraHeaders: { 'xero-tenant-id': tenantId }, tokenAuthMethod: 'client_secret_basic',
    });
    expect(computeSetupState({ ...row, authConfig: saved })).toEqual({ status: 'ready', missing: [] });
    await expect(connectors.testConnection(row.id)).resolves.toMatchObject({ ok: true });
    const probe = a.tools.find((item) => item.name === a.probe.tool)!;
    await engine.execute({ ...a.connector, authConfig: saved }, probe.endpointMapping as { method: string }, {});
    expect(send).toHaveBeenCalledTimes(2);
    for (const [request] of send.mock.calls) {
      expect(request).toMatchObject({
        method: 'GET', url: a.connector.baseUrl + '/Organisation',
        headers: { Authorization: 'Bearer synthetic-authorised-token', 'xero-tenant-id': tenantId },
      });
    }
  });
});

// Opt-in only, using an already issued read-only access token for a demo organisation.
// RUN_XERO_LIVE=1 XERO_ACCESS_TOKEN=... XERO_TENANT_ID=... npm test -w packages/backend -- xero.live.spec.ts
const live = process.env.RUN_XERO_LIVE === '1' ? describe : describe.skip;
live('Xero adapter: live read-only probe', () => {
  it('reads the selected organisation', async () => {
    const token = process.env.XERO_ACCESS_TOKEN;
    const tenant = process.env.XERO_TENANT_ID;
    if (!token || !tenant) throw new Error('Set XERO_ACCESS_TOKEN and XERO_TENANT_ID for RUN_XERO_LIVE=1');
    const response = await outboundHttp.outboundRequest({
      method: 'GET', url: a.connector.baseUrl + '/Organisation', timeout: 30000,
      headers: { Authorization: `Bearer ${token}`, 'xero-tenant-id': tenant, Accept: 'application/json' },
    });
    expect(response.status).toBe(200);
    expect(response.data.Organisations).toHaveLength(1);
  }, 35000);
});
