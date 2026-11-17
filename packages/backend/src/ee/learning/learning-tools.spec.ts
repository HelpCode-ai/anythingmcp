import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { McpEndpointController } from '../../mcp-server/mcp-endpoint.controller';
import { withRegistryIndexes } from '../../mcp-server/registry-test-double';
import {
  LEARNING_CONFIRM_TOOL,
  LEARNING_RECORD_TOOL,
  LEARNING_REVIEW_TOOL,
  READ_REMINDER_INTERVAL_MS,
  learningFooter,
  learningInstruction,
  readReminderDue,
  resetReadReminders,
} from './learning-tools';

const ACTIVE = {
  projectId: 'p1',
  organizationId: 'org-A',
  userId: 'u-expert',
  mcpServerId: 'srv-A',
  name: 'Old window "hardware"',
  consentAt: new Date('2026-11-15T10:00:00Z'),
  full: false,
  topics: [{ id: 't1', title: 'Old windows', whenToUse: 'Quotes for old windows' }],
};

const tool = (name: string, method: string, extra: Record<string, unknown> = {}) => ({
  id: name,
  name,
  connectorId: 'c1',
  description: `${name} tool`,
  parameters: { type: 'object', properties: {} },
  connectorType: 'REST',
  connectorConfig: { envVars: {} },
  endpointMapping: { method, path: `/${name}` },
  ...extra,
});

/** A real MCP client against the tool set the endpoint plans for one caller. */
async function connect(opts: { learning?: any; svc?: any; serverTools?: any[] }) {
  const svc =
    opts.svc ??
    ({
      activeFor: jest.fn(async () => ACTIVE),
      record: jest.fn(async () => ({ id: 'l1', topicId: 't1', topic: 'Old windows', lessonsInTopic: 3, repeated: false, large: false })),
      review: jest.fn(async () => ({ lessons: [{ id: 'l1', topic: 'Old windows', kind: 'rule', text: 'A rule', askWhy: false }], remaining: 0 })),
      confirm: jest.fn(async () => ({ confirmed: 1, rejected: 0, corrected: 0, notFound: [] })),
    } as any);
  const toolExecutor = { executeTool: jest.fn(async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] })) };
  const controller = new McpEndpointController(
    { findById: jest.fn() } as any,
    withRegistryIndexes({ getAllTools: jest.fn().mockReturnValue([]) }) as any,
    toolExecutor as any,
    { getAllowedToolIds: jest.fn() } as any,
    { lookup: jest.fn(), isEnabled: jest.fn(), captureIntentEnabled: jest.fn() } as any,
    { get: jest.fn(), add: jest.fn(), remove: jest.fn() } as any,
    { resolve: jest.fn().mockResolvedValue(null) } as any,
    { create: jest.fn(), hasVisible: jest.fn().mockResolvedValue(false) } as any,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    svc,
  );
  const entries = (controller as any).planToolSet({
    serverTools: opts.serverTools ?? [tool('get_quote', 'GET'), tool('create_quote', 'POST')],
    allowedToolIds: null,
    captureIntent: false,
    invocationContext: { organizationId: 'org-A', mcpServerId: 'srv-A', userId: 'u-expert' },
    learning: opts.learning,
  });
  const server = new McpServer({ name: 'spec', version: '1.0.0' });
  for (const e of entries) e.register(server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'spec', version: '1.0.0' });
  await client.connect(clientSide);
  return { client, svc, entries, toolExecutor };
}

const text = (result: any) => result.content.map((c: any) => c.text).join('\n');

