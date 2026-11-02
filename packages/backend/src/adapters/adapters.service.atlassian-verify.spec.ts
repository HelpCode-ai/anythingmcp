import { AdaptersService } from './adapters.service';
import { outboundRequest } from '../common/outbound-http';

// The site lookup (tenant_info) goes out through this; no test may reach Atlassian.
jest.mock('../common/outbound-http', () => ({
  ...jest.requireActual('../common/outbound-http'),
  outboundRequest: jest.fn(),
}));
const outbound = outboundRequest as jest.MockedFunction<typeof outboundRequest>;

/**
 * The setup check of the Atlassian Rovo MCP bridge. Two connectors on Cloud
 * never made a successful call: one with the token pasted twice (initialize
 * answered 401 invalid_token), one with a token created without scopes
 * (discover found no product, every tool "missing the scope claim"). Both
 * were saved as ready because the bridge had no setup check at all.
 */
describe('AdaptersService.verifyCredentials: Atlassian Rovo MCP', () => {
  const TOKEN = 'ATATT3xFfGF0' + 'aB1-cD2_eF3='.repeat(15);
  const CLOUD_ID = '1324a887-45db-1bf4-1e99-ef0ff456d421';
  const KEYS = { ATLASSIAN_EMAIL: 'jane.doe@acme.test', ATLASSIAN_API_TOKEN: TOKEN };

  function build(execute: jest.Mock, discover = jest.fn()) {
    const prisma = {
      connector: { create: jest.fn(async ({ data }: any) => ({ id: 'c1', ...data })), findUnique: jest.fn() },
      mcpTool: { createMany: jest.fn(async ({ data }: any) => ({ count: data.length })) },
    };
    const service = new AdaptersService(
      prisma as any,
      { reloadConnectorTools: jest.fn() } as any,
      { get: (k: string) => (k === 'ENCRYPTION_KEY' ? 'a'.repeat(48) : undefined) } as any,
      { executeConnectorCall: execute, discoverRemoteMcpTools: discover } as any,
    );
    return { service, prisma };
  }

  /** A tool result as the MCP SDK returns it. */
  const result = (payload: unknown, isError = false) => ({
    content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  });

  /** What the SDK throws for a 401 at initialize: the body as message, the status in data. */
  function sdk401() {
    const err: any = new Error('Error POSTing to endpoint: {"error":"invalid_token","error_description":"invalid token"}');
    err.code = 'CLIENT_HTTP_NOT_IMPLEMENTED';
    err.data = { status: 401, statusText: 'Unauthorized' };
    return err;
  }

  beforeEach(() => outbound.mockReset());

  it('puts a refused email and token under the token field, with the advice', async () => {
    const { service } = build(jest.fn().mockRejectedValue(sdk401()));
    const out: any = await service.verifyCredentials('atlassian', 'org1', KEYS);
    expect(out).toMatchObject({ ok: false, kind: 'auth_failed', status: 401, toolName: 'atlassian_discover' });
    expect(out.message).toContain('Atlassian refused the email and token together');
    expect(out.message).toContain('pasted once');
    expect(out.message).toContain('invalid_token');
    expect(out.fields.ATLASSIAN_API_TOKEN).toContain('API-token authentication is enabled');
  });

  it('refuses a token pasted twice before calling Atlassian', async () => {
    const execute = jest.fn();
    const { service } = build(execute);
    const out: any = await service.verifyCredentials('atlassian', 'org1', {
      ...KEYS,
      ATLASSIAN_API_TOKEN: TOKEN.slice(0, 150) + TOKEN.slice(0, 150),
    });
    expect(out).toMatchObject({ ok: false, kind: 'invalid_input' });
    expect(out.fields.ATLASSIAN_API_TOKEN).toBeDefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a token longer than any Atlassian token', async () => {
    const execute = jest.fn();
    const { service } = build(execute);
    const out: any = await service.verifyCredentials('atlassian', 'org1', {
      ...KEYS,
      ATLASSIAN_API_TOKEN: 'ATATT' + 'x'.repeat(380) + 'y',
    });
    expect(out).toMatchObject({ ok: false, kind: 'invalid_input' });
    expect(out.fields.ATLASSIAN_API_TOKEN).toContain('only once');
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a token without scopes: discover finds no product to search', async () => {
    const execute = jest.fn().mockResolvedValue(
      result({ results: [], searchableProducts: [], message: 'No tools matched.' }),
    );
    const { service } = build(execute);
    const out: any = await service.verifyCredentials('atlassian', 'org1', KEYS);
    expect(out).toMatchObject({ ok: false, kind: 'auth_failed', toolName: 'atlassian_discover' });
    expect(out.message).toContain('This API token has no scopes');
    expect(out.message).toContain('read:jira:agent-interface');
    expect(out.fields.ATLASSIAN_API_TOKEN).toContain("Create an 'API token with scopes'");
    // The probe is the read-only discover.
    const [, mapping, params] = execute.mock.calls[0];
    expect(mapping).toMatchObject({ method: 'discover' });
    expect(params).toMatchObject({ query: 'get issue details' });
  });

  it('refuses a token without scopes when discover answers with the scope error', async () => {
    const execute = jest.fn().mockResolvedValue(
      result(
        'Unable to resolve user scopes from the user-context token for "discover". The session token is missing the scope claim required to authorize this operation.',
        true,
      ),
    );
    const { service } = build(execute);
    const out: any = await service.verifyCredentials('atlassian', 'org1', KEYS);
    expect(out).toMatchObject({ ok: false, kind: 'auth_failed' });
    expect(out.message).toContain('This API token has no scopes');
    expect(out.message).toContain('missing the scope claim');
  });

  it('accepts a scoped token', async () => {
    const execute = jest.fn().mockResolvedValue(
      result({ results: [{ name: 'getJiraIssue' }], searchableProducts: ['jira', 'confluence'] }),
    );
    const { service } = build(execute);
    const out: any = await service.verifyCredentials('atlassian', 'org1', KEYS);
    expect(out).toMatchObject({ ok: true, toolName: 'atlassian_discover' });
    expect(outbound).not.toHaveBeenCalled();
  });

  it('looks the cloudId up from the site, normalising the address', async () => {
    outbound.mockResolvedValue({ status: 200, data: { cloudId: CLOUD_ID } } as any);
    const execute = jest.fn().mockResolvedValue(result({ results: [], searchableProducts: ['jira'] }));
    const { service } = build(execute);
    const out: any = await service.verifyCredentials('atlassian', 'org1', {
      ...KEYS,
      ATLASSIAN_SITE: 'https://Acme.atlassian.net/',
    });
    expect(out).toMatchObject({ ok: true });
    expect(outbound).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', url: 'https://acme.atlassian.net/_edge/tenant_info' }),
    );
    // No credential goes to the public lookup.
    expect(JSON.stringify(outbound.mock.calls[0][0])).not.toContain(TOKEN);
  });

  it('names a site that has no cloudId on its field, before calling the MCP server', async () => {
    outbound.mockResolvedValue({ status: 404, data: '<html>Not found</html>' } as any);
    const execute = jest.fn();
    const { service } = build(execute);
    const out: any = await service.verifyCredentials('atlassian', 'org1', {
      ...KEYS,
      ATLASSIAN_SITE: 'acme-typo.atlassian.net',
    });
    expect(out).toMatchObject({ ok: false, kind: 'invalid_input' });
    expect(out.fields.ATLASSIAN_SITE).toContain('No Atlassian site answers at acme-typo.atlassian.net');
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses a site that is not under atlassian.net, without a lookup', async () => {
    const { service } = build(jest.fn());
    const out: any = await service.verifyCredentials('atlassian', 'org1', { ...KEYS, ATLASSIAN_SITE: 'jira.acme.test' });
    expect(out).toMatchObject({ ok: false, kind: 'invalid_input' });
    expect(out.fields.ATLASSIAN_SITE).toContain('mycompany.atlassian.net');
    expect(outbound).not.toHaveBeenCalled();
  });

  it('goes on without the cloudId when the site does not answer at all', async () => {
    outbound.mockRejectedValue(new Error('ETIMEDOUT'));
    const execute = jest.fn().mockResolvedValue(result({ searchableProducts: ['jira'] }));
    const { service } = build(execute);
    const out: any = await service.verifyCredentials('atlassian', 'org1', { ...KEYS, ATLASSIAN_SITE: 'acme.atlassian.net' });
    expect(out).toMatchObject({ ok: true });
  });

  it('stores the bare site and its cloudId with the variables at install', async () => {
    outbound.mockResolvedValue({ status: 200, data: { cloudId: CLOUD_ID } } as any);
    const discover = jest.fn().mockResolvedValue([]);
    const { service, prisma } = build(jest.fn(), discover);
    await service.importAdapter('atlassian', 'u1', 'org1', { ...KEYS, ATLASSIAN_SITE: 'https://acme.atlassian.net/' });
    const data = prisma.connector.create.mock.calls[0][0].data;
    expect(data.envVars).toMatchObject({ ATLASSIAN_SITE: 'acme.atlassian.net', ATLASSIAN_CLOUD_ID: CLOUD_ID });
  });

  it('installs without a cloudId when the site gives none ("Save anyway")', async () => {
    outbound.mockResolvedValue({ status: 404, data: 'nope' } as any);
    const { service, prisma } = build(jest.fn(), jest.fn().mockResolvedValue([]));
    await service.importAdapter('atlassian', 'u1', 'org1', { ...KEYS, ATLASSIAN_SITE: 'acme.atlassian.net' });
    const data = prisma.connector.create.mock.calls[0][0].data;
    expect(data.envVars.ATLASSIAN_SITE).toBe('acme.atlassian.net');
    expect(data.envVars.ATLASSIAN_CLOUD_ID).toBeUndefined();
  });
});

