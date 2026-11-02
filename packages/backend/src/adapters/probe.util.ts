import type { AdapterDefinition, ProbeFailRule } from './catalog';

/**
 * Which call proves a freshly imported connector works.
 *
 * Until now the first time anyone learned that a pasted token was wrong was
 * when the agent said so — 63 of the 246 workspaces stuck at "attached, never
 * called" had only ever seen upstream 401/403s from their own credentials.
 * The probe runs the same engine the agent will, right after import, while
 * the user is still on the form with the value in front of them.
 *
 * Shared with scripts/probe-keyless.mjs, which uses the same `probe` field to
 * check keyless adapters from a datacenter IP in CI. Keep the two in step.
 */
export interface ProbeCall {
  toolName: string;
  params: Record<string, unknown>;
}

type ProbeTool = AdapterDefinition['tools'][number];

export function pickProbe(adapter: {
  probe?: { tool: string; params?: Record<string, unknown> };
  tools: ProbeTool[];
}): ProbeCall | null {
  if (adapter.probe?.tool) {
    const tool = adapter.tools.find((t) => t.name === adapter.probe!.tool);
    if (!tool) return null;
    return { toolName: tool.name, params: materialise(adapter.probe.params ?? {}) };
  }
  // No declared probe: the first GET with nothing required is the safest call
  // there is. Defaults are passed so optional-but-defaulted params are sent.
  const tool = adapter.tools.find((t) => {
    const em = t.endpointMapping as { method?: string; path?: unknown };
    const params = t.parameters as { required?: string[] } | undefined;
    return (
      String(em?.method ?? '').toUpperCase() === 'GET' &&
      typeof em?.path === 'string' &&
      (params?.required ?? []).length === 0
    );
  });
  if (!tool) return null;
  const props = ((tool.parameters as { properties?: Record<string, { default?: unknown }> })
    ?.properties ?? {}) as Record<string, { default?: unknown }>;
  const params: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(props)) {
    if (p && p.default !== undefined) params[k] = p.default;
  }
  return { toolName: tool.name, params };
}

/** `__TOMORROW__` inside a string → tomorrow as YYYY-MM-DD. */
export function materialise(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = typeof v === 'string' ? v.replaceAll('__TOMORROW__', tomorrow) : v;
  }
  return out;
}

/** What a probe that answered still says is wrong, for the setup form. */
export interface ProbeResultFailure {
  kind: string;
  message: string;
  /** The variable the message belongs under. */
  field?: string;
}

/**
 * The text of a probe's answer: for a remote MCP tool, the text of its
 * content (where its JSON is, as a string), else the answer as JSON.
 */
export function probeResultText(raw: unknown): string {
  const content = (raw as { content?: unknown } | null)?.content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((c) => c && typeof c === 'object' && (c as { type?: unknown }).type === 'text')
      .map((c) => String((c as { text?: unknown }).text ?? ''));
    const structured = (raw as { structuredContent?: unknown }).structuredContent;
    if (structured !== undefined) texts.push(safeStringify(structured));
    return texts.join('\n');
  }
  return typeof raw === 'string' ? raw : safeStringify(raw);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/**
 * A probe call that returned without throwing but cannot count as a working
 * connector:
 *  - an answer one of the adapter's `probe.failWhen` rules matches (Atlassian's
 *    `discover` returns an empty product list for an API token without scopes);
 *  - a remote MCP tool that answered `isError: true` (the server refused the
 *    call inside a 200).
 * A matching rule's hint comes first, the server's own words follow it.
 */
export function probeResultFailure(
  adapter: { probe?: { failWhen?: ProbeFailRule[] } },
  raw: unknown,
): ProbeResultFailure | null {
  const text = probeResultText(raw);
  // The MCP tool-result shape only: a REST body with an `isError` field is data.
  const isError =
    (raw as { isError?: unknown } | null)?.isError === true &&
    Array.isArray((raw as { content?: unknown }).content);
  const excerpt = text.replace(/\s+/g, ' ').trim().slice(0, 300);
  for (const rule of adapter.probe?.failWhen ?? []) {
    let re: RegExp;
    try {
      re = new RegExp(rule.matches, 'i');
    } catch {
      continue;
    }
    if (!re.test(text)) continue;
    return {
      kind: rule.kind ?? 'auth_failed',
      message: excerpt ? `${rule.hint} (${excerpt})` : rule.hint,
      ...(rule.field ? { field: rule.field } : {}),
    };
  }
  if (isError) {
    return {
      kind: 'upstream_error',
      message: `The server refused the check call: ${excerpt || 'no reason given'}`,
    };
  }
  return null;
}
