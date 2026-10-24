import { z } from 'zod';

const COMBINATORS = ['allOf', 'oneOf', 'anyOf'] as const;

/**
 * The properties a tool accepts and the ones it requires. Some MCP servers
 * (bridged or custom) declare a tool's arguments under a top-level `oneOf`,
 * `anyOf` or `allOf`, with no or only some top-level `properties`. Reading the
 * top level alone advertised such a tool with missing parameters and stripped
 * every argument, so the upstream call failed ("arguments.tenant_id is
 * required").
 *
 * The result is the union of the top-level, `allOf` and branch properties. A
 * property is required when the top level or any `allOf` part requires it, or
 * when every `oneOf`/`anyOf` branch does. The upstream server still checks
 * which combination is valid; this only has to let every valid call through.
 */
export function toolSchemaProperties(schema: Record<string, unknown>): {
  properties?: Record<string, any>;
  required: string[];
} {
  const own = schema?.properties as Record<string, any> | undefined;
  const ownRequired = (schema?.required as string[]) || [];
  if (!COMBINATORS.some((k) => Array.isArray(schema?.[k]))) {
    return { properties: own, required: ownRequired };
  }

  // The top level and `allOf` apply to every call, so their definition of a
  // property wins over a branch's.
  const properties: Record<string, any> = { ...own };
  const required = new Set(ownRequired);
  const add = (props: Record<string, any> = {}) => {
    for (const [key, prop] of Object.entries(props)) {
      if (!(key in properties)) properties[key] = prop;
    }
  };

  for (const part of (schema.allOf as Record<string, unknown>[] | undefined) ?? []) {
    const flat = toolSchemaProperties(part ?? {});
    add(flat.properties);
    flat.required.forEach((key) => required.add(key));
  }

  for (const group of [schema.oneOf, schema.anyOf]) {
    if (!Array.isArray(group) || group.length === 0) continue;
    const branches = group.map((b) => toolSchemaProperties(b ?? {}));
    const merged: Record<string, any> = {};
    for (const branch of branches) {
      for (const [key, prop] of Object.entries(branch.properties ?? {})) {
        merged[key] = key in merged ? mergeAlternatives(merged[key], prop) : withoutDefault(prop);
      }
    }
    add(merged);
    branches[0].required
      .filter((key) => branches.every((b) => b.required.includes(key)))
      .forEach((key) => required.add(key));
  }

  return {
    properties: Object.keys(properties).length ? properties : undefined,
    required: [...required],
  };
}

// A default of one alternative is not a default of the others: applied to a
// call meant for another branch, it would add an argument that branch forbids.
function withoutDefault(prop: any): any {
  if (!prop || typeof prop !== 'object') return prop;
  const { default: _default, ...rest } = prop;
  return rest;
}

/**
 * One property as two alternatives declare it: keep only what both agree on,
 * so a call valid for either is not rejected. Two different `type`s drop the
 * type (the converters fall back to `z.any()`); a value list survives only
 * when both restrict the property to one, as the union of the two.
 */
function mergeAlternatives(a: any, b: any): any {
  const values = (p: any) => p?.enum ?? (p?.const !== undefined ? [p.const] : undefined);
  const [va, vb] = [values(a), values(b)];
  const merged: Record<string, any> = {};
  for (const [key, value] of Object.entries((a ?? {}) as Record<string, any>)) {
    if (key === 'enum' || key === 'const' || key === 'description') continue;
    if (JSON.stringify(value) === JSON.stringify(b?.[key])) merged[key] = value;
  }
  const description = a?.description ?? b?.description;
  if (description !== undefined) merged.description = description;
  if (va && vb) merged.enum = [...new Set([...va, ...vb])];
  return merged;
}

/**
 * The schema as a plain object schema: `allOf`/`oneOf`/`anyOf` folded into
 * `properties` and `required` (see `toolSchemaProperties`). Listed to clients,
 * since some reject a top-level combinator. A schema without one is returned
 * as is.
 */
export function flattenToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (!COMBINATORS.some((k) => Array.isArray(schema?.[k]))) return schema;
  const { allOf: _allOf, oneOf: _oneOf, anyOf: _anyOf, required: _required, ...rest } = schema;
  const { properties, required } = toolSchemaProperties(schema);
  return {
    ...rest,
    properties: properties ?? {},
    ...(required.length > 0 ? { required } : {}),
  };
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
 * them, so the model is never asked for them. A schema with a top-level
 * combinator comes back flattened, so a key inside a branch goes too.
 */
export function stripEnvVarParams(
  schema: Record<string, unknown>,
  envVars?: Record<string, string>,
): Record<string, unknown> {
  if (!envVars || Object.keys(envVars).length === 0) return schema;

  const { properties, required } = toolSchemaProperties(schema);
  if (!properties) return schema;

  const envKeys = new Set(Object.keys(envVars));
  const newProperties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!envKeys.has(key)) {
      newProperties[key] = value;
    }
  }

  const newRequired = required.filter((k) => !envKeys.has(k));
  // Without the old `required`: kept when every entry was env-covered, it
  // still asked for a parameter that is no longer listed.
  const { required: _required, ...rest } = flattenToolSchema(schema);

  return {
    ...rest,
    properties: newProperties,
    ...(newRequired.length > 0 ? { required: newRequired } : {}),
  };
}
