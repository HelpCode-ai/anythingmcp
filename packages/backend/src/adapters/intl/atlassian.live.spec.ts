import * as adapter from './atlassian.json';
import { localMcpToolName } from '../../connectors/mcp-connector-config.util';
import { McpClientEngine } from '../../connectors/engines/mcp-client.engine';
import type { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { resolveDerivedEnvVars, type DerivedEnvVar } from '../derived-settings';
import { probeResultFailure } from '../probe.util';

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  endpointMapping: { method: string; path: string };
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { kind?: string; secret?: boolean; pattern?: string }>;
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, string>;
    config: { mcpToolPrefix: string; mcpPath?: string };
  };
  tools: Tool[];
};
const full = adapter as unknown as {
  optionalEnvVars: string[];
  derivedEnvVars: Record<string, DerivedEnvVar>;
  instructionFacts: string[];
  probe: { tool: string; failWhen: Array<{ matches: string; hint: string; field?: string }> };
  verifyHints: Record<string, { hint: string; field?: string }>;
};

describe('atlassian adapter: static spec conformance', () => {
  it("bridges Atlassian's Rovo MCP server with email and API token as Basic auth", () => {
    expect(a.connector.type).toBe('MCP');
    expect(a.connector.baseUrl).toBe('https://mcp.atlassian.com/v2/mcp');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({
      username: '{{ATLASSIAN_EMAIL}}',
      password: '{{ATLASSIAN_API_TOKEN}}',
    });
    expect(a.connector.config.mcpToolPrefix).toBe('atlassian_');
    expect(a.requiredEnvVars).toEqual(['ATLASSIAN_EMAIL', 'ATLASSIAN_API_TOKEN']);
  });

  it('treats the email as a setting and the token as a secret that refuses "email:token"', () => {
    expect(a.envVarMeta.ATLASSIAN_EMAIL.kind).toBe('setting');
    expect(a.envVarMeta.ATLASSIAN_EMAIL.secret).toBe(false);
    expect(a.envVarMeta.ATLASSIAN_API_TOKEN.secret).toBe(true);
    const token = new RegExp(a.envVarMeta.ATLASSIAN_API_TOKEN.pattern as string);
    expect(token.test('ATATT' + 'xY0'.repeat(14) + '_AbC=A1B2C3D4')).toBe(true);
    expect(token.test('jane@example.com:ATATT' + 'xY0'.repeat(10))).toBe(false);
  });

  it('names each tool with the prefix and calls it by its remote name', () => {
    for (const t of a.tools) {
      expect(t.name).toBe(localMcpToolName(t.endpointMapping.method, a.connector.config.mcpToolPrefix));
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(t.endpointMapping.path).toBe('/mcp');
    }
    const remote = a.tools.map((t) => t.endpointMapping.method);
    expect(remote).toEqual(
      expect.arrayContaining([
        'getAccessibleAtlassianResources',
        'atlassianUserInfo',
        'discover',
        'executeRead',
        'executeWrite',
        'getJiraIssue',
        'searchJiraIssuesUsingJql',
        'createJiraIssue',
        'getConfluenceContent',
        'searchConfluence',
        'search',
      ]),
    );
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
  });

  it('ships the destructive, admin and credit-heavy tools switched off', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.endpointMapping.method);
    expect(off).toEqual(
      expect.arrayContaining([
        // The default endpoint lists only the main tools and reaches the
        // rest through these two, so switching off merge or permission tools
        // one by one would not hold without them.
        'executeWrite',
        'executeDestructive',
        'deleteJiraIssue',
        'deleteJiraComment',
        'deleteJiraIssueAttachment',
        'createJiraProject',
        'updateJiraProject',
        'replaceConfluenceContentPermissions',
        'removeConfluenceContentPermissions',
        'enableConfluencePublicLink',
        'mergeBitbucketRepoPullRequest',
        'createConfluenceInfographicForPage',
      ]),
    );
    for (const t of a.tools.filter((x) => x.annotations?.destructiveHint === true)) {
      expect(t.enabled).toBe(false);
    }
  });

  it('keeps ordinary creates and edits of work items, comments and pages on', () => {
    const on = a.tools.filter((t) => t.enabled !== false).map((t) => t.endpointMapping.method);
    expect(on).toEqual(
      expect.arrayContaining([
        'createJiraIssue',
        'editJiraIssue',
        'transitionJiraIssue',
        'addOrEditJiraIssueComment',
        'createConfluenceContent',
        'updateConfluenceContent',
        'createConfluenceComment',
      ]),
    );
  });

  it('explains admin enablement, cloudId, IP allow lists and the service-account Bearer key', () => {
    expect(a.instructions.length).toBeGreaterThanOrEqual(1200);
    expect(a.instructions).toContain('Rovo MCP server settings');
    expect(a.instructions).toContain('getAccessibleAtlassianResources');
    expect(a.instructions).toContain('IP allow list');
    expect(a.instructions).toContain('Bearer token');
    expect(a.instructions).toContain('Discover tools');
  });

  it('uses no em or en dashes', () => {
    expect(JSON.stringify(adapter)).not.toMatch(/[\u2013\u2014]/);
  });

  it('takes the site as an optional, non-secret setting under atlassian.net, with or without https://', () => {
    expect(full.optionalEnvVars).toEqual(['ATLASSIAN_SITE']);
    const site = a.envVarMeta.ATLASSIAN_SITE as { kind?: string; secret?: boolean; pattern: string; help: string; label: string };
    expect(site.kind).toBe('setting');
    expect(site.secret).toBe(false);
    expect(site.label).toMatch(/strongly recommended/);
    expect(site.help).toMatch(/cloudId/);
    const re = new RegExp(site.pattern);
    for (const ok of ['acme.atlassian.net', 'https://acme.atlassian.net', 'https://acme-eu.atlassian.net/']) {
      expect(re.test(ok)).toBe(true);
    }
    for (const bad of ['acme', 'jira.acme.com', 'https://acme.atlassian.net/wiki', 'acme.atlassian.net.evil.test']) {
      expect(re.test(bad)).toBe(false);
    }
  });

  it('refuses a token longer than any Atlassian token (one pasted twice is ~384 characters)', () => {
    const token = new RegExp(a.envVarMeta.ATLASSIAN_API_TOKEN.pattern as string);
    expect(token.test('ATATT' + 'a'.repeat(187))).toBe(true);
    expect(token.test('ATATT' + 'a'.repeat(379))).toBe(false);
  });

  it('looks the cloudId up from the public tenant_info of the site', () => {
    expect(full.derivedEnvVars).toEqual({
      ATLASSIAN_CLOUD_ID: expect.objectContaining({
        fromHost: 'ATLASSIAN_SITE',
        url: 'https://{{ATLASSIAN_SITE}}/_edge/tenant_info',
        path: 'cloudId',
      }),
    });
    expect(full.instructionFacts).toEqual([expect.stringContaining('{{ATLASSIAN_SITE}}, cloudId {{ATLASSIAN_CLOUD_ID}}')]);
  });

  it('checks the setup with the read-only discover and refuses a token without scopes', () => {
    expect(full.probe.tool).toBe('atlassian_discover');
    const discover = a.tools.find((t) => t.name === full.probe.tool)!;
    expect(discover.annotations?.readOnlyHint).toBe(true);
    const [rule] = full.probe.failWhen;
    const re = new RegExp(rule.matches, 'i');
    expect(re.test('{"results":[],"searchableProducts":[],"message":"x"}')).toBe(true);
    expect(re.test('The session token is missing the scope claim required to authorize this operation.')).toBe(true);
    expect(re.test('{"results":[{"name":"getJiraIssue"}],"searchableProducts":["jira"]}')).toBe(false);
    expect(rule.field).toBe('ATLASSIAN_API_TOKEN');
    expect(rule.hint).toContain("Create an 'API token with scopes'");
    expect(full.verifyHints['401']).toMatchObject({
      field: 'ATLASSIAN_API_TOKEN',
      hint: expect.stringContaining('Atlassian refused the email and token together'),
    });
  });

  it('tells the model to use the workspace cloudId and to ask for the site, not to start with getAccessibleAtlassianResources', () => {
    expect(a.instructions).not.toContain('start with `atlassian_getAccessibleAtlassianResources`');
    expect(a.instructions).toContain('workspace guide names it with its cloudId');
    expect(a.instructions).toContain('mycompany.atlassian.net');
    expect(a.instructions).toContain('Create API token with scopes');
    const resources = a.tools.find((t) => t.name === 'atlassian_getAccessibleAtlassianResources')!;
    expect(resources.description).not.toMatch(/Call it first/);
    expect(resources.description).toMatch(/only when the workspace guide names no cloudId/);
    for (const t of a.tools) {
      const cloudId = (t as unknown as { parameters?: { properties?: Record<string, { description: string }> } })
        .parameters?.properties?.cloudId;
      if (cloudId) expect(cloudId.description).toMatch(/workspace guide/);
    }
  });
});

