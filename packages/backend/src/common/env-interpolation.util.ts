/**
 * Environment Variable Interpolation Utility.
 *
 * Replaces {{VAR_NAME}} patterns in strings, objects, and nested structures
 * with values from an environment variables map. This enables Postman-style
 * variable substitution at runtime.
 *
 * Usage:
 *   const envVars = { API_KEY: 'abc123', BASE_URL: 'https://api.example.com' };
 *   interpolate('{{BASE_URL}}/v1/users', envVars) → 'https://api.example.com/v1/users'
 */

const VAR_PATTERN = /\{\{([^}]+)\}\}/g;

export interface InterpolateOptions {
  /**
   * Namespace prefix (e.g. `amcp.`) whose variables are resolved by the server
   * rather than by the workspace. A variable under this prefix that has no
   * value resolves to an empty string instead of being left verbatim, so an
   * unresolved placeholder is never sent to the target system.
   */
  reservedPrefix?: string;
}

/**
 * Interpolate {{VAR}} patterns in a string.
 *
 * An unknown variable is left as-is (so a stray `{{` in a template survives) —
 * except under `reservedPrefix`, which always resolves.
 */
export function interpolateString(
  template: string,
  envVars: Record<string, string>,
  options?: InterpolateOptions,
): string {
  // Callers pass optional fields (e.g. a static tool's endpointMapping has no
  // `path`). Guard against a non-string template so interpolation never throws
  // "Cannot read properties of undefined (reading 'replace')".
  if (typeof template !== 'string') return template;
  const reservedPrefix = options?.reservedPrefix;
  return template.replace(VAR_PATTERN, (match, varName) => {
    const trimmed = varName.trim();
    if (envVars[trimmed] !== undefined) return envVars[trimmed];
    if (reservedPrefix && trimmed.startsWith(reservedPrefix)) return '';
    return match;
  });
}

/**
 * Deep-interpolate {{VAR}} patterns in any value (string, object, array).
 * Returns a new object — does not mutate the input.
 */
export function interpolateDeep<T>(
  value: T,
  envVars: Record<string, string>,
  options?: InterpolateOptions,
): T {
  if (
    (!envVars || Object.keys(envVars).length === 0) &&
    !options?.reservedPrefix
  ) {
    return value;
  }

  if (typeof value === 'string') {
    return interpolateString(value, envVars, options) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      interpolateDeep(item, envVars, options),
    ) as unknown as T;
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = interpolateDeep(val, envVars, options);
    }
    return result as T;
  }

  return value;
}

/**
 * Interpolate connector config fields with env vars.
 * Applies to: baseUrl, headers, endpointMapping (path, queryParams, bodyMapping, headers).
 *
 * `options.reservedPrefix` enables the server-resolved namespace (see
 * caller-context.util.ts). Reserved values must already be merged into
 * `envVars` *after* the workspace's own vars so they cannot be shadowed.
 */
export function interpolateConnectorConfig(
  config: {
    baseUrl: string;
    headers?: Record<string, string>;
  },
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: Record<string, unknown>;
    headers?: Record<string, string>;
  },
  envVars: Record<string, string>,
  options?: InterpolateOptions,
): {
  config: { baseUrl: string; headers?: Record<string, string> };
  endpointMapping: typeof endpointMapping;
} {
  if (
    (!envVars || Object.keys(envVars).length === 0) &&
    !options?.reservedPrefix
  ) {
    return { config, endpointMapping };
  }

  return {
    config: {
      ...config,
      baseUrl: interpolateString(config.baseUrl, envVars, options),
      headers: config.headers
        ? interpolateDeep(config.headers, envVars, options)
        : undefined,
    },
    endpointMapping: {
      ...endpointMapping,
      path: interpolateString(endpointMapping.path, envVars, options),
      queryParams: endpointMapping.queryParams
        ? interpolateDeep(endpointMapping.queryParams, envVars, options)
        : undefined,
      bodyMapping: endpointMapping.bodyMapping
        ? interpolateDeep(endpointMapping.bodyMapping, envVars, options)
        : undefined,
      headers: endpointMapping.headers
        ? interpolateDeep(endpointMapping.headers, envVars, options)
        : undefined,
    },
  };
}
