import { chatJson, resolveLlmConfig } from './llm-client';

const ENV_KEYS = [
  'KG_LLM_BASE_URL',
  'KG_LLM_API_KEY',
  'KG_LLM_MODEL',
  'KG_LLM_PROVIDER',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY',
];

function setEnv(vars: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined) process.env[k] = v;
  }
}

function okJson(body: any) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

describe('resolveLlmConfig', () => {
  afterEach(() => setEnv({}));

  it('returns null when nothing is configured', () => {
    setEnv({});
    expect(resolveLlmConfig()).toBeNull();
  });

  it('keeps the existing OpenAI behaviour without a base URL', () => {
    setEnv({ OPENAI_API_KEY: 'sk-x', KG_LLM_MODEL: 'gpt-4o-mini' });
    expect(resolveLlmConfig()).toEqual({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-x' });
  });

  it('routes to the custom endpoint when KG_LLM_BASE_URL is set', () => {
    setEnv({ KG_LLM_BASE_URL: 'http://localhost:11434/v1/', KG_LLM_MODEL: 'qwen2.5' });
    expect(resolveLlmConfig()).toEqual({
      provider: 'custom',
      model: 'qwen2.5',
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1',
    });
  });

  it('accepts an empty local key and keeps KG_LLM_MODEL', () => {
    setEnv({ KG_LLM_BASE_URL: 'http://localhost:1234/v1', KG_LLM_MODEL: 'llama3.1', KG_LLM_API_KEY: '' });
    const cfg = resolveLlmConfig()!;
    expect(cfg.provider).toBe('custom');
    expect(cfg.model).toBe('llama3.1');
    expect(cfg.apiKey).toBe('');
  });
});

describe('chatJson', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn();
  });
  afterEach(() => {
    global.fetch = realFetch;
    setEnv({});
    jest.restoreAllMocks();
  });

  it('custom endpoint: no Authorization header with an empty key, no response_format', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      okJson({ choices: [{ message: { content: '{"relationships":[]}' } }], usage: {} }),
    );
    const res = await chatJson(
      { provider: 'custom', model: 'qwen2.5', apiKey: '', baseUrl: 'http://localhost:11434/v1' },
      'sys',
      'user',
    );
    expect(res.json).toEqual({ relationships: [] });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect(init.headers.Authorization).toBeUndefined();
    const body = JSON.parse(init.body);
    expect(body.response_format).toBeUndefined();
    expect(body.messages[0].content).toContain('Respond with a single JSON object');
  });

  it('custom endpoint: sends Authorization when a key is configured', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      okJson({ choices: [{ message: { content: '{}' } }], usage: {} }),
    );
    await chatJson(
      { provider: 'custom', model: 'm', apiKey: 'secret', baseUrl: 'http://host/v1' },
      'sys',
      'user',
    );
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer secret');
    expect(JSON.parse(init.body).response_format).toBeUndefined();
  });

  it('custom endpoint: unusable JSON resolves an explicit skip, not an empty answer', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      okJson({ choices: [{ message: { content: 'Sure, here are some thoughts...' } }], usage: {} }),
    );
    const res = await chatJson(
      { provider: 'custom', model: 'qwen2.5', apiKey: '', baseUrl: 'http://localhost:11434/v1' },
      'sys',
      'user',
    );
    expect(res).toEqual({ json: null, skipped: true });
  });

  it('openai path still sends response_format and Authorization', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      okJson({ choices: [{ message: { content: '{}' } }], usage: {} }),
    );
    await chatJson({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-x' }, 'sys', 'user');
    const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-x');
    expect(JSON.parse(init.body).response_format).toEqual({ type: 'json_object' });
  });

  it('hosted paths still throw on unusable JSON', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      okJson({ choices: [{ message: { content: 'not json' } }], usage: {} }),
    );
    await expect(
      chatJson({ provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-x' }, 'sys', 'user'),
    ).rejects.toThrow();
  });

  const anthropic = { provider: 'anthropic' as const, model: 'claude-haiku-4-5', apiKey: 'k' };
  const anthropicReply = (text: string, stop_reason = 'end_turn') =>
    okJson({ content: [{ type: 'text', text }], stop_reason, usage: { input_tokens: 1, output_tokens: 2 } });

  it('anthropic: retries once with a higher limit when the reply hits max_tokens', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce(anthropicReply('{"links": [{"a":', 'max_tokens'))
      .mockResolvedValueOnce(anthropicReply('{"links": []}'));
    const res = await chatJson(anthropic, 'sys', 'user');
    expect(res.json).toEqual({ links: [] });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    const limits = (global.fetch as jest.Mock).mock.calls.map(([, init]) => JSON.parse(init.body).max_tokens);
    expect(limits).toEqual([4000, 8000]);
  });

  it('anthropic: does not retry a complete reply', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(anthropicReply('{"ok": true}'));
    const res = await chatJson(anthropic, 'sys', 'user');
    expect(res.json).toEqual({ ok: true });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('anthropic: a reply still cut off after the retry throws a readable error', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(anthropicReply('{"links": [', 'max_tokens'));
    await expect(chatJson(anthropic, 'sys', 'user')).rejects.toThrow(/cut off at the token limit/);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
