import type { AdapterDefinition } from './catalog';

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
