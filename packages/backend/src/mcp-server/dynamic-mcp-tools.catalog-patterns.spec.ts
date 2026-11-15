import { Logger } from '@nestjs/common';
import { DynamicMcpTools } from './dynamic-mcp-tools';
import type { RegisteredTool } from './tool-registry';
import { getAdapter } from '../adapters/catalog';

/**
 * A catalog tool's argument outside its declared pattern is refused before
 * the request is sent, with the argument's own description as the advice.
 */
describe('DynamicMcpTools: catalog argument patterns', () => {
  const catalogTool = getAdapter('etsy')!.tools.find((t) => t.name === 'etsy_get_listing')!;

  function etsyTool(config: Record<string, unknown> = { adapterSlug: 'etsy' }): RegisteredTool {
    return {
      id: 'tool-etsy',
      connectorId: 'conn-etsy',
      organizationId: 'org-1',
      name: 'etsy_get_listing',
      description: 'Get a listing',
      parameters: JSON.parse(JSON.stringify(catalogTool.parameters)),
      connectorType: 'REST',
      connectorConfig: {
        baseUrl: 'https://api.etsy.example/v3/application',
        authType: 'NONE',
        envVars: {},
        config,
      },
      endpointMapping: { method: 'GET', path: '/listings/{listing_id}', queryParams: { includes: '$includes' } },
    } as unknown as RegisteredTool;
  }

  function build(tool: RegisteredTool, rest: jest.Mock) {
    const audit = { logInvocation: jest.fn().mockResolvedValue(undefined) };
    const redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn(), incr: jest.fn(), expire: jest.fn(), ttl: jest.fn() };
    const unexpected = { execute: jest.fn().mockRejectedValue(new Error('unexpected engine')) };
    const executor = new DynamicMcpTools(
      { getTool: () => tool, getToolForOrg: () => tool } as any,
      audit as any,
      redis as any,
      { checkLicenseActive: jest.fn().mockResolvedValue(undefined) } as any,
      { isCloud: () => false } as any,
      {} as any,
      { execute: rest } as any,
      unexpected as any,
      unexpected as any,
      unexpected as any,
      unexpected as any,
      { scheduleObservationalIngest: jest.fn() } as any,
      { recentEvents: jest.fn().mockResolvedValue([]) } as any,
    );
    return { executor, audit };
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('refuses the call without sending it, and says which tool has the data', async () => {
    const rest = jest.fn().mockResolvedValue({ listing_id: 1 });
    const { executor, audit } = build(etsyTool(), rest);
    const res: any = await executor.executeTool('etsy_get_listing', { listing_id: '1', includes: 'Images,Inventory' });

    expect(rest).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    const detail = JSON.parse(res.content[0].text);
    expect(detail.code).toBe('INVALID_ARGUMENT');
    expect(detail.error).toMatch(/^`includes` cannot be "Images,Inventory"\./);
    expect(detail.error).toMatch(/etsy_read_listing_inventory/);
    expect(detail.error).toMatch(/No request was sent to the API/);
    // In the call log like any other failed call, so the workspace sees why.
    expect(audit.logInvocation.mock.calls[0][0]).toMatchObject({ status: 'ERROR' });
    expect(audit.logInvocation.mock.calls[0][0].error).toMatch(/cannot be "Images,Inventory"/);
  });

  it('sends a call whose arguments match', async () => {
    const rest = jest.fn().mockResolvedValue({ listing_id: 1 });
    const { executor } = build(etsyTool(), rest);
    const res: any = await executor.executeTool('etsy_get_listing', { listing_id: '1', includes: 'Images,Videos' });
    expect(res.isError).toBeFalsy();
    expect(rest).toHaveBeenCalledTimes(1);
  });

  it('does not check a hand-built tool with the same schema', async () => {
    const rest = jest.fn().mockResolvedValue({ listing_id: 1 });
    const { executor } = build(etsyTool({}), rest);
    const res: any = await executor.executeTool('etsy_get_listing', { listing_id: '1', includes: 'Images,Inventory' });
    expect(res.isError).toBeFalsy();
    expect(rest).toHaveBeenCalledTimes(1);
  });
});
