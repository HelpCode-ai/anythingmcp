import * as yaml from 'js-yaml';
import { BadRequestException } from '@nestjs/common';
import { toPublicConnector } from './connector-secrets.util';

/** Version written into every export envelope (export-all and :id/export). */
export const EXPORT_FORMAT_VERSION = '1.0';

/**
 * One connector as it appears in an export file. authConfig is never
 * exported. Secret env vars and headers are kept only when `includeSecrets`
 * is set (admins); otherwise they are left empty and named in
 * `maskedEnvVars` / `maskedHeaders`.
 */
export function toExportEntry(c: any, includeSecrets: boolean) {
  const masked = includeSecrets ? null : toPublicConnector(c);
  return {
    name: c.name,
    type: c.type,
    baseUrl: c.baseUrl,
    isActive: c.isActive,
    authType: c.authType,
    specUrl: c.specUrl,
    headers: masked ? masked.headers : c.headers,
    config: c.config,
    envVars: masked ? masked.envVars : c.envVars,
    ...(masked
      ? { maskedEnvVars: masked.maskedEnvVars, maskedHeaders: masked.maskedHeaders }
      : {}),
    tools: (c.tools ?? []).map((t: any) => ({
      name: t.name,
      description: t.description,
      isEnabled: t.isEnabled,
      parameters: t.parameters,
      endpointMapping: t.endpointMapping,
      responseMapping: t.responseMapping,
      outputSchema: t.outputSchema,
    })),
  };
}

/** The envelope shared by export-all and the single-connector export. */
export function toExportEnvelope(connectors: any[], includeSecrets: boolean) {
  return {
    version: EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    secretsIncluded: includeSecrets,
    connectors: connectors.map((c) => toExportEntry(c, includeSecrets)),
  };
}

export type ExportFormat = 'json' | 'yaml';
export const EXPORT_FORMATS: readonly ExportFormat[] = ['json', 'yaml'];

/**
 * Serialise an export envelope. YAML uses the core schema, so a timestamp
 * such as `exportedAt` reads back as a string, and never emits anchors.
 */
export function serializeExport(data: unknown, format: ExportFormat): string {
  if (format === 'yaml') {
    return yaml.dump(data, { schema: yaml.CORE_SCHEMA, noRefs: true, lineWidth: -1 });
  }
  return JSON.stringify(data, null, 2);
}

/** `<slug>.anythingmcp.<ext>`, ASCII only, safe inside a quoted header value. */
export function exportFileName(connectorName: string, format: ExportFormat): string {
  const slug =
    String(connectorName ?? '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'connector';
  return `${slug}.anythingmcp.${format === 'yaml' ? 'yaml' : 'json'}`;
}

/** Upper bound for an import file, well inside the 10 MB body limit. */
export const IMPORT_FILE_MAX_CHARS = 5_000_000;

/**
 * Parse an import file. JSON is valid YAML, so one parser reads both. The
 * core schema keeps dates as strings and has no custom tags. A syntax error
 * becomes a 400 naming the line and column. A bare connector object or array
 * is wrapped in the export envelope, so it is then validated like any file.
 */
export function parseImportFile(content: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = yaml.load(content, { schema: yaml.CORE_SCHEMA });
  } catch (err: unknown) {
    if (err instanceof yaml.YAMLException) {
      const mark = err.mark;
      const where = mark ? ` at line ${mark.line + 1}, column ${mark.column + 1}` : '';
      throw new BadRequestException(`Invalid file${where}: ${err.reason}`);
    }
    throw new BadRequestException('Invalid file: could not be parsed');
  }
  assertNoSharedReferences(parsed);
  const file = wrapEnvelope(parsed);
  if (Array.isArray(file.connectors)) {
    file.connectors.forEach((c: unknown, i: number) => normalizeStringMaps(c, i));
  }
  return file;
}

/**
 * Reject a file in which one object or array is reached twice. Export never
 * writes YAML anchors (`noRefs`), so a repeated reference can only come from a
 * hand-written alias: an alias bomb (`&a [*b, *b, ...]`) that would expand
 * exponentially later on, or a self reference (`&c {self: *c}`) that would
 * recurse without end. Each node is visited at most once, and the seen check
 * comes before descending, so the walk is linear and always terminates.
 *
 * Strings are primitives, so an anchored string reused through aliases
 * (`s: &s <100 KB>` then `[*s, *s, ...]`) is not caught by identity. The walk
 * therefore also adds up the length of every string and object key it meets,
 * once per place it appears, and stops as soon as the total passes
 * IMPORT_FILE_MAX_CHARS: the size the file would have once its aliases are
 * expanded.
 */
function assertNoSharedReferences(root: unknown): void {
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  let expandedChars = 0;
  const count = (chars: number) => {
    expandedChars += chars;
    if (expandedChars > IMPORT_FILE_MAX_CHARS) {
      throw new BadRequestException(
        `Invalid file: too large once YAML aliases are expanded (over ${IMPORT_FILE_MAX_CHARS} characters)`,
      );
    }
  };
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node === 'string') {
      count(node.length);
      continue;
    }
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) {
      throw new BadRequestException(
        'Invalid file: YAML aliases that repeat or reference an object are not supported',
      );
    }
    seen.add(node);
    if (Array.isArray(node)) {
      for (const value of node) stack.push(value);
    } else {
      for (const [key, value] of Object.entries(node)) {
        count(key.length);
        stack.push(value);
      }
    }
  }
}

/**
 * envVars and headers are string maps. A hand-edited YAML file may write
 * `PORT: 5432` or `ENABLED: true`; such numbers and booleans become strings.
 * An object or array value is rejected with a 400 naming the key.
 */
function normalizeStringMaps(connector: unknown, index: number): void {
  if (!connector || typeof connector !== 'object' || Array.isArray(connector)) return;
  const c = connector as Record<string, unknown>;
  for (const field of ['envVars', 'headers'] as const) {
    const map = c[field];
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
      if (typeof value === 'number' || typeof value === 'boolean') {
        (map as Record<string, unknown>)[key] = String(value);
      } else if (value !== null && typeof value === 'object') {
        throw new BadRequestException(
          `Invalid file: connectors[${index}].${field}.${key} must be a string, not an ${
            Array.isArray(value) ? 'array' : 'object'
          }`,
        );
      }
    }
  }
}

function wrapEnvelope(parsed: unknown): Record<string, any> {
  if (Array.isArray(parsed)) {
    // A bare array of connectors: wrap it in the export envelope.
    return { connectors: parsed };
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new BadRequestException(
      'Invalid file: expected an object with a "connectors" array, as written by export',
    );
  }
  if (!('connectors' in parsed)) {
    // A bare connector object: wrap it in the export envelope.
    return { connectors: [parsed] };
  }
  return parsed as Record<string, any>;
}
