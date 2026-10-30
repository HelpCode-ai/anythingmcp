import * as adapter from './eurostat.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { parseXmlBody } from '../../connectors/engines/rest.engine';

/**
 * Eurostat dissemination APIs (ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access):
 * the Statistics API 1.0 (JSON-stat 2.0, dimension filters as query parameters), SDMX 2.1
 * structure and data queries, the update RSS feed and the Comext statistics API. Keyless.
 * Live part (reads only, no key needed):
 *   RUN_EUROSTAT_LIVE=1 npx jest src/adapters/intl/eurostat
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; type?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  requiredEnvVars: string[];
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: unknown };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const used = (t: Tool) => {
  const m = t.endpointMapping;
  const out = new Set<string>();
  for (const [, p] of m.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) out.add(p);
  const walk = (v: unknown) => {
    if (typeof v === 'string') {
      if (v.startsWith('$') && !v.includes('${')) out.add(v.slice(1));
      for (const [, p] of v.matchAll(/\$\{(\w+)\}/g)) out.add(p);
    } else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(m.queryParams ?? {});
  walk(m.bodyMapping ?? {});
  walk(m.headers ?? {});
  return out;
};
const shape = (raw: unknown, t: Tool) => applyResponseTransform(raw, t.responseMapping as never);
const xml = (data: string) => parseXmlBody({ data, headers: { 'content-type': 'application/vnd.sdmx.structure+xml;version=2.1' } });
const D = '/eurostat/api/dissemination';
const C = '/eurostat/api/comext/dissemination';

describe('eurostat adapter: static spec conformance', () => {
  it('is keyless on the ec.europa.eu host', () => {
    expect(a.requiredEnvVars).toEqual([]);
    expect(a.connector.baseUrl).toBe('https://ec.europa.eu');
    expect(a.connector.authType).toBe('NONE');
    expect(a.connector.authConfig).toBeUndefined();
    for (const t of a.tools) {
      expect(t.endpointMapping.method).toBe('GET');
      expect(t.endpointMapping.path.startsWith(D) || t.endpointMapping.path.startsWith(C)).toBe(true);
    }
  });

  it('maps the Statistics API with list filters and the raw dimension filter string', () => {
    expect(tool('eurostat_get_data').endpointMapping).toEqual({
      method: 'GET',
      path: `${D}/statistics/1.0/data/{dataset}`,
      queryParams: {
        format: 'JSON',
        lang: '$lang',
        geo: '$geo',
        time: '$time',
        sinceTimePeriod: '$sinceTimePeriod',
        untilTimePeriod: '$untilTimePeriod',
        lastTimePeriod: '$lastTimePeriod',
        geoLevel: '$geoLevel',
        unit: '$unit',
        freq: '$freq',
        __rawquery: '$filters',
      },
    });
    for (const p of ['geo', 'time', 'unit', 'freq']) expect(tool('eurostat_get_data').parameters?.properties?.[p].type).toBe('array');
    expect(tool('eurostat_get_data').parameters?.properties?.lang.enum).toEqual(['EN', 'FR', 'DE']);
    expect(tool('eurostat_get_data').parameters?.properties?.geoLevel.enum).toEqual(['aggregate', 'country', 'nuts1', 'nuts2', 'nuts3', 'city']);
    expect(tool('eurostat_get_comext_data').endpointMapping).toMatchObject({
      path: `${C}/statistics/1.0/data/{dataset}`,
      queryParams: { format: 'JSON', reporter: '$reporter', partner: '$partner', product: '$product', flow: '$flow', indicators: '$indicators', __rawquery: '$filters' },
    });
  });

  it('maps the SDMX 2.1 data, dataflow, datastructure, content constraint and codelist queries', () => {
    expect(tool('eurostat_get_series').endpointMapping).toEqual({
      method: 'GET',
      path: `${D}/sdmx/2.1/data/{dataset}/{key}`,
      queryParams: { format: 'JSON', startPeriod: '$startPeriod', endPeriod: '$endPeriod', lastNObservations: '$lastNObservations', firstNObservations: '$firstNObservations', lang: '$lang' },
    });
    expect(tool('eurostat_get_dataset_info').endpointMapping).toEqual({ method: 'GET', path: `${D}/sdmx/2.1/dataflow/ESTAT/{dataset}/latest`, queryParams: { format: 'JSON', lang: '$lang' } });
    expect(tool('eurostat_get_dataset_codes').endpointMapping).toEqual({ method: 'GET', path: `${D}/sdmx/2.1/dataflow/ESTAT/{dataset}/latest`, queryParams: { references: 'descendants', detail: 'referencepartial' } });
    expect(tool('eurostat_get_dataset_structure').endpointMapping.path).toBe(`${D}/sdmx/2.1/datastructure/ESTAT/{datastructure}/latest`);
    expect(tool('eurostat_get_dataset_availability').endpointMapping.path).toBe(`${D}/sdmx/2.1/contentconstraint/ESTAT/{dataset}/latest`);
    expect(tool('eurostat_get_codelist').endpointMapping).toEqual({ method: 'GET', path: `${D}/sdmx/2.1/codelist/ESTAT/{codelist}/latest`, queryParams: { format: 'JSON', lang: '$lang' } });
    expect(tool('eurostat_list_recent_updates').endpointMapping.path).toBe(`${D}/catalogue/rss/en/statistics-update.rss`);
    expect(tool('eurostat_list_comext_datasets').endpointMapping).toEqual({ method: 'GET', path: `${C}/sdmx/2.1/dataflow/ESTAT/all`, queryParams: { detail: 'allstubs', format: 'JSON', lang: 'en' } });
  });

  it('reduces the SDMX-ML structure messages to dimensions, codes and labels', () => {
    const msg = `<?xml version="1.0"?><m:Structure xmlns:m="m" xmlns:s="s" xmlns:c="c"><m:Structures>
      <s:Dataflows><s:Dataflow id="NAMA_10_GDP"><c:Name xml:lang="fr">PIB</c:Name><c:Name xml:lang="en">GDP</c:Name></s:Dataflow></s:Dataflows>
      <s:Codelists><s:Codelist id="FREQ"><c:Name xml:lang="en">Time frequency</c:Name><s:Code id="A"><c:Name xml:lang="en">Annual</c:Name></s:Code></s:Codelist>
        <s:Codelist id="GEO"><c:Name xml:lang="en">Geo</c:Name><s:Code id="DE"><c:Name xml:lang="de">Deutschland</c:Name><c:Name xml:lang="en">Germany</c:Name></s:Code><s:Code id="FR"><c:Name xml:lang="en">France</c:Name></s:Code></s:Codelist></s:Codelists>
      <s:DataStructures><s:DataStructure id="NAMA_10_GDP" version="141.0"><s:DataStructureComponents><s:DimensionList>
        <s:Dimension id="freq" position="1"><s:LocalRepresentation><s:Enumeration><Ref id="FREQ"/></s:Enumeration></s:LocalRepresentation></s:Dimension>
        <s:Dimension id="geo" position="2"><s:LocalRepresentation><s:Enumeration><Ref id="GEO"/></s:Enumeration></s:LocalRepresentation></s:Dimension>
        <s:TimeDimension id="TIME_PERIOD" position="3"/></s:DimensionList>
        <s:AttributeList><s:Attribute id="OBS_FLAG" assignmentStatus="Conditional"><s:LocalRepresentation><s:Enumeration><Ref id="OBS_FLAG"/></s:Enumeration></s:LocalRepresentation></s:Attribute></s:AttributeList>
      </s:DataStructureComponents></s:DataStructure></s:DataStructures></m:Structures></m:Structure>`;
    expect(shape(xml(msg), tool('eurostat_get_dataset_codes')).value).toEqual({
      dataset: 'NAMA_10_GDP',
      title: 'GDP',
      dimensions: [
        { id: 'freq', position: '1', codelist: 'FREQ' },
        { id: 'geo', position: '2', codelist: 'GEO' },
      ],
      codelists: [
        { id: 'FREQ', name: 'Time frequency', codes: [{ id: 'A', label: 'Annual' }] },
        { id: 'GEO', name: 'Geo', codes: [{ id: 'DE', label: 'Germany' }, { id: 'FR', label: 'France' }] },
      ],
    });
    expect(shape(xml(msg), tool('eurostat_get_dataset_structure')).value).toEqual({
      id: 'NAMA_10_GDP',
      version: '141.0',
      dimensions: [
        { id: 'freq', position: '1', codelist: 'FREQ' },
        { id: 'geo', position: '2', codelist: 'GEO' },
      ],
      time_dimension: 'TIME_PERIOD',
      attributes: [{ id: 'OBS_FLAG', codelist: 'OBS_FLAG', status: 'Conditional' }],
    });
    const cc = `<m:Structure xmlns:m="m" xmlns:s="s" xmlns:c="c"><m:Structures><s:Constraints><s:ContentConstraint id="NAMA_10_GDP">
      <s:ConstraintAttachment><s:Dataflow><Ref id="NAMA_10_GDP"/></s:Dataflow></s:ConstraintAttachment>
      <s:CubeRegion include="true"><c:KeyValue id="freq"><c:Value>A</c:Value></c:KeyValue><c:KeyValue id="geo"><c:Value>DE</c:Value><c:Value>FR</c:Value></c:KeyValue></s:CubeRegion>
      </s:ContentConstraint></s:Constraints></m:Structures></m:Structure>`;
    expect(shape(xml(cc), tool('eurostat_get_dataset_availability')).value).toEqual({
      dataset: 'NAMA_10_GDP',
      dimensions: [
        { id: 'freq', count: 1, values: ['A'] },
        { id: 'geo', count: 2, values: ['DE', 'FR'] },
      ],
    });
  });

  it('groups the update feed by kind of change and keeps the dataflow annotations without the DOI XML', () => {
    const rss = parseXmlBody({
      data: `<rss><channel><pubDate>2026-10-30 15:44:02</pubDate>
        <item><title>EI_ISBU_M - "Dataset: updated data"</title><category>UPDATED_DATASET_DATA</category><pubDate>d1</pubDate><description>Construction</description></item>
        <item><title>EF_MP_SPLAN - "Dataset: new"</title><category>NEW_DATASET</category><pubDate>d2</pubDate><description>Safety plans</description></item>
        <item><title>NAMQ_10_GDP - "Dataset: updated structure and data"</title><category>UPDATED_DATASET_STRUCTURE_DATA</category><pubDate>d3</pubDate><description>GDP</description></item>
        <item><title>GEO - "Code list: updated"</title><category>UPDATED_CODE_LIST</category><pubDate>d4</pubDate><description>Geo</description></item>
      </channel></rss>`,
      headers: { 'content-type': 'application/xml' },
    });
    expect(shape(rss, tool('eurostat_list_recent_updates')).value).toEqual({
      published: '2026-10-30 15:44:02',
      new_datasets: [{ id: 'EF_MP_SPLAN', title: 'Safety plans', date: 'd2' }],
      deleted_datasets: [],
      structure_changes: ['NAMQ_10_GDP'],
      data_updates: ['EI_ISBU_M'],
      code_list_changes: [{ id: 'GEO', change: 'UPDATED_CODE_LIST', date: 'd4' }],
    });
    const info = shape(
      {
        label: 'GDP',
        extension: { id: 'NAMA_10_GDP', datastructure: { id: 'NAMA_10_GDP' }, annotation: [{ type: 'OBS_COUNT', title: '1087862' }, { type: 'DISSEMINATION_DOI_XML', title: '<adms/>' }] },
      },
      tool('eurostat_get_dataset_info'),
    ).value as { annotations: Array<{ type: string }> };
    expect(info).toMatchObject({ id: 'NAMA_10_GDP', label: 'GDP', datastructure: 'NAMA_10_GDP' });
    expect(info.annotations.map((x) => x.type)).toEqual(['OBS_COUNT']);
    expect(shape({ label: 'x', value: { 0: 1 }, extension: { id: 'X', annotation: [1] } }, tool('eurostat_get_data')).value).toEqual({ label: 'x', value: { 0: 1 }, extension: { id: 'X' } });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith('eurostat_')).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('is read-only, probes with a tool without required parameters and documents every tool', () => {
    for (const t of a.tools) {
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      expect(t.annotations?.readOnlyHint === false).toBe(false);
    }
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_EUROSTAT_LIVE === '1' ? describe : describe.skip;
live('eurostat adapter: live (read-only, keyless)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Accept: 'application/json, application/xml;q=0.9, */*;q=0.8' } });
    expect(`${res.status} ${path}`).toBe(`200 ${path}`);
    const text = await res.text();
    const type = res.headers.get('content-type') ?? '';
    return type.includes('json') ? JSON.parse(text) : parseXmlBody({ data: text, headers: { 'content-type': type } });
  };
  type JsonStat = { id: string[]; size: number[]; value: Record<string, number>; dimension: Record<string, { category: { index: Record<string, number> } }> };

  it('reads GDP through the Statistics API and the SDMX series key', async () => {
    const stat = (await get(`${D}/statistics/1.0/data/nama_10_gdp?format=JSON&lang=EN&geo=DE&geo=FR&unit=CP_MEUR&na_item=B1GQ&lastTimePeriod=1`)) as JsonStat;
    expect(stat.id).toEqual(['freq', 'unit', 'na_item', 'geo', 'time']);
    expect(Object.keys(stat.dimension.geo.category.index).sort()).toEqual(['DE', 'FR']);
    expect(Object.values(stat.value).every((v) => v > 100000)).toBe(true);
    const series = (await get(`${D}/sdmx/2.1/data/nama_10_gdp/A.CP_MEUR.B1GQ.DE+FR?format=JSON&lastNObservations=1`)) as JsonStat;
    expect(Object.keys(series.dimension.geo.category.index).sort()).toEqual(['DE', 'FR']);
  }, 60_000);

  it('reads dataset info, codes, structure, availability and a code list', async () => {
    const info = shape(await get(`${D}/sdmx/2.1/dataflow/ESTAT/une_rt_m/latest?format=JSON&lang=en`), tool('eurostat_get_dataset_info')).value as { id: string; annotations: Array<{ type: string }> };
    expect(info.id).toBe('UNE_RT_M');
    expect(info.annotations.map((x) => x.type)).toContain('OBS_PERIOD_OVERALL_LATEST');
    const codes = shape(await get(`${D}/sdmx/2.1/dataflow/ESTAT/une_rt_m/latest?references=descendants&detail=referencepartial`), tool('eurostat_get_dataset_codes')).value as {
      dimensions: Array<{ id: string }>;
      codelists: Array<{ id: string; codes: Array<{ id: string; label: string }> }>;
    };
    expect(codes.dimensions.map((d) => d.id)).toEqual(['freq', 's_adj', 'age', 'unit', 'sex', 'geo']);
    expect(codes.codelists.find((c) => c.id === 'GEO')?.codes).toContainEqual({ id: 'DE', label: 'Germany' });
    const dsd = shape(await get(`${D}/sdmx/2.1/datastructure/ESTAT/UNE_RT_M/latest`), tool('eurostat_get_dataset_structure')).value as { time_dimension: string; dimensions: unknown[] };
    expect(dsd.time_dimension).toBe('TIME_PERIOD');
    expect(dsd.dimensions).toHaveLength(6);
    const avail = shape(await get(`${D}/sdmx/2.1/contentconstraint/ESTAT/une_rt_m/latest`), tool('eurostat_get_dataset_availability')).value as { dimensions: Array<{ id: string; values: string[] }> };
    expect(avail.dimensions.find((d) => d.id === 'geo')?.values).toContain('DE');
    const cl = shape(await get(`${D}/sdmx/2.1/codelist/ESTAT/FREQ/latest?format=JSON&lang=en`), tool('eurostat_get_codelist')).value as { id: string; codes: Record<string, string> };
    expect(cl.id).toBe('FREQ');
    expect(cl.codes.A).toBe('Annual');
  }, 120_000);

  it('reads the update feed, the Comext dataset list and Comext trade data', async () => {
    const rss = shape(await get(`${D}/catalogue/rss/en/statistics-update.rss`), tool('eurostat_list_recent_updates')).value as { data_updates: string[] };
    expect(rss.data_updates.length).toBeGreaterThan(0);
    const list = shape(await get(`${C}/sdmx/2.1/dataflow/ESTAT/all?detail=allstubs&format=JSON&lang=en`), tool('eurostat_list_comext_datasets')).value as Array<{ id: string }>;
    expect(list.map((x) => x.id)).toContain('DS-045409');
    const trade = (await get(`${C}/statistics/1.0/data/DS-045409?format=JSON&reporter=DE&partner=US&product=TOTAL&flow=2&indicators=VALUE_IN_EUROS&freq=A&sinceTimePeriod=2023`)) as JsonStat;
    expect(Object.values(trade.value).length).toBeGreaterThan(0);
  }, 120_000);
});
