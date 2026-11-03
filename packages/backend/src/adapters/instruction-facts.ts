import { getAdapter } from './catalog';
import { describeAdapterEnvVars } from './env-var-meta';
import { isSecretName } from '../connectors/connector-secrets.util';

/**
 * A catalog connector's instructions as a model is given them: the stored
 * instructions, then the adapter's `instructionFacts` this connector can fill
 * in ("This workspace's Atlassian site is acme.atlassian.net, cloudId …").
 *
 * WHY. Stored instructions are the catalog's text for every workspace, and
 * {{VAR}} in them is never resolved: a per-workspace fact written into them at
 * install would also read as a user edit and stop "Apply update" from
 * refreshing them. The facts are rendered at serve time from the catalog and
 * the connector's variables instead, so they reach connectors installed
 * before the fact existed and follow an edit of the variable.
 *
 * Only non-secret values are ever rendered: a fact naming a variable the
 * adapter marks secret, or whose name reads like a secret, is left out. A
 * fact whose variables are not all set is left out too, so the catalog text
 * says what to do without it.
 */
export function connectorInstructions(connector: {
  instructions: string | null;
  envVars?: unknown;
  config?: unknown;
}): string | null {
  const facts = connectorFacts(connector);
  if (facts.length === 0) return connector.instructions;
  const own = connector.instructions?.trim();
  return [own, facts.join(' ')].filter(Boolean).join('\n\n');
}

/** The adapter's facts this connector fills in, rendered. */
export function connectorFacts(connector: { envVars?: unknown; config?: unknown }): string[] {
  const slug = (connector.config as { adapterSlug?: unknown } | null | undefined)?.adapterSlug;
  const adapter = typeof slug === 'string' ? getAdapter(slug) : null;
  const templates = adapter?.instructionFacts;
  if (!adapter || !templates?.length) return [];
  const env = (connector.envVars ?? {}) as Record<string, unknown>;
  const secret = new Set(
    describeAdapterEnvVars(adapter)
      .filter((d) => d.secret)
      .map((d) => d.name),
  );
  const out: string[] = [];
  for (const template of templates) {
    let complete = true;
    const text = template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, name: string) => {
      const value = env[name];
      if (secret.has(name) || isSecretName(name) || typeof value !== 'string' || !value.trim()) {
        complete = false;
        return '';
      }
      // One line of plain text: a value cannot add Markdown structure.
      return value.trim().replace(/[\r\n`]+/g, ' ');
    });
    if (complete) out.push(text);
  }
  return out;
}
