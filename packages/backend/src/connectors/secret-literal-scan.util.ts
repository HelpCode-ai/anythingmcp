import {
  findSecretInHeader,
  findSecretInQueryParam,
  findSecretLiterals,
  type SecretKind,
} from '../common/secret-literals.util';
import { SECRET_GUARDED_TYPES, SecretExtractor, type MovedSecret } from './secret-extraction.util';

/**
 * Stored connectors and tools checked for secret literals, for the report
 * and repair scripts (scripts/secret-literals-*.ts). Pure functions over
 * plain rows, so both run against a database dump or a test fixture alike.
 * A finding carries a redacted pattern only, never the secret.
 */

export interface ConnectorRow {
  id: string;
  organizationId: string;
  name: string;
  type: string;
  baseUrl: string;
  headers: Record<string, unknown> | null;
  config: Record<string, unknown> | null;
  envVars: Record<string, unknown> | null;
}

export interface ToolRow {
  id: string;
  connectorId: string;
  name: string;
  description: string;
  parameters: unknown;
  endpointMapping: unknown;
}

export interface ScanFinding {
  connectorId: string;
  workspaceId: string;
  toolId?: string;
  /** `baseUrl`, `config.baseUrlBaseline`, `headers.X`, `tool.path`, `tool.name`… */
  field: string;
  kind: SecretKind | 'name_contains_secret';
  pattern: string;
  /** The catalog adapter the connector came from, if any. */
  adapterSlug: string | null;
}

