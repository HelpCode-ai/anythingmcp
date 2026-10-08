import { z } from 'zod';

/**
 * The properties a tool accepts and the ones it requires. A schema with no
 * `properties` of its own that lists alternatives under a top-level `oneOf` or
 * `anyOf` (as some vendors' MCP servers do) accepts every branch's properties;
 * one is required only when every branch requires it. Without this the tool was
 * advertised with no parameters and every argument was stripped. The upstream
 * server still checks which combination is valid.
 */
export function toolSchemaProperties(schema: Record<string, unknown>): {
  properties?: Record<string, any>;
  required: string[];
} {
  const properties = schema?.properties as Record<string, any> | undefined;
  const branches = (schema?.oneOf ?? schema?.anyOf) as Record<string, any>[] | undefined;
  if (properties || !Array.isArray(branches) || branches.length === 0) {
    return { properties, required: (schema?.required as string[]) || [] };
  }

  const merged: Record<string, any> = {};
  for (const branch of branches) {
    for (const [key, prop] of Object.entries((branch?.properties ?? {}) as Record<string, any>)) {
      const seen = merged[key];
      if (!seen) {
        merged[key] = prop;
        continue;
      }
      // Keep a value list only when every branch restricts the property to one.
      const values = (p: any) => p?.enum ?? (p?.const !== undefined ? [p.const] : undefined);
      const [a, b] = [values(seen), values(prop)];
      const { const: _const, enum: _enum, ...rest } = seen;
      merged[key] = a && b ? { ...rest, enum: [...new Set([...a, ...b])] } : rest;
    }
  }
  const required = Object.keys(merged).filter((key) =>
    branches.every((b) => ((b?.required as string[]) ?? []).includes(key)),
  );
  return { properties: Object.keys(merged).length ? merged : undefined, required };
}

/**
 * Convert a tool's JSON Schema to a Zod raw shape, for McpServer registration
 * and for validating the arguments of a tool run through the shared endpoint.
 */
export function jsonSchemaToZodShape(
  schema: Record<string, unknown>,
): Record<string, z.ZodType> {
  const { properties, required } = toolSchemaProperties(schema);
  if (!properties) return {};

  const shape: Record<string, z.ZodType> = {};

  for (const [key, prop] of Object.entries(properties)) {
    let zodType: z.ZodType;

    switch (prop.type) {
      case 'string':
        zodType = prop.enum
          ? z.enum(prop.enum as [string, ...string[]])
          : z.string();
        break;
      case 'number':
      case 'integer':
        zodType = z.number();
        break;
      case 'boolean':
        zodType = z.boolean();
        break;
      case 'array':
        zodType = z.array(z.any());
        break;
      case 'object':
        zodType = z.record(z.string(), z.any());
        break;
      default:
        zodType = z.any();
    }

    if (prop.description) {
      zodType = zodType.describe(prop.description);
    }

    if (prop.default !== undefined) {
      zodType = zodType.default(prop.default);
    }

    if (!required.includes(key)) {
      zodType = zodType.optional();
    }

    shape[key] = zodType;
  }

  return shape;
}

/**
 * Remove parameters covered by connector env vars: the connector supplies
 * them, so the model is never asked for them.
 */
export function stripEnvVarParams(
  schema: Record<string, unknown>,
  envVars?: Record<string, string>,
): Record<string, unknown> {
  if (!envVars || Object.keys(envVars).length === 0) return schema;

  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties) return schema;

  const envKeys = new Set(Object.keys(envVars));
  const newProperties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!envKeys.has(key)) {
      newProperties[key] = value;
    }
  }

  const required = (schema.required as string[]) || [];
  const newRequired = required.filter((k) => !envKeys.has(k));

  return {
    ...schema,
    properties: newProperties,
    ...(newRequired.length > 0 ? { required: newRequired } : {}),
  };
}
