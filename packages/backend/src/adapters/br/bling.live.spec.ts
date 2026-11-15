import * as adapter from './bling.json';
/**
 * Bling ERP API v3 adapter.
 *
 * Static checks always run: the authorization-code sign-in with the client in
 * a Basic header at the token endpoint and no PKCE, every route against Bling's
 * published OpenAPI reference (https://developer.bling.com.br/referencia), the
 * bracketed array query keys, the write bodies, and that issuing an NF-e and
 * the deletes install switched off. No tool posts receivables or moves money.
 *
 * Live checks run only with RUN_BLING_LIVE=1 and BLING_ACCESS_TOKEN (a token
 * from a finished sign-in) set: they read the company and one page of
 * products. Reads only.
 *
 *   RUN_BLING_LIVE=1 BLING_ACCESS_TOKEN=... npx jest src/adapters/br/bling.live.spec.ts
 */
type Mapping = {
  method: string;
  path: string;
  queryParams?: Record<string, unknown>;
  bodyMapping?: unknown;
  envDefaults?: Record<string, string>;
  encodePathParams?: boolean;
};
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string }>; required?: string[] };
  endpointMapping: Mapping;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  instructions: string;
  description: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean; kind?: string; label?: string; help?: string }>;
  verifyHints: Record<string, unknown>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: { type: string; baseUrl: string; authType: string; authConfig: Record<string, unknown>; headers?: Record<string, string>; config?: Record<string, unknown> };
  tools: Tool[];
};
const tool = (name: string): Tool => {
  const found = a.tools.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};
