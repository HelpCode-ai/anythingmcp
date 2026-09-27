import { Injectable, Logger } from '@nestjs/common';
import { RestEngine } from './rest.engine';
import { ODataEntitySet, ODataEntityType, ODataServiceModel, parseEdmx } from '../odata/edmx.parser';
import {
  assertSafeServicePath,
  buildKeyPredicate,
  closest,
  formatKeyLiteral,
  readODataPage,
  serviceAllowed,
} from '../odata/odata-values';

/**
 * OData connectors: the built-in discovery and query tools (`odata_*` methods)
 * and plain HTTP tools against an OData service, for connectors of type ODATA
 * and for REST connectors that carry `config.odata`.
 *
 * HTTP goes through RestEngine, so authentication (Basic, OAuth2, certificates,
 * login tokens), retries, the SSRF guard and the proxy behave exactly as for a
 * REST connector. What this engine adds is OData itself: the SAP Gateway
 * service catalog, `$metadata` read into labels, keys and units, query URLs
 * validated against that model, server paging followed, and V2 / V4 responses
 * flattened into plain rows.
 */

export interface ODataSettings {
  /** `v2`, `v4`, or auto-detected from `$metadata` (default). */
  version?: 'auto' | 'v2' | 'v4';
  /**
   * SAP Gateway: the base URL is the host, services are listed by the SAP
   * catalog, and `sap-client` / `sap-language` go on every request. Implied
   * by `sapClient`.
   */
  sap?: boolean;
  sapClient?: string;
  sapLanguage?: string;
  /** Allow-list of service paths (glob `*`); empty means every service. */
  services?: string[];
  /** Row cap for one query. Default and maximum 1000. */
  maxRows?: number;
  /** Prefix of the built-in tool names. */
  toolPrefix?: string;
}

export interface ODataCallConfig {
  baseUrl: string;
  authType: string;
  authConfig?: Record<string, unknown>;
  headers?: Record<string, string>;
  connectorId?: string;
  proxyUrl?: string;
}

interface CatalogEntry {
  service: string;
  name: string;
  title?: string;
  description?: string;
  version: 'v2' | 'v4';
}

const CATALOG_TTL_MS = 60 * 60 * 1000;
const METADATA_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ROWS = 1000;
const DEFAULT_TOP = 100;
const MAX_PAGES = 20;
const V2_CATALOG = '/sap/opu/odata/IWFND/CATALOGSERVICE;v=2/ServiceCollection';
const V4_CATALOGS = [
  '/sap/opu/odata4/iwfnd/config/default/iwfnd/catalog/0002/ServiceGroups',
  '/sap/opu/odata4/iwfnd/config/default/iwfnd/catalog/0001/ServiceGroups',
];

export function isODataBuiltinMethod(method: unknown): boolean {
  return typeof method === 'string' && method.startsWith('odata_');
}

@Injectable()
export class ODataEngine {
  private readonly logger = new Logger(ODataEngine.name);
  private readonly catalogCache = new Map<string, { at: number; entries: CatalogEntry[] }>();
  private readonly metadataCache = new Map<string, { at: number; model: ODataServiceModel }>();

  constructor(private readonly rest: RestEngine) {}