describe('AdaptersService.verifyCredentials: MCP bridge without a probe', () => {
  function build(discover: jest.Mock) {
    const service = new AdaptersService(
      { connector: { create: jest.fn() } } as any,
      { reloadConnectorTools: jest.fn() } as any,
      { get: (k: string) => (k === 'ENCRYPTION_KEY' ? 'a'.repeat(48) : undefined) } as any,
      { executeConnectorCall: jest.fn(), discoverRemoteMcpTools: discover } as any,
    );
    return service;
  }

  it('lists the tools, as the install would', async () => {
    const discover = jest.fn().mockResolvedValue([{ name: 'list_issues' }, { name: 'get_issue' }]);
    const out: any = await build(discover).verifyCredentials('linear', 'org1', { LINEAR_API_KEY: 'lin_api_' + 'a1B2'.repeat(10) });
    expect(out).toMatchObject({ ok: true, toolName: 'tools/list' });
    expect(out.sample).toContain('2 tools on the server');
    expect(discover.mock.calls[0][0].id).toBe('');
  });

  it('reports a refused token as auth_failed, reading the status the SDK keeps in cause.data', async () => {
    const sdk: any = new Error('Error POSTing to endpoint: {"error":"invalid_token"}');
    sdk.data = { status: 401 };
    const explained: any = new Error('The MCP server requires sign-in (HTTP 401).');
    explained.cause = sdk;
    const out: any = await build(jest.fn().mockRejectedValue(explained)).verifyCredentials('linear', 'org1', {
      LINEAR_API_KEY: 'lin_api_' + 'a1B2'.repeat(10),
    });
    expect(out).toMatchObject({ ok: false, kind: 'auth_failed', status: 401, toolName: 'tools/list' });
  });
});