function slugOf(c: ConnectorRow): string | null {
  const slug = c.config?.adapterSlug;
  return typeof slug === 'string' ? slug : null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Everything secret-looking in one connector and its tools. */
export function scanConnector(connector: ConnectorRow, tools: ToolRow[]): ScanFinding[] {
  if (!SECRET_GUARDED_TYPES.has(connector.type)) return [];
  const adapterSlug = slugOf(connector);
  const out: ScanFinding[] = [];
  const base = { connectorId: connector.id, workspaceId: connector.organizationId, adapterSlug };
  const secretValues: string[] = [];
  const add = (field: string, found: Array<{ kind: SecretKind; pattern: string; value: string }>, toolId?: string) => {
    for (const f of found) {
      secretValues.push(f.value);
      out.push({ ...base, ...(toolId ? { toolId } : {}), field, kind: f.kind, pattern: f.pattern });
    }
  };

  add('baseUrl', findSecretLiterals(connector.baseUrl ?? ''));
  const baseline = connector.config?.baseUrlBaseline;
  if (typeof baseline === 'string') add('config.baseUrlBaseline', findSecretLiterals(baseline));
  for (const [name, value] of Object.entries(connector.headers ?? {})) {
    add(`headers.${name}`, findSecretInHeader(name, value));
  }

  for (const tool of tools) {
    const em = isObject(tool.endpointMapping) ? tool.endpointMapping : {};
    if (typeof em.path === 'string') add('tool.path', findSecretLiterals(em.path), tool.id);
    if (isObject(em.queryParams)) {
      for (const [k, v] of Object.entries(em.queryParams)) {
        add(`tool.query.${k}`, findSecretInQueryParam(k, v), tool.id);
      }
    }
    if (isObject(em.headers)) {
      for (const [k, v] of Object.entries(em.headers)) {
        add(`tool.headers.${k}`, findSecretInHeader(k, v), tool.id);
      }
    }
    const props = isObject(tool.parameters) && isObject(tool.parameters.properties)
      ? tool.parameters.properties
      : {};
    for (const [k, p] of Object.entries(props)) {
      if (isObject(p) && typeof p.default === 'string') {
        add(`tool.parameter.${k}`, findSecretInQueryParam(k, p.default), tool.id);
      }
    }
    add('tool.name', findSecretLiterals(tool.name ?? ''), tool.id);
  }

  // A tool name built from a path with a secret holds a sanitized copy
  // (`bot7123456789_AAH…`), which no pattern recognises on its own.
  const fragments = [...new Set(secretValues)]
    .flatMap((v) => v.split(/[^A-Za-z0-9]+/))
    .filter((part) => part.length >= 6)
    .map((part) => part.toLowerCase());
  for (const tool of tools) {
    const lower = (tool.name ?? '').toLowerCase();
    const already = out.some((f) => f.toolId === tool.id && f.field === 'tool.name');
    if (!already && fragments.some((part) => lower.includes(part))) {
      out.push({ ...base, toolId: tool.id, field: 'tool.name', kind: 'name_contains_secret', pattern: '<name contains part of a secret>' });
    }
    if (typeof tool.description === 'string' && fragments.some((part) => tool.description.toLowerCase().includes(part))) {
      out.push({ ...base, toolId: tool.id, field: 'tool.description', kind: 'name_contains_secret', pattern: '<description quotes a secret>' });
    }
  }
  return out;
}

export interface RepairPlan {
  connectorId: string;
  workspaceId: string;
  adapterSlug: string | null;
  /** Fields of the connector to write (only the changed ones). */
  connector: Partial<Pick<ConnectorRow, 'baseUrl' | 'headers' | 'config'>> & {
    envVars?: Record<string, string>;
  };
  tools: Array<{ id: string; changes: Partial<Pick<ToolRow, 'name' | 'description' | 'parameters' | 'endpointMapping'>> }>;
  moved: MovedSecret[];
  /** Variables the repair adds (a reused existing variable is not listed). */
  newVariables: string[];
  renamedTools: string[];
}

/**
 * What the repair writes for one connector: the same rewrite the API now
 * applies on every save. Catalog connectors' headers are left alone (they
 * are rebuilt from the adapter's template when the variables change).
 * Returns null when there is nothing to change.
 */
export function planRepair(connector: ConnectorRow, tools: ToolRow[]): RepairPlan | null {
  if (!SECRET_GUARDED_TYPES.has(connector.type)) return null;
  const adapterSlug = slugOf(connector);
  const env = Object.fromEntries(
    Object.entries(connector.envVars ?? {}).filter(([, v]) => typeof v === 'string'),
  ) as Record<string, string>;
  const secrets = new SecretExtractor(connector.name, env, {
    takenToolNames: tools.map((t) => t.name),
  });

  const plan: RepairPlan = {
    connectorId: connector.id,
    workspaceId: connector.organizationId,
    adapterSlug,
    connector: {},
    tools: [],
    moved: secrets.moved,
    newVariables: [],
    renamedTools: secrets.renamedTools,
  };

  const baseUrl = secrets.extractUrl(connector.baseUrl, 'baseUrl');
  if (baseUrl !== connector.baseUrl) plan.connector.baseUrl = baseUrl;

  if (!adapterSlug && connector.headers) {
    const headers = secrets.extractHeaders(connector.headers, 'headers');
    if (JSON.stringify(headers) !== JSON.stringify(connector.headers)) {
      plan.connector.headers = headers as Record<string, unknown>;
    }
  }

  // The install-time snapshot holds the same resolved URL.
  const baseline = connector.config?.baseUrlBaseline;
  if (typeof baseline === 'string') {
    const cleaned = secrets.extractUrl(baseline, 'config.baseUrlBaseline');
    if (cleaned !== baseline) plan.connector.config = { ...connector.config, baseUrlBaseline: cleaned };
  }

  for (const tool of tools) {
    // A tool whose name is renamed must not take the name of a tool not
    // processed yet: every current name stays reserved.
    const next = secrets.extractTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      endpointMapping: tool.endpointMapping,
    });
    const changes: RepairPlan['tools'][number]['changes'] = {};
    if (next.name !== tool.name) changes.name = next.name;
    for (const key of ['description', 'parameters', 'endpointMapping'] as const) {
      if (JSON.stringify(next[key]) !== JSON.stringify(tool[key])) {
        (changes as Record<string, unknown>)[key] = next[key];
      }
    }
    if (Object.keys(changes).length > 0) plan.tools.push({ id: tool.id, changes });
  }

  if (Object.keys(secrets.newEnvVars).length > 0) {
    plan.connector.envVars = { ...env, ...secrets.newEnvVars };
    plan.newVariables = Object.keys(secrets.newEnvVars);
  }

  const changed = Object.keys(plan.connector).length > 0 || plan.tools.length > 0;
  return changed ? plan : null;
}