  async execute(
    config: ODataCallConfig,
    endpointMapping: Record<string, any>,
    params: Record<string, unknown>,
    rawSettings?: unknown,
  ): Promise<unknown> {
    const settings = normalizeSettings(rawSettings);
    switch (endpointMapping.method) {
      case 'odata_list_services':
        return this.listServices(config, settings, params);
      case 'odata_describe_service':
        return this.describeService(config, settings, params);
      case 'odata_describe_entity':
        return this.describeEntity(config, settings, params);
      case 'odata_query':
        return this.query(config, settings, params);
      case 'odata_get':
        return this.getEntity(config, settings, params);
      case 'odata_metadata_xml': {
        // Used by the "Import from OData $metadata" flow, with the
        // connector's own credentials.
        const service = this.servicePath(params.service, settings);
        const xml = await this.get(config, settings, `${service}/$metadata`, {}, undefined, true);
        if (typeof xml !== 'string') throw new Error('The service did not return a $metadata document.');
        return { service, xml };
      }
      default:
        if (isODataBuiltinMethod(endpointMapping.method)) {
          throw new Error(`Unknown OData tool method "${endpointMapping.method}".`);
        }
        return this.httpTool(config, settings, endpointMapping, params);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Built-in tools                                                     */
  /* ------------------------------------------------------------------ */

  private async listServices(
    config: ODataCallConfig,
    settings: ODataSettings,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (!settings.sap) {
      return {
        services: [{ service: '', name: '(service root)', title: 'The connector base URL is the service' }],
        hint: 'This connector points at a single OData service. Call describe_service without a service argument.',
      };
    }
    const all = (await this.catalog(config, settings, params.refresh === true)).filter((e) =>
      serviceAllowed(e.service, settings.services),
    );
    const terms = String(params.search ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const hits = terms.length
      ? all.filter((e) => {
          const hay = `${e.name} ${e.title ?? ''} ${e.description ?? ''} ${e.service}`.toLowerCase();
          return terms.every((t) => hay.includes(t));
        })
      : all;
    const limit = 100;
    return {
      total: hits.length,
      returned: Math.min(hits.length, limit),
      services: hits.slice(0, limit),
      hint:
        hits.length > limit
          ? 'More services match; narrow the search.'
          : 'Pass a service path to describe_service to see its entity sets.',
    };
  }

  private async describeService(
    config: ODataCallConfig,
    settings: ODataSettings,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const service = this.servicePath(params.service, settings);
    const model = await this.metadata(config, settings, service, params.refresh === true);
    return {
      service: service || '(service root)',
      version: model.version,
      entitySets: model.entitySets.map((set) => {
        const type = model.entityTypes[set.entityType];
        return strip({
          name: set.name,
          label: set.label,
          keys: type?.keys,
          properties: type?.properties.length,
          analytical: set.analytical,
          parameters: set.parameters?.names,
          requiredInFilter: set.requiredInFilter,
          readOnly: set.creatable === false && set.updatable === false && set.deletable === false ? true : undefined,
        });
      }),
      functions: model.functions.length ? model.functions : undefined,
      hint: 'Call describe_entity for the fields of a set before querying it.',
    };
  }

  private async describeEntity(
    config: ODataCallConfig,
    settings: ODataSettings,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const service = this.servicePath(params.service, settings);
    const model = await this.metadata(config, settings, service, false);
    const set = this.entitySet(model, params.entity_set);
    const type = this.entityType(model, set);
    const hints: string[] = [];
    if (set.analytical) {
      hints.push(
        'Analytical set: put the dimensions you want to group by and the measures in select; the server aggregates the measures over the selected dimensions.',
      );
    }
    if (set.parameters) {
      hints.push(
        `Parameterised view: pass parameters as {${set.parameters.names.map((n) => `"${n}": "…"`).join(', ')}}; rows are read through ${set.parameters.resultsNavigation ?? 'its results navigation'}.`,
      );
    }
    if (set.requiredInFilter?.length) {
      hints.push(`The filter must restrict ${set.requiredInFilter.join(', ')}.`);
    }
    const amounts = type.properties.filter((p) => p.unit).map((p) => `${p.name} (in ${p.unit})`);
    if (amounts.length) {
      hints.push(`Amounts and quantities with their currency / unit field: ${amounts.slice(0, 12).join(', ')}. Select the unit field too.`);
    }
    return strip({
      entitySet: set.name,
      label: set.label ?? type.label,
      keys: type.keys,
      analytical: set.analytical,
      parameters: set.parameters,
      requiredInFilter: set.requiredInFilter,
      properties: type.properties,
      navigation: type.navigation.length ? type.navigation : undefined,
      hints: hints.length ? hints : undefined,
    });
  }

  private async query(
    config: ODataCallConfig,
    settings: ODataSettings,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const service = this.servicePath(params.service, settings);
    const model = await this.metadata(config, settings, service, false);
    const set = this.entitySet(model, params.entity_set);
    const version = model.version;
    const cap = Math.min(settings.maxRows ?? MAX_ROWS, MAX_ROWS);
    const top = clampInt(params.top, DEFAULT_TOP, 1, cap);
    const skip = clampInt(params.skip, 0, 0, Number.MAX_SAFE_INTEGER);

    let resource = encodeSegment(set.name);
    let validateAgainst: ODataEntityType | undefined = model.entityTypes[set.entityType];
    if (set.parameters) {
      const values = asObject(params.parameters);
      const missing = set.parameters.names.filter((n) => values[n] === undefined);
      if (missing.length) {
        throw new Error(
          `${set.name} is a parameterised view; pass parameters with ${missing.join(', ')} ` +
            `(describe_entity lists them).`,
        );
      }
      const ptype = model.entityTypes[set.entityType];
      const pred = set.parameters.names
        .map((n) => `${n}=${encodePredicate(formatKeyLiteral(values[n], ptype?.properties.find((p) => p.name === n)?.type ?? 'Edm.String', version))}`)
        .join(',');
      resource = `${resource}(${pred})/${set.parameters.resultsNavigation ?? 'Set'}`;
      // Rows come from the navigation target, whose type the V2 model names
      // by association role only; skip field validation rather than guess.
      validateAgainst = undefined;
    }

    const select = listParam(params.select);
    const orderby = typeof params.orderby === 'string' ? params.orderby.trim() : '';
    if (validateAgainst) {
      const fields = [
        ...validateAgainst.properties.map((p) => p.name),
        ...validateAgainst.navigation.map((n) => n.name),
      ];
      const check = (name: string, where: string) => {
        const base = name.split('/')[0];
        if (!fields.includes(base)) {
          throw new Error(
            `Unknown field "${name}" in ${where} of ${set.name}. Did you mean: ${closest(base, fields).join(', ')}?`,
          );
        }
      };
      select.forEach((f) => check(f, 'select'));
      orderby
        .split(',')
        .map((o) => o.trim().split(/\s+/)[0])
        .filter(Boolean)
        .forEach((f) => check(f, 'orderby'));
    }
    const filter = typeof params.filter === 'string' ? params.filter.trim() : '';
    if (set.requiredInFilter?.length) {
      const absent = set.requiredInFilter.filter((f) => !new RegExp(`\\b${f}\\b`).test(filter));
      if (absent.length) {
        throw new Error(`${set.name} requires a filter on ${absent.join(', ')}.`);
      }
    }
    if (params.apply && version !== 'v4') {
      throw new Error('apply ($apply) needs an OData V4 service. On V2 analytical sets, aggregate by choosing dimensions and measures in select.');
    }

    const query: Record<string, string | undefined> = {
      $select: select.length ? select.join(',') : undefined,
      $filter: filter || undefined,
      $orderby: orderby || undefined,
      $expand: typeof params.expand === 'string' && params.expand.trim() ? params.expand.trim() : undefined,
      $apply: typeof params.apply === 'string' && params.apply.trim() ? params.apply.trim() : undefined,
      $search: typeof params.search === 'string' && params.search.trim() ? params.search.trim() : undefined,
      $top: String(top),
      $skip: skip ? String(skip) : undefined,
    };
    if (params.count !== false) {
      if (version === 'v2') query.$inlinecount = 'allpages';
      else query.$count = 'true';
    }

    const rows: Record<string, unknown>[] = [];
    let count: number | undefined;
    let next: string | undefined;
    let page = 0;
    let body = await this.get(config, settings, `${service}/${resource}`, query, version);
    for (;;) {
      const p = readODataPage(body);
      if (count === undefined && p.count !== undefined) count = p.count;
      rows.push(...p.rows);
      next = p.nextLink;
      page++;
      if (!next || rows.length >= top || page >= MAX_PAGES) break;
      body = await this.getNext(config, settings, next, version);
    }
    const returned = rows.slice(0, top);
    const more = (count !== undefined && skip + returned.length < count) || !!next || rows.length > top;
    return strip({
      entitySet: set.name,
      total: count,
      returned: returned.length,
      truncated: more || undefined,
      nextSkip: more ? skip + returned.length : undefined,
      rows: returned,
    });
  }

  private async getEntity(
    config: ODataCallConfig,
    settings: ODataSettings,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const service = this.servicePath(params.service, settings);
    const model = await this.metadata(config, settings, service, false);
    const set = this.entitySet(model, params.entity_set);
    const type = this.entityType(model, set);
    const predicate = encodePredicate(buildKeyPredicate(params.key, type, model.version));
    const body = await this.get(config, settings, `${service}/${encodeSegment(set.name)}${predicate}`, {
      $select: listParam(params.select).join(',') || undefined,
      $expand: typeof params.expand === 'string' && params.expand.trim() ? params.expand.trim() : undefined,
    }, model.version);
    const page = readODataPage(body);
    return page.rows[0] ?? null;
  }

  /* ------------------------------------------------------------------ */
  /*  Plain HTTP tools on an OData connector                             */
  /* ------------------------------------------------------------------ */

  private async httpTool(
    config: ODataCallConfig,
    settings: ODataSettings,
    endpointMapping: Record<string, any>,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const method = String(endpointMapping.method || 'GET').toUpperCase();
    const queryParams: Record<string, unknown> = { ...(endpointMapping.queryParams ?? {}) };
    const extra: Record<string, unknown> = {};
    this.addSapParams(settings, queryParams, extra);
    const isV2 = settings.version === 'v2' || (settings.version !== 'v4' && settings.sap);
    if (method === 'GET' && isV2 && !Object.keys(queryParams).some((k) => k.toLowerCase() === '$format')) {
      queryParams.$format = 'json';
    }
    const headers: Record<string, string> = { Accept: 'application/json', ...(endpointMapping.headers ?? {}) };
    if (method !== 'GET' && settings.sap) {
      Object.assign(headers, await this.csrf(config, settings, String(endpointMapping.path ?? '')));
    }
    const { body } = await this.rest.executeWithMeta(
      config,
      { ...endpointMapping, method, queryParams, headers } as any,
      { ...params, ...extra },
    );
    if (body && typeof body === 'object' && ('d' in (body as object) || 'value' in (body as object))) {
      const page = readODataPage(body);
      return strip({ total: page.count, returned: page.rows.length, rows: page.rows, next: page.nextLink });
    }
    return body;
  }

  /**
   * SAP Gateway refuses a write without a CSRF token fetched in the same
   * session: GET with `x-csrf-token: Fetch`, then send the token back with
   * the session cookies.
   */
  private async csrf(
    config: ODataCallConfig,
    settings: ODataSettings,
    path: string,
  ): Promise<Record<string, string>> {
    const serviceRoot = path.replace(/\/[^/]*$/, '') || '/';
    const queryParams: Record<string, unknown> = {};
    const extra: Record<string, unknown> = {};
    this.addSapParams(settings, queryParams, extra);
    const { headers } = await this.rest.executeWithMeta(
      config,
      {
        method: 'GET',
        path: serviceRoot,
        queryParams,
        headers: { 'x-csrf-token': 'Fetch', Accept: 'application/json' },
        exposeHeaders: ['x-csrf-token', 'set-cookie'],
      } as any,
      extra,
    );
    const token = headers['x-csrf-token'];
    if (!token) throw new Error('SAP did not return a CSRF token; the write cannot be sent.');
    const cookie = String(headers['set-cookie'] ?? '')
      // Several cookies arrive joined by ", "; an Expires date also holds a
      // comma, but is followed by a day number, not by "name=".
      .split(/,\s*(?=[^\s;=,]+=)/)
      .map((c) => c.split(';')[0].trim())
      .filter(Boolean)
      .join('; ');
    return cookie ? { 'x-csrf-token': token, Cookie: cookie } : { 'x-csrf-token': token };
  }

  /* ------------------------------------------------------------------ */
  /*  Catalog and metadata                                               */
  /* ------------------------------------------------------------------ */

  private async catalog(
    config: ODataCallConfig,
    settings: ODataSettings,
    refresh: boolean,
  ): Promise<CatalogEntry[]> {
    const key = `${config.connectorId ?? config.baseUrl}|${settings.sapClient ?? ''}`;
    const hit = this.catalogCache.get(key);
    if (hit && !refresh && Date.now() - hit.at < CATALOG_TTL_MS) return hit.entries;

    const entries: CatalogEntry[] = [];
    let v2Error: unknown;
    try {
      const body = await this.get(config, settings, V2_CATALOG, {
        $select: 'ID,TechnicalServiceName,TechnicalServiceVersion,Title,Description,ServiceUrl',
      }, 'v2');
      for (const row of readODataPage(body).rows) {
        const service = servicePathFromUrl(String(row.ServiceUrl ?? ''));
        if (!service) continue;
        entries.push(strip({
          service,
          name: String(row.TechnicalServiceName ?? row.ID ?? service),
          title: row.Title ? String(row.Title) : undefined,
          description: row.Description && row.Description !== row.Title ? String(row.Description) : undefined,
          version: 'v2' as const,
        }));
      }
    } catch (err) {
      v2Error = err;
    }
    for (const path of V4_CATALOGS) {
      try {
        const body: any = await this.get(config, settings, path, {
          $expand: 'DefaultSystem($expand=Services)',
        }, 'v4');
        for (const group of Array.isArray(body?.value) ? body.value : []) {
          for (const svc of group?.DefaultSystem?.Services ?? []) {
            const service = servicePathFromUrl(String(svc.ServiceUrl ?? ''));
            if (!service) continue;
            entries.push(strip({
              service,
              name: String(svc.ServiceId ?? service),
              title: group.Description ? String(group.Description) : undefined,
              description: svc.Description ? String(svc.Description) : undefined,
              version: 'v4' as const,
            }));
          }
        }
        break;
      } catch {
        // Older releases have only one of the two V4 catalogs, some none.
      }
    }
    if (entries.length === 0 && v2Error) throw v2Error;
    this.catalogCache.set(key, { at: Date.now(), entries });
    return entries;
  }

  private async metadata(
    config: ODataCallConfig,
    settings: ODataSettings,
    service: string,
    refresh: boolean,
  ): Promise<ODataServiceModel> {
    const key = `${config.connectorId ?? config.baseUrl}|${settings.sapClient ?? ''}|${service}`;
    const hit = this.metadataCache.get(key);
    if (hit && !refresh && Date.now() - hit.at < METADATA_TTL_MS) return hit.model;
    const body = await this.get(config, settings, `${service}/$metadata`, {}, undefined, true);
    if (typeof body !== 'string') {
      throw new Error(`${service || 'The service'} did not return a $metadata document.`);
    }
    const model = parseEdmx(body);
    if (settings.version === 'v2' || settings.version === 'v4') model.version = settings.version;
    this.metadataCache.set(key, { at: Date.now(), model });
    return model;
  }

  /* ------------------------------------------------------------------ */
  /*  HTTP helpers                                                       */
  /* ------------------------------------------------------------------ */

  private addSapParams(
    settings: ODataSettings,
    queryParams: Record<string, unknown>,
    params: Record<string, unknown>,
  ): void {
    const has = (k: string) => Object.keys(queryParams).some((x) => x.toLowerCase() === k);
    if (settings.sapClient && !has('sap-client')) {
      queryParams['sap-client'] = '$__sap_client';
      params.__sap_client = settings.sapClient;
    }
    if (settings.sapLanguage && !has('sap-language')) {
      queryParams['sap-language'] = '$__sap_language';
      params.__sap_language = settings.sapLanguage;
    }
  }

  /**
   * GET a path relative to the connector's base URL. Query values travel as
   * parameters, never spliced into the mapping, so a `$filter` that happens
   * to start with `$` is not mistaken for a parameter reference.
   */
  private async get(
    config: ODataCallConfig,
    settings: ODataSettings,
    path: string,
    query: Record<string, string | undefined>,
    version: 'v2' | 'v4' | undefined,
    raw = false,
  ): Promise<unknown> {
    const queryParams: Record<string, unknown> = {};
    const params: Record<string, unknown> = {};
    let i = 0;
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === '') continue;
      const name = `__q${i++}`;
      queryParams[k] = `$${name}`;
      params[name] = v;
    }
    if (!raw && version === 'v2' && !('$format' in queryParams)) {
      queryParams.$format = 'json';
    }
    this.addSapParams(settings, queryParams, params);
    const { body } = await this.rest.executeWithMeta(
      config,
      {
        method: 'GET',
        path: path.startsWith('/') ? path : `/${path}`,
        queryParams,
        headers: { Accept: raw ? 'application/xml' : 'application/json' },
        rawBody: raw,
      } as any,
      params,
    );
    return body;
  }

  /** Follow a server-driven next link, but only on the connector's own host. */
  private async getNext(
    config: ODataCallConfig,
    settings: ODataSettings,
    next: string,
    version: 'v2' | 'v4',
  ): Promise<unknown> {
    const base = new URL(config.baseUrl);
    const url = new URL(next, base);
    if (url.origin !== base.origin) {
      throw new Error(`The service returned a next link on another host (${url.host}); not followed.`);
    }
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      query[k] = v;
    });
    const queryParams: Record<string, unknown> = {};
    const params: Record<string, unknown> = {};
    let i = 0;
    for (const [k, v] of Object.entries(query)) {
      const name = `__n${i++}`;
      queryParams[k] = `$${name}`;
      params[name] = v;
    }
    if (version === 'v2' && !('$format' in queryParams)) queryParams.$format = 'json';
    this.addSapParams(settings, queryParams, params);
    const { body } = await this.rest.executeWithMeta(
      config,
      {
        method: 'GET',
        path: `${url.origin}${url.pathname}`,
        queryParams,
        headers: { Accept: 'application/json' },
      } as any,
      params,
    );
    return body;
  }

  /* ------------------------------------------------------------------ */
  /*  Model lookups                                                      */
  /* ------------------------------------------------------------------ */

  private servicePath(value: unknown, settings: ODataSettings): string {
    const service = assertSafeServicePath(typeof value === 'string' ? value : '');
    if (settings.sap && !service) {
      throw new Error('Pass the service path, as returned by list_services (e.g. /sap/opu/odata/sap/API_BUSINESS_PARTNER).');
    }
    if (service && !serviceAllowed(service, settings.services)) {
      throw new Error(`Service ${service} is not enabled on this connector.`);
    }
    return service;
  }

  private entitySet(model: ODataServiceModel, name: unknown): ODataEntitySet {
    const wanted = typeof name === 'string' ? name.trim() : '';
    const set =
      model.entitySets.find((s) => s.name === wanted) ??
      model.entitySets.find((s) => s.name.toLowerCase() === wanted.toLowerCase());
    if (!set) {
      const names = model.entitySets.map((s) => s.name);
      throw new Error(
        wanted
          ? `No entity set "${wanted}" in this service. Did you mean: ${closest(wanted, names).join(', ')}?`
          : `Pass entity_set; this service has: ${names.slice(0, 30).join(', ')}.`,
      );
    }
    return set;
  }

  private entityType(model: ODataServiceModel, set: ODataEntitySet): ODataEntityType {
    const type = model.entityTypes[set.entityType];
    if (!type) throw new Error(`The type ${set.entityType} of ${set.name} is not in $metadata.`);
    return type;
  }
}

