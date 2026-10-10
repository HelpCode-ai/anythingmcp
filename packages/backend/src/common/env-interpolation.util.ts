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

import { escapeXmlValue } from './xml-escape.util';

const VAR_PATTERN = /\{\{([^{}]+)\}\}/g;

export interface InterpolateOptions {
  /**
   * Namespace prefix (e.g. `amcp.`) whose variables are resolved by the server
   * rather than by the workspace. A variable under this prefix that has no
   * value resolves to an empty string instead of being left verbatim, so an
   * unresolved placeholder is never sent to the target system.
   */
  reservedPrefix?: string;
  /**
   * Escape substituted values for a JSON string context. Use when the template
   * is raw JSON text (a bodyTemplate) rather than a value inside an already
   * structured object, so a quote or backslash in the value cannot terminate
   * the surrounding string and inject syntax.
   *
   * Only the content is escaped — no quotes are added — so a bare numeric
   * placeholder such as `{"limit": {{MAX}}}` still yields valid JSON.
   */
  jsonEscape?: boolean;
  /**
   * Escape substituted values for XML text or an attribute, for an XML body
   * (`bodyEncoding: "xml"`). Takes precedence over `jsonEscape`.
   */
  xmlEscape?: boolean;
}

/** Escape a value for embedding inside a JSON string literal. */
function escapeForJsonString(value: string): string {
  const encoded = JSON.stringify(value);
  return encoded.slice(1, -1);
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
  const emit = (value: string) =>
    options?.xmlEscape
      ? escapeXmlValue(value)
      : options?.jsonEscape
        ? escapeForJsonString(value)
        : value;
  return template.replace(VAR_PATTERN, (match, varName) => {
    const trimmed = varName.trim();
    if (envVars[trimmed] !== undefined) return emit(envVars[trimmed]);
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
 * Applies to: baseUrl, headers, endpointMapping (path, queryParams, bodyMapping,
 * bodyTemplate, headers).
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
    bodyTemplate?: string;
    bodyEncoding?: string;
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

  // An XML body (`bodyEncoding: "xml"`) is markup, so a variable's value is
  // escaped for XML there, the way a JSON template escapes it for JSON.
  const xmlBody = endpointMapping.bodyEncoding === 'xml';
  const bodyMapping = endpointMapping.bodyMapping
    ? interpolateDeep(endpointMapping.bodyMapping, envVars, options)
    : undefined;
  if (xmlBody && bodyMapping && typeof endpointMapping.bodyMapping?.__raw === 'string') {
    bodyMapping.__raw = interpolateString(endpointMapping.bodyMapping.__raw, envVars, {
      ...options,
      xmlEscape: true,
    });
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
      bodyMapping,
      // A bodyTemplate is raw JSON text, so substituted values must be escaped
      // for a JSON string context — otherwise a quote in a value would break
      // the document. Without this, {{VAR}} (and {{amcp.*}}) silently reached
      // the target system unresolved.
      bodyTemplate: endpointMapping.bodyTemplate
        ? interpolateString(endpointMapping.bodyTemplate, envVars, {
            ...options,
            ...(xmlBody ? { xmlEscape: true } : { jsonEscape: true }),
          })
        : undefined,
      headers: endpointMapping.headers
        ? interpolateToolHeaders(endpointMapping.headers, envVars, options)
        : undefined,
    },
  };
}

/** A value that is exactly one `{{VAR}}` placeholder. */
const ONLY_VARIABLE = /^\{\{([^{}]+)\}\}$/;

/**
 * Tool headers, interpolated like the rest of the mapping, except that a
 * header whose whole value is one variable set to an empty string keeps its
 * placeholder. The install form saves an optional field left empty as "",
 * which would otherwise go out as a blank header (Xero's tenant ID before
 * it is chosen); kept, it is refused with the variable's name, like one that
 * was never set.
 */
function interpolateToolHeaders(
  headers: Record<string, string>,
  envVars: Record<string, string>,
  options?: InterpolateOptions,
): Record<string, string> {
  const resolved = interpolateDeep(headers, envVars, options);
  for (const [key, value] of Object.entries(headers)) {
    const name = typeof value === 'string' ? ONLY_VARIABLE.exec(value)?.[1].trim() : undefined;
    if (!name || (options?.reservedPrefix && name.startsWith(options.reservedPrefix))) continue;
    if (typeof envVars[name] === 'string' && envVars[name].trim() === '') resolved[key] = value;
  }
  return resolved;
}
