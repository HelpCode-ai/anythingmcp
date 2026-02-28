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

/**
 * Interpolate {{VAR}} patterns in a string.
 */
export function interpolateString(
  template: string,
  envVars: Record<string, string>,
): string {
  return template.replace(VAR_PATTERN, (match, varName) => {
    const trimmed = varName.trim();
    return envVars[trimmed] !== undefined ? envVars[trimmed] : match;
  });
}

/**
 * Deep-interpolate {{VAR}} patterns in any value (string, object, array).
 * Returns a new object — does not mutate the input.
 */
export function interpolateDeep<T>(
  value: T,
  envVars: Record<string, string>,
): T {
  if (!envVars || Object.keys(envVars).length === 0) return value;

  if (typeof value === 'string') {
    return interpolateString(value, envVars) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => interpolateDeep(item, envVars)) as unknown as T;
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = interpolateDeep(val, envVars);
    }
    return result as T;
  }

  return value;
}

/**
 * Interpolate connector config fields with env vars.
 * Applies to: baseUrl, headers, endpointMapping (path, queryParams, bodyMapping, headers).
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
): {
  config: { baseUrl: string; headers?: Record<string, string> };
  endpointMapping: typeof endpointMapping;
} {
  if (!envVars || Object.keys(envVars).length === 0) {
    return { config, endpointMapping };
  }

  return {
    config: {
      ...config,
      baseUrl: interpolateString(config.baseUrl, envVars),
      headers: config.headers
        ? interpolateDeep(config.headers, envVars)
        : undefined,
    },
    endpointMapping: {
      ...endpointMapping,
      path: interpolateString(endpointMapping.path, envVars),
      queryParams: endpointMapping.queryParams
        ? interpolateDeep(endpointMapping.queryParams, envVars)
        : undefined,
      bodyMapping: endpointMapping.bodyMapping
        ? interpolateDeep(endpointMapping.bodyMapping, envVars)
        : undefined,
      headers: endpointMapping.headers
        ? interpolateDeep(endpointMapping.headers, envVars)
        : undefined,
    },
  };
}