/* -------------------------------------------------------------------- */

export function normalizeSettings(raw: unknown): ODataSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const sapClient = typeof s.sapClient === 'string' && s.sapClient.trim() ? s.sapClient.trim() : undefined;
  if (sapClient && !/^\d{3}$/.test(sapClient)) {
    throw new Error(`sapClient must be a three-digit SAP client, got "${sapClient}".`);
  }
  const version = s.version === 'v2' || s.version === 'v4' ? s.version : 'auto';
  return {
    version,
    sap: s.sap === true || !!sapClient,
    sapClient,
    sapLanguage: typeof s.sapLanguage === 'string' && s.sapLanguage.trim() ? s.sapLanguage.trim() : undefined,
    services: Array.isArray(s.services) ? (s.services as unknown[]).filter((x): x is string => typeof x === 'string') : undefined,
    maxRows: typeof s.maxRows === 'number' && s.maxRows > 0 ? s.maxRows : undefined,
    toolPrefix: typeof s.toolPrefix === 'string' ? s.toolPrefix : undefined,
  };
}

function servicePathFromUrl(url: string): string {
  if (!url) return '';
  try {
    return new URL(url, 'http://placeholder').pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function listParam(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function asObject(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === 'string' && v.trim().startsWith('{')) {
    try {
      return JSON.parse(v);
    } catch {
      /* fall through */
    }
  }
  return {};
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (v === undefined || v === null || v === '' || !Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

/** Entity set names are identifiers; encode defensively all the same. */
function encodeSegment(s: string): string {
  return encodeURIComponent(s);
}

/**
 * Keep an OData key predicate intact but percent-encode what would otherwise
 * change the URL's structure inside a quoted value (`/`, `?`, `#`, `%`, space).
 */
function encodePredicate(p: string): string {
  return p.replace(/[%/?# ]/g, (c) => encodeURIComponent(c));
}

function strip<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}