describe('learning tools on the MCP endpoint', () => {
  it('offers nothing to a caller without an active project', async () => {
    const { client } = await connect({});
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['get_quote', 'create_quote']));
    expect(names.filter((n) => n.startsWith('learning_'))).toEqual([]);
    const result: any = await client.callTool({ name: 'create_quote', arguments: {} });
    expect(text(result)).not.toContain('Learning project');
  });

  it('offers the three tools to the project\'s member, with the project and its topics in the description', async () => {
    const { client } = await connect({ learning: ACTIVE });
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([LEARNING_RECORD_TOOL, LEARNING_REVIEW_TOOL, LEARNING_CONFIRM_TOOL]),
    );
    const record = tools.find((t) => t.name === LEARNING_RECORD_TOOL)!;
    // The name is admin text: quotes cannot break out of the sentence.
    expect(record.description).toContain(`Learning project "Old window 'hardware'" is on for this user: they agreed on 2026-11-15`);
    expect(record.description).toContain('No names of customers');
    expect((record.inputSchema as any).properties.topic.description).toContain(
      'Topics of this project: "Old windows" (Quotes for old windows)',
    );
    expect((record.inputSchema as any).required).toEqual(expect.arrayContaining(['topic', 'kind', 'text']));
    expect(tools.find((t) => t.name === LEARNING_REVIEW_TOOL)!.annotations?.readOnlyHint).toBe(true);
  });

  it('saves a lesson as reported by the model, for the project still active now', async () => {
    const { client, svc } = await connect({ learning: ACTIVE });
    const result: any = await client.callTool({
      name: LEARNING_RECORD_TOOL,
      arguments: { topic: 'Old windows', kind: 'correction', text: 'Take hinge BR-12103 for series 300', before: 'BR-99', after: 'BR-12103' },
    });
    expect(result.isError).toBeFalsy();
    expect(svc.activeFor).toHaveBeenCalledWith('org-A', 'u-expert', 'srv-A');
    expect(svc.record).toHaveBeenCalledWith(
      ACTIVE,
      expect.objectContaining({ topic: 'Old windows', kind: 'correction', before: 'BR-99', source: 'model' }),
    );
    const body = JSON.parse(text(result));
    expect(body).toEqual(expect.objectContaining({ saved: true, id: 'l1', topic: 'Old windows', lessonsInTopic: 3 }));
    expect(body.note).toContain('Tell the user in one sentence');
  });

  it('cannot be told by the model that a lesson came from somewhere else', async () => {
    const { client, svc } = await connect({ learning: ACTIVE });
    await client.callTool({
      name: LEARNING_RECORD_TOOL,
      arguments: { topic: 'Old windows', kind: 'rule', text: 'A rule the model reports', source: 'manual' },
    });
    expect(svc.record.mock.calls[0][1].source).toBe('model');
  });

  it('saves nothing once the project is no longer active, also in a session opened before', async () => {
    const svc = { activeFor: jest.fn(async () => null), record: jest.fn(), review: jest.fn(), confirm: jest.fn() };
    const { client } = await connect({ learning: ACTIVE, svc });
    for (const [name, args] of [
      [LEARNING_RECORD_TOOL, { topic: 'Old windows', kind: 'rule', text: 'A rule the model reports' }],
      [LEARNING_REVIEW_TOOL, {}],
      [LEARNING_CONFIRM_TOOL, { decisions: [{ id: 'l1', verdict: 'confirm' }] }],
    ] as const) {
      const result: any = await client.callTool({ name, arguments: args as any });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain('not active any more');
    }
    expect(svc.record).not.toHaveBeenCalled();
    expect(svc.confirm).not.toHaveBeenCalled();
  });

  it('answers a refused lesson with the reason, as an error the model can read', async () => {
    const svc = {
      activeFor: jest.fn(async () => ACTIVE),
      record: jest.fn(async () => {
        throw Object.assign(new Error('Bad Request'), { response: { message: 'Lessons never hold secrets.' } });
      }),
    };
    const { client } = await connect({ learning: ACTIVE, svc });
    const result: any = await client.callTool({
      name: LEARNING_RECORD_TOOL,
      arguments: { topic: 'Old windows', kind: 'rule', text: 'password: hunter2hunter2' },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toBe('Lessons never hold secrets.');
  });

  it('lists what waits for the user and records only the verdicts it is given, as that member', async () => {
    const { client, svc } = await connect({ learning: ACTIVE });
    const review: any = await client.callTool({ name: LEARNING_REVIEW_TOOL, arguments: { topic: 'Old windows' } });
    expect(JSON.parse(text(review)).next).toContain(LEARNING_CONFIRM_TOOL);
    expect(svc.review).toHaveBeenCalledWith(ACTIVE, { topic: 'Old windows' });

    const decisions = [{ id: 'l1', verdict: 'correct', text: 'Take hinge BR-12103 for series 300', reason: 'BR-99 is gone' }];
    const confirm: any = await client.callTool({ name: LEARNING_CONFIRM_TOOL, arguments: { decisions } });
    expect(svc.confirm).toHaveBeenCalledWith(ACTIVE, decisions, 'u-expert');
    expect(JSON.parse(text(confirm))).toEqual({ confirmed: 1, rejected: 0, corrected: 0, notFound: [] });
  });

  it('reminds the model after every tool that may change something, after a read at most every ten minutes', async () => {
    resetReadReminders();
    const { client } = await connect({ learning: ACTIVE });
    const read: any = await client.callTool({ name: 'get_quote', arguments: {} });
    expect(text(read)).toContain(learningFooter(ACTIVE as any));
    const readAgain: any = await client.callTool({ name: 'get_quote', arguments: {} });
    expect(text(readAgain)).not.toContain('Learning project');
    for (let i = 0; i < 2; i++) {
      const write: any = await client.callTool({ name: 'create_quote', arguments: {} });
      expect(text(write)).toContain(learningFooter(ACTIVE as any));
    }
  });

  it('never reminds a caller without a project, after a read or a write', async () => {
    resetReadReminders();
    const { client } = await connect({});
    for (const name of ['get_quote', 'create_quote']) {
      const r: any = await client.callTool({ name, arguments: {} });
      expect(text(r)).not.toContain('Learning project');
    }
  });

  it('re-registers a tool in a live session when the reminder appears or goes', async () => {
    for (const name of ['create_quote', 'get_quote']) {
      const plain = (await connect({})).entries.find((e: any) => e.name === name).sig;
      const withProject = (await connect({ learning: ACTIVE })).entries.find((e: any) => e.name === name).sig;
      expect(withProject).not.toBe(plain);
    }
  });

  it('leaves a connector tool that already has one of the names alone', async () => {
    const { client, svc } = await connect({
      learning: ACTIVE,
      serverTools: [tool(LEARNING_RECORD_TOOL, 'POST')],
    });
    const tools = (await client.listTools()).tools;
    expect(tools.filter((t) => t.name === LEARNING_RECORD_TOOL)).toHaveLength(1);
    expect(tools.find((t) => t.name === LEARNING_RECORD_TOOL)!.description).toContain('learning_record tool');
    await client.callTool({ name: LEARNING_RECORD_TOOL, arguments: {} });
    expect(svc.record).not.toHaveBeenCalled();
  });

  it('changes the record tool\'s signature when a topic is added, so its description refreshes', async () => {
    const one = (await connect({ learning: ACTIVE })).entries.find((e: any) => e.name === LEARNING_RECORD_TOOL).sig;
    const two = (
      await connect({ learning: { ...ACTIVE, topics: [...ACTIVE.topics, { id: 't2', title: 'Shutters', whenToUse: '' }] } })
    ).entries.find((e: any) => e.name === LEARNING_RECORD_TOOL).sig;
    expect(two).not.toBe(one);
    // Also when an admin changes when a topic applies.
    const reworded = (
      await connect({ learning: { ...ACTIVE, topics: [{ ...ACTIVE.topics[0], whenToUse: 'Spare parts' }] } })
    ).entries.find((e: any) => e.name === LEARNING_RECORD_TOOL).sig;
    expect(reworded).not.toBe(one);
  });
});

describe('readReminderDue', () => {
  it('is due once per interval and per project', () => {
    resetReadReminders();
    const t0 = 1_000_000;
    expect(readReminderDue('p1', t0)).toBe(true);
    expect(readReminderDue('p1', t0 + 1000)).toBe(false);
    expect(readReminderDue('p2', t0 + 1000)).toBe(true);
    expect(readReminderDue('p1', t0 + READ_REMINDER_INTERVAL_MS - 1)).toBe(false);
    expect(readReminderDue('p1', t0 + READ_REMINDER_INTERVAL_MS)).toBe(true);
  });
});

describe('learning texts', () => {
  it('tell the model who agreed, when, and what to call', () => {
    const instruction = learningInstruction(ACTIVE as any);
    expect(instruction.startsWith('## Learning project\n')).toBe(true);
    expect(instruction).toContain('they agreed on 2026-11-15');
    expect(instruction).toContain(LEARNING_RECORD_TOOL);
    expect(instruction).toContain('can stop it in their AnythingMCP profile');
    expect(learningFooter(ACTIVE as any)).toContain(`call ${LEARNING_RECORD_TOOL} before you continue`);
  });
});
