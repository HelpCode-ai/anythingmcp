import * as adapter from './jev.json';
import axios from 'axios';
import { z } from 'zod';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { McpEndpointController } from '../../mcp-server/mcp-endpoint.controller';

/**
 * Two layers of verification for the Jev (TypeSafe) adapter:
 *
 *   1. Static — always runs. Pins the request bodies the three single-question
 *      tools build (the API wants `model` on every call, calls a yes/no
 *      question `noul`, and takes score levels as an array), that an optional
 *      yes/no criterion the caller left out is dropped instead of sent as
 *      null, and that every tool is marked read-only.
 *
 *   2. Live — skipped unless TYPESAFE_API_KEY is set. Calls the real API once
 *      per tool plus the error paths an agent will hit:
 *
 *        TYPESAFE_API_KEY=... npx jest src/adapters/intl/jev.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  parameters: { properties: Record<string, { default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; staticResponse?: string };
  responseMapping?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
};

const a = adapter as unknown as {
  requiredEnvVars: string[];
  probe: { tool: string };
  connector: { baseUrl: string; authType: string; authConfig: { token: string } };
  tools: Tool[];
};

const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

// What DynamicMcpTools.applyDefaults does before the engine sees the params.
const withDefaults = (t: Tool, params: Record<string, unknown>) => {
  const out = { ...params };
  for (const [k, p] of Object.entries(t.parameters.properties)) {
    if (out[k] === undefined && p.default !== undefined) out[k] = p.default;
  }
  return out;
};

const engine = () => new RestEngine({} as OAuth2TokenService, {} as LoginTokenService);
const config = (token: string) => ({
  baseUrl: a.connector.baseUrl,
  authType: a.connector.authType,
  authConfig: { token },
});

const run = async (name: string, params: Record<string, unknown>, token = 'k') => {
  const t = tool(name);
  const raw = await engine().execute(config(token), t.endpointMapping as any, withDefaults(t, params));
  return t.responseMapping
    ? (applyResponseTransform(raw, t.responseMapping as any).value as any)
    : (raw as any);
};

const lastRequest = () =>
  mockedAxios.mock.calls[mockedAxios.mock.calls.length - 1][0] as {
    url: string;
    method: string;
    data: any;
    headers: Record<string, string>;
  };

describe('jev adapter — static spec conformance', () => {
  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockResolvedValue({ status: 200, data: { answers: {} }, headers: {} });
  });

  it('needs only the API key, sent as a bearer token', async () => {
    expect(a.requiredEnvVars).toEqual(['TYPESAFE_API_KEY']);
    expect(a.connector.authConfig.token).toBe('{{TYPESAFE_API_KEY}}');
    await run('jev_list_models', {}, 'secret');
    expect(lastRequest().url).toBe('https://api.typesafe.ai/v1/models');
    expect(lastRequest().headers.Authorization).toBe('Bearer secret');
  });

  it('jev_yes_no sends one noul with the default model and drops unset criteria', async () => {
    await run('jev_yes_no', { state: { a: 1 }, question: 'Is a set?' });
    expect(lastRequest().data).toEqual({
      state: { a: 1 },
      model: 'jev-latest',
      questions: { answer: { type: 'noul', instructions: 'Is a set?', criteria: {} } },
    });
    await run('jev_yes_no', { state: 'x', question: 'q', yes_means: 'y', model: 'jev-1.13.0' });
    expect(lastRequest().data.model).toBe('jev-1.13.0');
    expect(lastRequest().data.questions.answer.criteria).toEqual({ true: 'y' });
  });

  it('jev_classify and jev_rate pass options as an object and levels as an array', async () => {
    await run('jev_classify', { state: 's', question: 'q', options: { b: null, a: 'x' } });
    expect(lastRequest().data.questions.answer).toEqual({
      type: 'choice',
      instructions: 'q',
      criteria: { b: null, a: 'x' },
    });
    await run('jev_rate', { state: 's', question: 'q', levels: ['low', 'high'] });
    expect(lastRequest().data.questions.answer.criteria).toEqual(['low', 'high']);
  });

  it('jev_ask forwards the questions map untouched', async () => {
    const questions = { u: { type: 'noul', instructions: { q: 'Is `x` set?', x: [1, 2] } } };
    await run('jev_ask', { state: ['a', 'b'], questions });
    expect(lastRequest().data).toEqual({ state: ['a', 'b'], model: 'jev-latest', questions });
  });

  it('marks every network tool read-only (POST would otherwise derive as a write)', () => {
    for (const t of a.tools.filter((x) => x.endpointMapping.method !== 'static')) {
      const ann = deriveToolAnnotations({
        name: t.name,
        connectorType: 'REST',
        endpointMapping: t.endpointMapping,
        annotations: t.annotations,
      });
      expect([t.name, ann.readOnlyHint]).toEqual([t.name, true]);
    }
  });

  it('the probe tool is a free GET', () => {
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
  });

  it('what an MCP client sees: state accepts any JSON, options an object, levels an array', () => {
    const shape = (McpEndpointController.prototype as any).jsonSchemaToZodShape.call(
      {},
      tool('jev_classify').parameters,
    );
    const schema = z.object(shape);
    expect(schema.safeParse({ state: 'text', question: 'q', options: { a: null } }).success).toBe(true);
    expect(schema.safeParse({ state: { t: 1 }, question: 'q', options: { a: 'x' } }).success).toBe(true);
    expect(schema.safeParse({ state: 's', question: 'q', options: ['a'] }).success).toBe(false);
  });
});

const live = process.env.TYPESAFE_API_KEY ? describe : describe.skip;

live('jev adapter — live against api.typesafe.ai', () => {
  const key = process.env.TYPESAFE_API_KEY as string;
  jest.setTimeout(30000);
  beforeEach(() => {
    mockedAxios.mockReset();
    mockedAxios.mockImplementation((cfg: unknown) => mockedAxios.__actual(cfg as any));
  });

  const ticket = {
    ticket: {
      subject: 'Payouts failing',
      body: 'Help! My payouts have been failing for 3 days and my suppliers are waiting.',
    },
  };

  it('jev_list_models', async () => {
    const out = await run('jev_list_models', {}, key);
    expect(out.models.map((m: any) => m.name)).toContain('jev-latest');
  });

  it('jev_yes_no', async () => {
    const out = await run('jev_yes_no', { state: ticket, question: 'Does `ticket` report a problem that blocks the customer right now?' }, key);
    expect(out.yes_probability).toBeGreaterThan(0.8);
    expect(out.model).toMatch(/^jev-/);
  });

  it('jev_classify', async () => {
    const out = await run(
      'jev_classify',
      {
        state: ticket,
        question: 'Which team should handle `ticket`?',
        options: { billing: 'payments, payouts, refunds', technical: 'bugs, outages', sales: 'pricing', none: 'nothing fits' },
      },
      key,
    );
    expect(out.choice).toBe('billing');
    expect(Object.keys(out.probabilities).sort()).toEqual(['billing', 'none', 'sales', 'technical']);
  });

  it('jev_rate', async () => {
    const out = await run(
      'jev_rate',
      { state: ticket, question: 'How frustrated is the customer?', levels: ['calm', 'annoyed', 'frustrated', 'furious'] },
      key,
    );
    expect(out.score).toBeGreaterThanOrEqual(1);
    expect(out.legend['0']).toBe('calm');
  });

  it('jev_ask with three question types and a German state', async () => {
    const out = await run(
      'jev_ask',
      {
        state: { email: 'Die gelieferte Tür (Auftrag 55120) ist beschädigt angekommen. Bitte um Ersatz bis Freitag.' },
        questions: {
          complaint: { type: 'noul', instructions: 'Is `email` a complaint about a delivered product?' },
          wants: { type: 'choice', instructions: 'What does `email` ask for?', criteria: { replacement: null, refund: null, information: null, other: null } },
          urgency: { type: 'score', instructions: 'How urgent is `email`?', criteria: ['no deadline', 'weeks', 'days', 'today'] },
        },
      },
      key,
    );
    expect(out.answers.complaint.noul).toBeGreaterThan(0.8);
    expect(out.answers.wants.choice).toBe('replacement');
    expect(out.answers.urgency.type).toBe('score');
  });

  it('a wrong question type comes back as a readable error', async () => {
    await expect(
      run('jev_ask', { state: 'x', questions: { a: { type: 'bool', instructions: 'Is it x?' } } }, key),
    ).rejects.toThrow(/400/);
  });

  it('a bad key is a 401', async () => {
    await expect(run('jev_list_models', {}, 'apikey_invalid')).rejects.toThrow(/401/);
  });
});
