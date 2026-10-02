/**
 * Minimal provider-agnostic LLM client for KG enrichment.
 * Supports OpenAI, OpenRouter (OpenAI-compatible), Anthropic, and a custom
 * OpenAI-compatible base URL for local models (Ollama, LM Studio, ...).
 * No SDK — just fetch — so it adds no dependencies. JSON-only responses.
 */
import { Logger } from '@nestjs/common';

const logger = new Logger('KgLlmClient');

export interface LlmConfig {
  provider: 'openai' | 'openrouter' | 'anthropic' | 'custom';
  model: string;
  /** Empty on the custom path: Ollama/LM Studio need no key. */
  apiKey: string;
  /** Set on the custom path from KG_LLM_BASE_URL (trailing slashes trimmed). */
  baseUrl?: string;
}

/**
 * Resolve provider/model/key from env, or null when nothing is configured.
 * KG_LLM_BASE_URL takes precedence and selects the custom OpenAI-compatible
 * path: no API key is required, KG_LLM_API_KEY is optional.
 */
export function resolveLlmConfig(): LlmConfig | null {
  const customBase = (process.env.KG_LLM_BASE_URL || '').trim().replace(/\/+$/, '');
  if (customBase) {
    return {
      provider: 'custom',
      model: process.env.KG_LLM_MODEL || 'qwen2.5',
      apiKey: process.env.KG_LLM_API_KEY || '',
      baseUrl: customBase,
    };
  }
  const provider = (process.env.KG_LLM_PROVIDER || 'openai').toLowerCase() as LlmConfig['provider'];
  const apiKey =
    provider === 'openrouter'
      ? process.env.OPENROUTER_API_KEY
      : provider === 'anthropic'
        ? process.env.ANTHROPIC_API_KEY
        : process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const model =
    process.env.KG_LLM_MODEL ||
    // Anthropic default: Haiku 4.5 (claude-3-5-haiku was retired Feb 2026).
    (provider === 'anthropic' ? 'claude-haiku-4-5' : 'gpt-4o-mini');
  return { provider, model, apiKey };
}

export interface LlmResult {
  json: any;
  /** Custom path only: the reply was not usable JSON, so there is nothing to
   *  apply. Callers must return early without persisting anything. */
  skipped?: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
}

/**
 * Output-token ceiling for a single enrichment / skill pass. The graph is
 * capped at MAX_ENTITIES (120) and a dense graph can emit dozens of relations,
 * so a verbose model needs headroom: at 1500 the JSON gets truncated mid-array
 * and the whole pass fails to parse. ~3K is the observed worst case on Haiku.
 */
export const KG_LLM_MAX_OUTPUT_TOKENS = 4000;

/** Call the model and parse its reply as JSON. Throws on transport/parse error,
 *  except on the custom path where an unusable reply resolves
 *  `{ json: null, skipped: true }` so callers can return early without
 *  persisting anything (no hash update, no suggestion replacement). */