/**
 * Opt-in check against a real Atlassian site: RUN_ATLASSIAN_LIVE=1 with
 * ATLASSIAN_EMAIL, ATLASSIAN_API_TOKEN (an API token with scopes) and
 * ATLASSIAN_SITE (e.g. mycompany.atlassian.net) in the environment. Read-only:
 * tenant_info, then discover and one Jira search through the bridge engine.
 */
const live = process.env.RUN_ATLASSIAN_LIVE === '1';
(live ? describe : describe.skip)('atlassian: live', () => {
  jest.setTimeout(60_000);
  const email = process.env.ATLASSIAN_EMAIL ?? '';
  const token = process.env.ATLASSIAN_API_TOKEN ?? '';
  const site = process.env.ATLASSIAN_SITE ?? '';
  // Basic auth needs no token service.
  const engine = new McpClientEngine({} as unknown as OAuth2TokenService);
  const config = {
    baseUrl: a.connector.baseUrl,
    authType: a.connector.authType,
    authConfig: { username: email, password: token },
  };
  let cloudId = '';

  it('has the credentials it needs', () => {
    expect(email && token && site).toBeTruthy();
  });

  it("finds the site's cloudId", async () => {
    const out = await resolveDerivedEnvVars(full, { ATLASSIAN_SITE: site });
    expect(out.fields).toEqual({});
    cloudId = out.values.ATLASSIAN_CLOUD_ID;
    expect(cloudId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('passes the setup check: discover finds products to search', async () => {
    const raw = await engine.execute(config, { method: 'discover', path: '/mcp' }, { query: 'get issue details' });
    expect(probeResultFailure(full, raw)).toBeNull();
  });

  it('runs a read with the looked-up cloudId', async () => {
    const raw = await engine.execute(
      config,
      { method: 'searchJiraIssuesUsingJql', path: '/mcp' },
      { cloudId, jql: 'order by created DESC', maxResults: 1, fields: ['summary'] },
    );
    expect((raw as { isError?: boolean }).isError).not.toBe(true);
  });
});
