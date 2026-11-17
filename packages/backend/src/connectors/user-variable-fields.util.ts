import { getAdapter } from '../adapters/catalog';
import { describeAdapterEnvVars, labelFromName, type EnvVarOption } from '../adapters/env-var-meta';
import { isSecretName } from './connector-secrets.util';
import { userVariableNames } from './user-credential.util';

/**
 * One per-user variable as a form shows it (the connect page, the dashboard):
 * its label and help from the catalog adapter when the connector has one,
 * else derived from the name. Never a value.
 */
export interface UserVariableField {
  name: string;
  label: string;
  /** Typed into a password field, and never shown back. */
  secret: boolean;
  help?: string;
  example?: string;
  options?: EnvVarOption[];
}

export function describeUserVariables(config: unknown): UserVariableField[] {
  const names = userVariableNames(config);
  if (names.length === 0) return [];
  const slug = (config as { adapterSlug?: unknown } | null | undefined)?.adapterSlug;
  const adapter = typeof slug === 'string' ? getAdapter(slug) : undefined;
  const described = new Map((adapter ? describeAdapterEnvVars(adapter) : []).map((d) => [d.name, d]));
  return names.map((name) => {
    const known = described.get(name);
    if (!known) {
      return { name, label: labelFromName(name, typeof slug === 'string' ? slug : undefined), secret: isSecretName(name) };
    }
    return {
      name,
      label: known.label,
      secret: known.secret,
      ...(known.help ? { help: known.help } : {}),
      ...(known.example ? { example: known.example } : {}),
      ...(known.options ? { options: known.options } : {}),
    };
  });
}