export async function chatJson(
  cfg: LlmConfig,
  system: string,
  user: string,
  maxTokens = KG_LLM_MAX_OUTPUT_TOKENS,
): Promise<LlmResult> {
  if (cfg.provider === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: maxTokens,
        temperature: 0,
        // System prompt as a cacheable block: the instructions are identical
        // across calls, so prompt caching serves them at ~0.1x on repeats.
        // (Only kicks in once the prefix passes the model's cache minimum;
        // harmless otherwise.) OpenAI/OpenRouter cache automatically.
        system: [
          {
            type: 'text',
            text: system + '\nRespond with a single JSON object and nothing else.',
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const text = j.content?.[0]?.text ?? '{}';
    return {
      json: JSON.parse(stripFences(text)),
      usage: { inputTokens: j.usage?.input_tokens, outputTokens: j.usage?.output_tokens },
    };
  }

  const base =
    cfg.provider === 'openrouter'
      ? 'https://openrouter.ai/api/v1'
      : cfg.provider === 'custom'
        ? (cfg.baseUrl ?? '').replace(/\/+$/, '')
        : 'https://api.openai.com/v1';
  // Local models often lack JSON mode: never send response_format there and
  // rely on the prompt plus the shared parsing instead. The Authorization
  // header stays unconditional on the hosted paths and is only omitted on
  // the custom path when no key is configured (Ollama/LM Studio need none).
  const headers: Record<string, string> =
    cfg.provider === 'custom' && !cfg.apiKey
      ? { 'Content-Type': 'application/json' }
      : { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' };
  const r = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      max_tokens: maxTokens,
      ...(cfg.provider === 'custom'
        ? {}
        : { response_format: { type: 'json_object' } }),
      messages: [
        {
          role: 'system',
          content:
            cfg.provider === 'custom'
              ? system + '\nRespond with a single JSON object and nothing else.'
              : system,
        },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const text = j.choices?.[0]?.message?.content ?? '{}';
  try {
    return {
      json: JSON.parse(stripFences(text)),
      usage: { inputTokens: j.usage?.prompt_tokens, outputTokens: j.usage?.completion_tokens },
    };
  } catch {
    if (cfg.provider !== 'custom') throw new Error(`LLM returned unusable JSON: ${String(text).slice(0, 200)}`);
    logger.warn(
      `KG LLM custom endpoint returned unusable JSON (model=${cfg.model} endpoint=${endpointOrigin(base)}); skipping this pass.`,
    );
    return { json: null, skipped: true };
  }
}

/** Origin only (scheme + host + port) so credentials, paths and query data
 *  in a custom base URL can never leak into the logs. Falls back to a fixed
 *  marker when the base is not a parseable URL. */
function endpointOrigin(base: string): string {
  try {
    return new URL(base).origin;
  } catch {
    return '(unparseable endpoint)';
  }
}

export interface BatchRequest {
  customId: string;
  system: string;
  user: string;
  maxTokens?: number;
}

/**
 * Submit a Message Batch (Anthropic only) — processed asynchronously at ~50% of
 * standard price. Returns the provider batch id to poll later. Used by the cloud
 * cron for the (non-latency-sensitive) graph/skill extension.
 */
export async function submitBatch(
  cfg: LlmConfig,
  requests: BatchRequest[],
): Promise<string> {
  if (cfg.provider !== 'anthropic') {
    throw new Error('Batch mode currently supports the anthropic provider only.');
  }
  const body = {
    requests: requests.map((r) => ({
      custom_id: r.customId,
      params: {
        model: cfg.model,
        max_tokens: r.maxTokens ?? KG_LLM_MAX_OUTPUT_TOKENS,
        temperature: 0,
        system: [
          {
            type: 'text',
            text: r.system + '\nRespond with a single JSON object and nothing else.',
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [{ role: 'user', content: r.user }],
      },
    })),
  };
  const res = await fetch('https://api.anthropic.com/v1/messages/batches', {
    method: 'POST',
    headers: {
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Batch submit ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return j.id as string;
}

/** Poll a batch; when ended, fetch + parse its JSONL results. */
export async function getBatchResults(
  cfg: LlmConfig,
  externalId: string,
): Promise<{ done: boolean; results: Array<{ customId: string; json: any }> }> {
  const headers = { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' };
  const res = await fetch(
    `https://api.anthropic.com/v1/messages/batches/${externalId}`,
    { headers },
  );
  if (!res.ok) throw new Error(`Batch get ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  if (j.processing_status !== 'ended' || !j.results_url) {
    return { done: false, results: [] };
  }
  const rres = await fetch(j.results_url, { headers });
  if (!rres.ok) throw new Error(`Batch results ${rres.status}`);
  const text = await rres.text();
  const results: Array<{ customId: string; json: any }> = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row?.result?.type === 'succeeded') {
      const t = row.result.message?.content?.[0]?.text ?? '{}';
      try {
        results.push({ customId: row.custom_id, json: JSON.parse(stripFences(t)) });
      } catch {
        /* skip malformed */
      }
    }
  }
  return { done: true, results };
}

function stripFences(text: string): string {
  const t = text.trim();
  if (t.startsWith('```')) {
    return t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  }
  return t;
}
