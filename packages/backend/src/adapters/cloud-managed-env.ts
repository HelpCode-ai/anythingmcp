/**
 * Adapter env vars the operator provides for everyone.
 *
 * Some adapters need a URL that is an infrastructure decision rather than a
 * credential: the Deutsche Bahn adapter needs a MOTIS instance, and the cloud
 * runs one next to the app. Asking every cloud user to type
 * `http://motis:8080` into an install form would be absurd — and a self-hoster
 * who enabled the bundled `motis` compose profile is in the same position.
 *
 * So when the operator sets the matching backend env var, the adapter var is
 * filled in at import and hidden from the install form. When it is unset the
 * adapter behaves as any other: the form asks for the value.
 *
 * Keyed on the env var, not on DEPLOYMENT_MODE, so the same mechanism serves
 * cloud and a self-host that runs the optional service.
 */
const MANAGED: ReadonlyArray<{ adapterVar: string; envVar: string }> = [
  { adapterVar: 'MOTIS_URL', envVar: 'MOTIS_INTERNAL_URL' },
];

/** The adapter vars the operator has provided, with their values. */
export function operatorProvidedEnvVars(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { adapterVar, envVar } of MANAGED) {
    const value = env[envVar]?.trim();
    if (value) out[adapterVar] = value.replace(/\/+$/, '');
  }
  return out;
}

/** Strip operator-provided vars from an install-form prompt list. */
export function withoutOperatorProvided(
  vars: string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] | undefined {
  if (!vars) return vars;
  const provided = operatorProvidedEnvVars(env);
  return vars.filter((v) => !(v in provided));
}

/**
 * Merge operator-provided values into the credentials an import was given.
 * The operator's value wins: a user cannot point a cloud connector at a MOTIS
 * of their choosing by posting `MOTIS_URL` in the request body, which would
 * otherwise turn the connector into an SSRF vector aimed at the internal
 * network.
 */
export function withOperatorProvided(
  credentials: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  const provided = operatorProvidedEnvVars(env);
  if (Object.keys(provided).length === 0) return credentials;
  return { ...(credentials ?? {}), ...provided };
}