const pathParams = (path: string): string[] => [...path.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)].map((m) => m[1]);
const refs = (value: unknown, out: Set<string> = new Set<string>()): Set<string> => {
  if (typeof value === 'string') {
    if (/^\$\w+$/.test(value)) out.add(value.slice(1));
  } else if (Array.isArray(value)) {
    value.forEach((item) => refs(item, out));
  } else if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => refs(item, out));
  }
  return out;
};
const outsideBackticks = (text: string): string => text.replace(/`[^`]*`/g, '');

const ROUTES: Record<string, [string, string]> = {
  bling_get_company: ["GET", "/empresas/me/dados-basicos"],
  bling_list_products: ["GET", "/produtos"],
  bling_get_product: ["GET", "/produtos/{id_produto}"],
  bling_create_product: ["POST", "/produtos"],
  bling_update_product: ["PATCH", "/produtos/{id_produto}"],
  bling_delete_product: ["DELETE", "/produtos/{id_produto}"],
  bling_list_product_categories: ["GET", "/categorias/produtos"],
  bling_get_stock_balances: ["GET", "/estoques/saldos"],
  bling_get_warehouse_stock_balances: ["GET", "/estoques/saldos/{id_deposito}"],
  bling_create_stock_movement: ["POST", "/estoques"],
  bling_list_warehouses: ["GET", "/depositos"],
  bling_list_orders: ["GET", "/pedidos/vendas"],
  bling_get_order: ["GET", "/pedidos/vendas/{id_pedido_venda}"],
  bling_create_order: ["POST", "/pedidos/vendas"],
  bling_update_order_status: ["PATCH", "/pedidos/vendas/{id_pedido_venda}/situacoes/{id_situacao}"],
  bling_delete_order: ["DELETE", "/pedidos/vendas/{id_pedido_venda}"],
  bling_list_status_modules: ["GET", "/situacoes/modulos"],
  bling_list_statuses: ["GET", "/situacoes/modulos/{id_modulo_sistema}"],
  bling_list_contacts: ["GET", "/contatos"],
  bling_get_contact: ["GET", "/contatos/{id_contato}"],
  bling_create_contact: ["POST", "/contatos"],
  bling_update_contact: ["PUT", "/contatos/{id_contato}"],
  bling_list_invoices: ["GET", "/nfe"],
  bling_get_invoice: ["GET", "/nfe/{id_nota_fiscal}"],
  bling_generate_invoice_from_order: ["POST", "/pedidos/vendas/{id_pedido_venda}/gerar-nfe"],
  bling_send_invoice: ["POST", "/nfe/{id_nota_fiscal}/enviar"],
  bling_list_receivables: ["GET", "/contas/receber"],
  bling_get_receivable: ["GET", "/contas/receber/{id_conta_receber}"],
  bling_list_payables: ["GET", "/contas/pagar"],
  bling_list_payment_methods: ["GET", "/formas-pagamentos"],
};
const SWITCHED_OFF = [
  "bling_delete_order",
  "bling_delete_product",
  "bling_send_invoice",
];
const REQUIRED: Record<string, string[]> = {
  bling_get_company: [],
  bling_list_products: [],
  bling_get_product: ["id_produto"],
  bling_create_product: ["formato", "nome", "situacao", "tipo"],
  bling_update_product: ["id_produto"],
  bling_delete_product: ["id_produto"],
  bling_list_product_categories: [],
  bling_get_stock_balances: ["ids_produtos"],
  bling_get_warehouse_stock_balances: ["id_deposito", "ids_produtos"],
  bling_create_stock_movement: ["id_deposito", "id_produto", "operacao", "quantidade"],
  bling_list_warehouses: [],
  bling_list_orders: [],
  bling_get_order: ["id_pedido_venda"],
  bling_create_order: ["order"],
  bling_update_order_status: ["id_pedido_venda", "id_situacao"],
  bling_delete_order: ["id_pedido_venda"],
  bling_list_status_modules: [],
  bling_list_statuses: ["id_modulo_sistema"],
  bling_list_contacts: [],
  bling_get_contact: ["id_contato"],
  bling_create_contact: ["nome", "situacao", "tipo"],
  bling_update_contact: ["contact", "id_contato"],
  bling_list_invoices: [],
  bling_get_invoice: ["id_nota_fiscal"],
  bling_generate_invoice_from_order: ["id_pedido_venda"],
  bling_send_invoice: ["id_nota_fiscal"],
  bling_list_receivables: [],
  bling_get_receivable: ["id_conta_receber"],
  bling_list_payables: [],
  bling_list_payment_methods: [],
};
const PROBE = {"tool": "bling_get_company", "params": {}};
const PROBE_METHOD = "GET";

describe('bling adapter: static contract', () => {
  it('signs in with the authorization code flow of the seller\'s own Bling app', () => {
    expect(a.slug).toBe('bling');
    expect(a.region).toBe('br');
    expect(a.category).toBe('erp');
    expect(a.connector.baseUrl).toBe('https://api.bling.com.br/Api/v3');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{BLING_CLIENT_ID}}',
      clientSecret: '{{BLING_CLIENT_SECRET}}',
      authorizationUrl: 'https://www.bling.com.br/Api/v3/oauth/authorize',
      tokenUrl: 'https://api.bling.com.br/Api/v3/oauth/token',
      tokenAuthMethod: 'client_secret_basic',
      pkce: false,
    });
    expect(a.requiredEnvVars).toEqual(['BLING_CLIENT_ID', 'BLING_CLIENT_SECRET']);
    expect(a.envVarMeta.BLING_CLIENT_SECRET.secret).toBe(true);
  });

  it('uses the bracketed array keys of the reference', () => {
    expect(tool('bling_list_products').endpointMapping.queryParams).toMatchObject({ 'codigos[]': '$codigos', 'idsProdutos[]': '$ids_produtos', 'gtins[]': '$gtins' });
    expect(tool('bling_list_orders').endpointMapping.queryParams).toMatchObject({ 'idsSituacoes[]': '$ids_situacoes' });
    expect(tool('bling_get_stock_balances').endpointMapping.queryParams).toEqual({ 'idsProdutos[]': '$ids_produtos', 'codigos[]': '$codigos' });
  });

  it('keeps NF-e issuing and deletes switched off and has no money actions', () => {
    expect(tool('bling_send_invoice').enabled).toBe(false);
    for (const t of a.tools) if (t.endpointMapping.method === 'DELETE') expect(t.enabled).toBe(false);
    const paths = a.tools.map((t) => t.endpointMapping.path).join(' ');
    expect(paths).not.toMatch(/baixar|lancar-contas|estornar|boletos/);
    for (const t of a.tools) if (/^\/contas\//.test(t.endpointMapping.path)) expect(t.endpointMapping.method).toBe('GET');
    expect(tool('bling_create_stock_movement').endpointMapping.bodyMapping).toEqual({
      produto: { id: '$id_produto' }, deposito: { id: '$id_deposito' }, operacao: '$operacao', quantidade: '$quantidade', custo: '$custo', observacoes: '$observacoes',
    });
  });

  it('pins the method and path of every tool', () => {
    const actual: Record<string, [string, string]> = {};
    for (const t of a.tools) actual[t.name] = [t.endpointMapping.method, t.endpointMapping.path];
    expect(actual).toEqual(ROUTES);
  });

  it('installs exactly the risky tools switched off', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([...SWITCHED_OFF].sort());
  });

  it('wires every parameter into the request and requires every path parameter', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      const used = refs([m.queryParams ?? {}, m.bodyMapping ?? {}]);
      for (const p of pathParams(m.path)) used.add(p);
      for (const p of Object.keys(m.envDefaults ?? {})) used.add(p);
      for (const p of Object.keys(t.parameters.properties ?? {})) expect(`${t.name}:${p}:${used.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of pathParams(m.path)) expect(`${t.name}:${p}:${(t.parameters.required ?? []).includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const r of t.parameters.required ?? []) expect(`${t.name}:${r}:${r in (t.parameters.properties ?? {})}`).toBe(`${t.name}:${r}:true`);
    }
  });

  it('pins the required parameters of every tool', () => {
    const actual: Record<string, string[]> = {};
    for (const t of a.tools) actual[t.name] = [...(t.parameters.required ?? [])].sort();
    expect(actual).toEqual(REQUIRED);
  });

  it('names every tool in the instructions, prefixes it with the slug and keeps the text MDX-safe', () => {
    const prefix = `${a.slug.replace(/-/g, '_')}_`;
    for (const t of a.tools) {
      expect(t.name.startsWith(prefix)).toBe(true);
      expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
      expect(outsideBackticks(t.description)).not.toMatch(/[{}<]/);
      for (const [p, d] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${Boolean(d.description)}`).toBe(`${t.name}.${p}:true`);
        expect(outsideBackticks(d.description ?? '')).not.toMatch(/[{}<]/);
      }
    }
    expect(outsideBackticks(a.instructions)).not.toMatch(/[{}<]/);
    expect(outsideBackticks(a.description)).not.toMatch(/[{}<]/);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });

  it('describes every variable and probes with a cheap read', () => {
    for (const v of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) {
      expect(a.envVarMeta[v]).toMatchObject({ label: expect.any(String), kind: expect.any(String), help: expect.any(String) });
    }
    expect(a.probe).toEqual(PROBE);
    expect(tool(a.probe.tool).endpointMapping.method).toBe(PROBE_METHOD);
    for (const status of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[status]).toBeDefined();
  });
});

const live = process.env.RUN_BLING_LIVE === '1' ? describe : describe.skip;
live('bling adapter: live reads', () => {
  it('reads the company and one page of products', async () => {
    const headers = { Authorization: `Bearer ${process.env.BLING_ACCESS_TOKEN}`, Accept: 'application/json' };
    for (const path of ['/empresas/me/dados-basicos', '/produtos?limite=1']) {
      const res = await fetch(`https://api.bling.com.br/Api/v3${path}`, { headers });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { data?: unknown }).data).toBeDefined();
    }
  });
});
