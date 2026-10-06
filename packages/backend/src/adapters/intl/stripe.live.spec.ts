import * as adapter from './stripe.json';
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
  category: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern: string }>;
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, string>;
    config: { mcpToolPrefix: string; mcpPath?: string };
  };
  tools: Tool[];
};

describe('stripe adapter: static spec conformance', () => {
  it("bridges Stripe's official MCP server at the host root with the agent key as a Bearer token", () => {
    expect(a.connector.type).toBe('MCP');
    expect(a.connector.baseUrl).toBe('https://mcp.stripe.com');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{STRIPE_AGENT_KEY}}' });
    expect(a.connector.config).toEqual({ mcpToolPrefix: 'stripe_', mcpPath: '/' });
    expect(a.requiredEnvVars).toEqual(['STRIPE_AGENT_KEY']);
    expect(a.category).toBe('payments');
  });

  it('accepts restricted agent keys and refuses secret keys', () => {
    // Built at run time: a literal key-shaped string trips secret scanning.
    const fake = (kind: string, mode: string) => `${kind}_${mode}_${'51Nq8xQKz2bLm7RtYv0aFhC3d'}`;
    const re = new RegExp(a.envVarMeta.STRIPE_AGENT_KEY.pattern);
    expect(re.test(fake('rk', 'live'))).toBe(true);
    expect(re.test(fake('rk', 'test'))).toBe(true);
    expect(re.test(fake('sk', 'live'))).toBe(false);
    expect(re.test(fake('sk', 'test'))).toBe(false);
  });

  it('names each tool with the prefix and calls it by its remote name at the root path', () => {
    for (const t of a.tools) {
      expect(t.name).toBe(localMcpToolName(t.endpointMapping.method, a.connector.config.mcpToolPrefix));
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(t.endpointMapping.path).toBe('/');
    }
    expect(a.tools.map((t) => t.endpointMapping.method)).toEqual(
      expect.arrayContaining([
        'stripe_api_search',
        'stripe_api_details',
        'stripe_api_read',
        'stripe_api_write',
        'get_stripe_account_info',
        'stripe_analytics',
        'get_balance_summary',
        'search_stripe_documentation',
        'stripe_implementation_planner',
        'send_stripe_feedback',
      ]),
    );
  });

  it('ships the generic write tool and the feedback tool switched off', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.endpointMapping.method);
    expect(off.sort()).toEqual(['send_stripe_feedback', 'stripe_api_write']);
    const write = a.tools.find((t) => t.endpointMapping.method === 'stripe_api_write');
    expect(write?.annotations?.destructiveHint).toBe(true);
    for (const t of a.tools.filter((x) => x.annotations?.destructiveHint === true)) {
      expect(t.enabled).toBe(false);
    }
  });

  it('documents agent keys, approvals and Connect in the instructions', () => {
    expect(a.instructions).toContain('Authorizing agent access to your account');
    expect(a.instructions).toContain('31 October 2026');
    expect(a.instructions).toContain('approval URL');
    expect(a.instructions).toContain('Stripe-Account: acct_');
    expect(a.instructions).toContain('MCP and CLI access');
  });

  it('uses no em or en dashes', () => {
    expect(JSON.stringify(adapter)).not.toMatch(/[\u2013\u2014]/);
  });
});
