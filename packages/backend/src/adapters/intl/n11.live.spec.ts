import * as adapter from './n11.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';
import { parseXmlBody, renderXmlBodyTemplate } from '../../connectors/engines/rest.engine';
import { assertNoResponseBodyError } from '../../connectors/engines/response-error.util';

/**
 * n11 seller integration API (developer.n11.com): base https://api.n11.com. REST services
 * (/ms/product-query, /ms/product/tasks/*, /cdn/categories, /rest/delivery/v1/*,
 * /rest/order/v1/*) take the appkey and appsecret headers; returns, customer questions and
 * the invoice link exist only as SOAP services (/ws/returnService/, /ws/productService/,
 * /ws/sellerInvoiceService/) with the key and secret inside the envelope.
 * Live part (reads only: products, category tree, shipment packages, return reasons):
 *   N11_APP_KEY=... N11_APP_SECRET=... RUN_N11_LIVE=1 npx jest src/adapters/intl/n11
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; type?: string }>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    bodyEncoding?: string;
    bodyTemplate?: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: unknown;
    headers?: Record<string, unknown>;
  };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; config?: { errorWhen?: unknown } };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
// Every argument a tool reads: {path} segments, "$arg" values and "${arg}" inside strings and body templates.
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
  walk(m.bodyTemplate ?? '');
  return out;
};
const PREFIX = 'n11_';
const soapTools = () => a.tools.filter((t) => t.endpointMapping.path.startsWith('/ws/'));

describe('n11 adapter: static spec conformance', () => {
  it('sends the key and secret as the appkey and appsecret headers', () => {
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.requiredEnvVars).toEqual(['N11_APP_KEY', 'N11_APP_SECRET']);
    expect(a.connector.baseUrl).toBe('https://api.n11.com');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'appkey', apiKey: '{{N11_APP_KEY}}', extraHeaders: { appsecret: '{{N11_APP_SECRET}}' } });
    expect(a.envVarMeta?.N11_APP_SECRET.secret).toBe(true);
  });

  it('maps the documented REST product, category and order services', () => {
    expect(tool('n11_list_products').endpointMapping).toMatchObject({
      method: 'GET',
      path: '/ms/product-query',
      queryParams: { id: '$id', productMainId: '$productMainId', stockCode: '$stockCode', saleStatus: '$saleStatus', productStatus: '$productStatus', brandName: '$brandName', categoryIds: '$categoryIds', page: '$page', size: '$size' },
    });
    expect(tool('n11_list_categories').endpointMapping).toEqual({ method: 'GET', path: '/cdn/categories' });
    expect(tool('n11_get_category_attributes').endpointMapping).toEqual({ method: 'GET', path: '/cdn/category/{categoryId}/attribute' });
    expect(tool('n11_get_task_details').endpointMapping).toEqual({ method: 'POST', path: '/ms/product/task-details/page-query', bodyMapping: { taskId: '$taskId', pageable: { page: '$page', size: '$size' } } });
    for (const [name, path] of [
      ['n11_create_products', '/ms/product/tasks/product-create'],
      ['n11_update_products', '/ms/product/tasks/product-update'],
      ['n11_update_price_and_stock', '/ms/product/tasks/price-stock-update'],
      ['n11_delete_products', '/ms/product/tasks/product-delete'],
    ]) {
      expect(tool(name).endpointMapping).toEqual({ method: 'POST', path, bodyMapping: { payload: { integrator: 'AnythingMCP', skus: '$skus' } } });
    }
    expect(tool('n11_list_shipment_packages').endpointMapping).toMatchObject({
      method: 'GET',
      path: '/rest/delivery/v1/shipmentPackages',
      queryParams: { status: '$status', startDate: '$startDate', endDate: '$endDate', orderNumber: '$orderNumber', packageIds: '$packageIds', orderByField: '$orderByField', orderByDirection: '$orderByDirection', page: '$page', size: '$size' },
    });
    expect(tool('n11_list_shipment_packages').parameters?.properties?.status.enum).toEqual(['Created', 'Picking', 'Shipped', 'Cancelled', 'Delivered', 'Unpacked', 'UnSupplied']);
    expect(tool('n11_approve_order_lines').endpointMapping).toEqual({ method: 'PUT', path: '/rest/order/v1/update', bodyMapping: { lines: '$lines', status: 'Picking' } });
    expect(tool('n11_split_package').endpointMapping).toEqual({ method: 'POST', path: '/rest/delivery/v1/splitCombinePackage', bodyMapping: { splitGroups: '$splitGroups' } });
    expect(tool('n11_split_package_by_quantity').endpointMapping).toEqual({ method: 'POST', path: '/rest/delivery/v1/splitPackageByQuantity', bodyMapping: { splitPackages: '$splitPackages', cancelledItems: '$cancelledItems' } });
    expect(tool('n11_create_collection_request').endpointMapping).toEqual({ method: 'PUT', path: '/rest/delivery/v1/collectionRequest', bodyMapping: { collectionRequestDetails: '$collectionRequestDetails' } });
    expect(tool('n11_send_labor_costs').endpointMapping).toEqual({ method: 'PUT', path: '/rest/order/v1/labor-costs', bodyMapping: { laborCostDetails: '$laborCostDetails' } });
  });

  it('posts SOAP envelopes for returns, questions and the invoice link, with the credentials inside', () => {
    const services: Record<string, string> = {
      n11_list_claim_returns: 'returnService:ClaimReturnList',
      n11_list_return_deny_reasons: 'returnService:ClaimReturnDenyReasonTypes',
      n11_list_return_pending_reasons: 'returnService:ClaimReturnPendingReasonTypes',
      n11_approve_claim_return: 'returnService:ClaimReturnApprove',
      n11_postpone_claim_return: 'returnService:ClaimReturnPending',
      n11_deny_claim_return: 'returnService:ClaimReturnDeny',
      n11_list_product_questions: 'productService:GetProductQuestionList',
      n11_get_product_question: 'productService:GetProductQuestionDetail',
      n11_answer_product_question: 'productService:SaveProductAnswer',
      n11_send_invoice_link: 'sellerInvoiceService:SaveLinkSellerInvoice',
    };
    expect(soapTools().map((t) => t.name).sort()).toEqual(Object.keys(services).sort());
    for (const [name, spec] of Object.entries(services)) {
      const [service, op] = spec.split(':');
      const m = tool(name).endpointMapping;
      expect(m).toMatchObject({ method: 'POST', path: `/ws/${service}/`, bodyEncoding: 'xml', headers: { 'Content-Type': 'text/xml; charset=utf-8' } });
      expect(m.bodyTemplate).toContain(`<sch:${op}Request><auth><appKey>{{N11_APP_KEY}}</appKey><appSecret>{{N11_APP_SECRET}}</appSecret></auth>`);
      expect(m.bodyTemplate).toContain(`</sch:${op}Request></soapenv:Body></soapenv:Envelope>`);
    }
  });

  it('renders a SOAP list request with escaped values and empty optional fields', () => {
    const xml = renderXmlBodyTemplate(tool('n11_list_claim_returns').endpointMapping.bodyTemplate ?? '', { status: 'ALL', searchInfoType: 'ORDERID', searchQuery: 'A&B', currentPage: 0 });
    expect(xml).toContain('<searchData><status>ALL</status><executer></executer><searchInfoType>ORDERID</searchInfoType><searchQuery>A&amp;B</searchQuery>');
    expect(xml).toContain('<pagingData><currentPage>0</currentPage></pagingData>');
    const q = renderXmlBodyTemplate(tool('n11_list_product_questions').endpointMapping.bodyTemplate ?? '', { startDate: '01/10/2026', endDate: '30/10/2026', currentPage: 0, pageSize: 20 });
    expect(q).toContain('<startDate>01/10/2026</startDate><endDate>30/10/2026</endDate></productQuestionSearch><pagingData><currentPage>0</currentPage><pageSize>20</pageSize></pagingData>');
  });

  it('turns a SOAP failure into an error and passes a success through', () => {
    const xml = (op: string, status: string) =>
      `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"><SOAP-ENV:Body><ns3:${op}Response xmlns:ns3="http://www.n11.com/ws/schemas"><result><status>${status}</status><errorMessage>bad id</errorMessage></result></ns3:${op}Response></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
    const parse = (body: string) => parseXmlBody({ data: body, headers: { 'content-type': 'text/xml;charset=utf-8' } });
    const rules = a.connector.config?.errorWhen;
    for (const op of ['ClaimReturnList', 'SaveProductAnswer', 'SaveLinkSellerInvoice', 'ClaimReturnApprove']) {
      expect(() => assertNoResponseBodyError(parse(xml(op, 'failure')), rules)).toThrow(/bad id/);
      expect(() => assertNoResponseBodyError(parse(xml(op, 'success')), rules)).not.toThrow();
    }
    const fault = parse('<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault><faultcode>soap:Client</faultcode><faultstring>Unmarshalling Error</faultstring></soap:Fault></soap:Body></soap:Envelope>');
    expect(() => assertNoResponseBodyError(fault, rules)).toThrow(/Unmarshalling Error/);
  });

  it('drops the long description from the product list', () => {
    const out = applyResponseTransform(
      { content: [{ n11ProductId: 1, stockCode: 'A', description: '<p>long</p>', quantity: 2 }], totalPages: 1 },
      tool('n11_list_products').responseMapping as never,
    ).value;
    expect(out).toEqual({ content: [{ n11ProductId: 1, stockCode: 'A', quantity: 2 }], totalPages: 1 });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('marks reads read-only, writes as writes, and installs delete and deny switched off', () => {
    const reads = ['n11_list_products', 'n11_list_categories', 'n11_get_category_attributes', 'n11_get_task_details', 'n11_list_shipment_packages', 'n11_list_claim_returns', 'n11_list_return_deny_reasons', 'n11_list_return_pending_reasons', 'n11_list_product_questions', 'n11_get_product_question'];
    for (const t of a.tools) expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:${reads.includes(t.name)}`);
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(['n11_delete_products', 'n11_deny_claim_return']);
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(a.probe).toEqual({ tool: 'n11_list_products', params: { size: 1 } });
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const env = process.env;
const live = env.RUN_N11_LIVE === '1' && env.N11_APP_KEY && env.N11_APP_SECRET ? describe : describe.skip;
live('n11 adapter: live (read-only)', () => {
  const headers = { appkey: env.N11_APP_KEY ?? '', appsecret: env.N11_APP_SECRET ?? '', Accept: 'application/json' };
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers });
    expect(res.status).toBe(200);
    return res.json() as Promise<Record<string, unknown>>;
  };
  it('reads products, the category tree and shipment packages', async () => {
    expect(Array.isArray((await get('/ms/product-query?page=0&size=1')).content)).toBe(true);
    expect(Array.isArray((await get('/cdn/categories')).categories)).toBe(true);
    expect((await get('/rest/delivery/v1/shipmentPackages?page=0&size=1')).content).toBeDefined();
  }, 60_000);
  it('reads the return deny reasons over SOAP', async () => {
    const body = renderXmlBodyTemplate(tool('n11_list_return_deny_reasons').endpointMapping.bodyTemplate ?? '', {})
      .replace('{{N11_APP_KEY}}', env.N11_APP_KEY ?? '')
      .replace('{{N11_APP_SECRET}}', env.N11_APP_SECRET ?? '');
    const res = await fetch(`${a.connector.baseUrl}/ws/returnService/`, { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8' }, body });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<status>success</status>');
  }, 60_000);
});
