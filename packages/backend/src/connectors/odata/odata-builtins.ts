import { slugifyForPrefix } from '../graphql-builtins';

/**
 * Generic OData tools that ship with every ODATA connector and every REST
 * connector with `config.odata`, catalog adapters included. They let an agent
 * find a service, read its model with the human labels, and query it, without
 * anyone having written a tool per entity set:
 *
 *   <prefix>_list_services     SAP Gateway catalog (V2 + V4), searchable
 *   <prefix>_describe_service  entity sets with labels, keys, analytical flag
 *   <prefix>_describe_entity   fields with labels, units, dimensions/measures
 *   <prefix>_query             validated query, paging followed, rows flattened
 *   <prefix>_get_entity        one entity by key
 *
 * Executed by ODataEngine through the `odata_*` endpoint methods.
 */
export interface ODataBuiltinTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  endpointMapping: Record<string, unknown>;
}

export function odataToolPrefix(opts: { toolPrefix?: string; name: string }): string {
  if (opts.toolPrefix && /^[a-z][a-z0-9_]*$/.test(opts.toolPrefix)) return opts.toolPrefix;
  const base = slugifyForPrefix(opts.name);
  return base.includes('odata') ? base : `${base}_odata`;
}

export function buildODataBuiltinTools(opts: {
  prefix: string;
  displayName: string;
  sap: boolean;
  /** The connector lists its services itself (config.odata.services). */
  listed?: boolean;
}): ODataBuiltinTool[] {
  const { prefix, displayName, sap } = opts;
  const multi = sap || !!opts.listed;
  const service = {
    type: 'string',
    description: sap
      ? 'Service path from list_services, e.g. /sap/opu/odata/sap/API_BUSINESS_PARTNER.'
      : multi
        ? 'Service path from list_services.'
        : 'Leave empty: the connector points at one service.',
  };
  const serviceRequired = multi ? ['service'] : [];
  return [
    {
      name: `${prefix}_list_services`,
      description: sap
        ? `List the OData services published by ${displayName} (SAP Gateway catalog, V2 and V4), filtered by words in their name, title or description, e.g. "journal entry", "sales order", "API_BUSINESS_PARTNER". Start here.`
        : multi
          ? `List the OData services this ${displayName} connector reaches. Start here.`
          : `Where the ${displayName} OData service lives. Start here, then describe_service.`,
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Words that must all appear in the service name, title or description.' },
          refresh: { type: 'boolean', description: 'Reload the catalog instead of using the cached copy (1 hour).' },
        },
      },
      endpointMapping: { method: 'odata_list_services', path: '' },
    },
    {
      name: `${prefix}_describe_service`,
      description: `The entity sets of a ${displayName} OData service with their business labels, keys and whether they are analytical (the server aggregates) or parameterised. Read it before querying a service you have not used.`,
      parameters: {
        type: 'object',
        properties: {
          service,
          refresh: { type: 'boolean', description: 'Reload $metadata instead of using the cached copy (24 hours).' },
        },
        required: serviceRequired,
      },
      endpointMapping: { method: 'odata_describe_service', path: '' },
    },
    {
      name: `${prefix}_describe_entity`,
      description: `The fields of one entity set: labels, types, keys, the currency or unit field of each amount, the text field of each code, dimensions and measures, navigation properties, and the filters the set requires.`,
      parameters: {
        type: 'object',
        properties: {
          service,
          entity_set: { type: 'string', description: 'Entity set name from describe_service.' },
        },
        required: [...serviceRequired, 'entity_set'],
      },
      endpointMapping: { method: 'odata_describe_entity', path: '' },
    },
    {
      name: `${prefix}_query`,
      description:
        `Read rows from an entity set of ${displayName}. Field names are checked against the service model first. ` +
        'Returns plain rows (dates as ISO strings, decimals as strings), the total count, and nextSkip when more rows exist. ' +
        'On an analytical set, select dimensions and measures and the server aggregates.',
      parameters: {
        type: 'object',
        properties: {
          service,
          entity_set: { type: 'string', description: 'Entity set name.' },
          select: { type: 'string', description: 'Comma-separated fields to return. Always name the currency or unit field of an amount.' },
          filter: { type: 'string', description: "OData $filter, e.g. CompanyCode eq '1000' and FiscalYear eq '2026'." },
          orderby: { type: 'string', description: 'OData $orderby, e.g. PostingDate desc.' },
          top: { type: 'number', description: 'Rows to return, default 100, at most 1000.' },
          skip: { type: 'number', description: 'Rows to skip, for the next page (use nextSkip).' },
          expand: { type: 'string', description: 'Navigation properties to include, e.g. to_Item.' },
          parameters: { type: 'object', description: 'Values for a parameterised view, e.g. {"P_ExchangeRateType": "M"}.' },
          apply: { type: 'string', description: 'OData V4 $apply, e.g. groupby((Customer),aggregate(NetAmount with sum as Total)).' },
          search: { type: 'string', description: 'Free-text $search, where the service supports it.' },
          count: { type: 'boolean', description: 'Ask for the total row count (default true).' },
        },
        required: [...serviceRequired, 'entity_set'],
      },
      endpointMapping: { method: 'odata_query', path: '' },
    },
    {
      name: `${prefix}_get_entity`,
      description: `Read one entity of ${displayName} by its key, optionally with related entities.`,
      parameters: {
        type: 'object',
        properties: {
          service,
          entity_set: { type: 'string', description: 'Entity set name.' },
          key: {
            type: 'string',
            description: 'The key value, or for a composite key a JSON object such as {"SalesOrder": "1", "SalesOrderItem": "10"}.',
          },
          select: { type: 'string', description: 'Comma-separated fields to return.' },
          expand: { type: 'string', description: 'Navigation properties to include.' },
        },
        required: [...serviceRequired, 'entity_set', 'key'],
      },
      endpointMapping: { method: 'odata_get', path: '' },
    },
  ];
}

/** Whether a connector should carry the OData built-ins. */
export function wantsODataBuiltins(type: string, config: unknown): boolean {
  if (type === 'ODATA') return true;
  const odata = (config as { odata?: unknown } | null | undefined)?.odata;
  return type === 'REST' && !!odata && typeof odata === 'object';
}
