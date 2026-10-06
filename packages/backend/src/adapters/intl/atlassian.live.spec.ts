import * as adapter from './atlassian.json';
import { localMcpToolName } from '../../connectors/mcp-connector-config.util';

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
});
