import { ODataEntityType, ODataServiceModel, parseEdmx } from '../odata/edmx.parser';
import { assertSafeServicePath } from '../odata/odata-values';

/**
 * Curated tools from an OData `$metadata` document: one "list" and one "get"
 * tool per entity set, named after the set and described with the labels the
 * service publishes. The generic built-ins (`<prefix>_query` and friends)
 * cover everything else; these exist for the sets an admin wants the model to
 * reach first, with their own names, descriptions and role permissions.
 */
export interface ParsedODataTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  endpointMapping: Record<string, unknown>;
  operationId: string;
}

export function parseODataTools(
  xml: string,
  opts: { service?: string; entitySets?: string[] } = {},
): { model: ODataServiceModel; tools: ParsedODataTool[] } {
  const model = parseEdmx(xml);
  const service = assertSafeServicePath(opts.service ?? '');
  // The service's name: the last path segment, skipping a trailing version
  // (SAP V4 paths end in /<service>/0001).
  const segments = service.split('/').filter(Boolean).map((seg) => seg.split(';')[0]);
  const serviceName = [...segments].reverse().find((seg) => !/^\d+$/.test(seg)) ?? '';
  const wanted = opts.entitySets?.length
    ? new Set(opts.entitySets.map((s) => s.toLowerCase()))
    : undefined;
  const tools: ParsedODataTool[] = [];

  for (const set of model.entitySets) {
    if (wanted && !wanted.has(set.name.toLowerCase())) continue;
    if (set.parameters) continue; // parameterised views: use <prefix>_query
    const type = model.entityTypes[set.entityType];
    if (!type) continue;
    const label = set.label ?? type.label ?? set.name;
    const base = toolBase(serviceName, set.name);
    const fields = describeFields(type);
    const readonlySuffix = set.analytical
      ? ' Analytical set: select dimensions and measures; the server aggregates the measures over the selected dimensions.'
      : '';
    const required = set.requiredInFilter?.length
      ? ` The filter must restrict ${set.requiredInFilter.join(', ')}.`
      : '';

    tools.push({
      name: `${base}_list`,
      operationId: `odata:${service}:${set.name}:list`,
      description: truncate(
        `List ${label} (${set.name}${serviceName ? ` in ${serviceName}` : ''}). Fields: ${fields}.${required}${readonlySuffix}`,
        1000,
      ),
      parameters: {
        type: 'object',
        properties: {
          select: { type: 'string', description: 'Comma-separated fields to return.' },
          filter: { type: 'string', description: 'OData $filter expression.' },
          orderby: { type: 'string', description: 'OData $orderby, e.g. "CreationDate desc".' },
          top: { type: 'number', description: 'Maximum rows (default 100).', default: 100 },
          skip: { type: 'number', description: 'Rows to skip, for paging.' },
          expand: { type: 'string', description: 'Navigation properties to include.' },
        },
        ...(set.requiredInFilter?.length ? { required: ['filter'] } : {}),
      },
      endpointMapping: {
        method: 'GET',
        path: `${service}/${set.name}`,
        queryParams: {
          $select: '$select',
          $filter: '$filter',
          $orderby: '$orderby',
          $top: '$top',
          $skip: '$skip',
          $expand: '$expand',
        },
      },
    });

    if (set.analytical) continue; // no addressable single rows
    const keyParams: Record<string, unknown> = {};
    for (const k of type.keys) {
      const p = type.properties.find((x) => x.name === k);
      keyParams[paramName(k)] = {
        type: 'string',
        description: `${p?.label ?? k} (${k})`,
      };
    }
    tools.push({
      name: `${base}_get`,
      operationId: `odata:${service}:${set.name}:get`,
      description: truncate(`Read one ${label} by its key (${type.keys.join(', ')}).`, 500),
      parameters: {
        type: 'object',
        properties: {
          ...keyParams,
          expand: { type: 'string', description: 'Navigation properties to include.' },
        },
        required: type.keys.map(paramName),
      },
      endpointMapping: {
        method: 'GET',
        path: `${service}/${set.name}${keyTemplate(type)}`,
        encodePathParams: true,
        queryParams: { $expand: '$expand' },
      },
    });
  }
  return { model, tools };
}

function keyTemplate(type: ODataEntityType): string {
  const lit = (k: string) => {
    const t = type.properties.find((p) => p.name === k)?.type ?? 'Edm.String';
    const numeric = /^Edm\.(Int|Byte|SByte|Double|Single)/.test(t);
    return numeric ? `{${paramName(k)}}` : `'{${paramName(k)}}'`;
  };
  if (type.keys.length === 1) return `(${lit(type.keys[0])})`;
  return `(${type.keys.map((k) => `${k}=${lit(k)}`).join(',')})`;
}

function paramName(key: string): string {
  return key.replace(/[^A-Za-z0-9_]/g, '_');
}

function toolBase(service: string, set: string): string {
  const snake = (s: string) =>
    s
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean)
      .join('_')
      .toLowerCase();
  const svc = snake(service.replace(/^API_/i, '').replace(/_SRV$/i, '').replace(/_CDS$/i, ''));
  const name = snake(set.replace(/^A_/, ''));
  const flat = (x: string) => x.replace(/_/g, '');
  const joined = svc && !flat(name).startsWith(flat(svc)) ? `${svc}_${name}` : name;
  return joined.slice(0, 56);
}

function describeFields(type: ODataEntityType): string {
  return type.properties
    .slice(0, 40)
    .map((p) => (p.label && p.label !== p.name ? `${p.name} (${p.label})` : p.name))
    .join(', ');
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
