import { registerDemoTools } from './mcp-demo.tools';

type Registered = {
  config: { description?: string; inputSchema?: { safeParse: (v: unknown) => { success: boolean } } };
  handler: (args: any) => Promise<{ content: { type: string; text: string }[] }>;
};

function collectTools(): Map<string, Registered> {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool: (name: string, config: Registered['config'], handler: Registered['handler']) => {
      tools.set(name, { config, handler });
    },
  };
  registerDemoTools(server as any);
  return tools;
}

describe('demo tools: anythingmcp_connect_client', () => {
  const tool = collectTools().get('anythingmcp_connect_client')!;

  it.each(['claude', 'chatgpt', 'muse', 'gemini', 'copilot', 'cursor'])('accepts %s', (client) => {
    expect(tool.config.inputSchema!.safeParse({ client }).success).toBe(true);
  });

  it('refuses a client it has no instructions for', () => {
    expect(tool.config.inputSchema!.safeParse({ client: 'unknown' }).success).toBe(false);
  });

  it('gives Meta Muse its own instructions', async () => {
    const result = await tool.handler({ client: 'muse' });
    const text = result.content[0].text;
    expect(text).toMatch(/^Meta Muse:/);
    expect(text).toContain('Settings → Connectors');
  });

  it('points Claude users at the Claude Directory', async () => {
    const result = await tool.handler({ client: 'claude' });
    expect(result.content[0].text).toContain('https://claude.ai/directory/anythingmcp');
  });

  it('lists Meta Muse among the clients in the description', () => {
    expect(tool.config.description).toContain('Meta Muse');
  });
});
