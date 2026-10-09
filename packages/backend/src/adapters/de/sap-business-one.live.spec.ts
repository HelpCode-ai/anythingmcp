import * as adapter from './sap-business-one.json';

type Tool = {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, string>;
    headers?: Record<string, string>;
    bodyMapping?: Record<string, unknown>;
  };
};
const a = adapter as unknown as {
  requiredEnvVars: string[];
  connector: { baseUrl: string; authType: string; authConfig: Record<string, unknown> };
  tools: Tool[];
};
const byName = new Map(a.tools.map((t) => [t.name, t]));
// A list tool reads an entity set: GET on a path without a key in brackets
// and not a service call (CompanyService_GetAdminInfo returns one object).
const listTools = a.tools.filter(
  (t) =>
    t.endpointMapping.method === 'GET' &&
    !t.endpointMapping.path.includes('(') &&
    !t.endpointMapping.path.includes('Service_'),
);

describe('sap-business-one adapter — static spec conformance', () => {
  it('logs in to the v2 Service Layer and reuses the B1SESSION cookie', () => {
    expect(a.connector.baseUrl).toBe('https://{{SAP_B1_HOST}}:{{SAP_B1_PORT}}/b1s/v2');
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig.cookieName).toBe('B1SESSION');
  });

  it('asks for pages of 100 rows on every list tool', () => {
    // The Service Layer returns 20 rows per call by default, whatever $top
    // says; without the header a model pages through a ledger 20 rows at a time.
    expect(listTools.length).toBeGreaterThan(10);
    for (const t of listTools) {
      expect([t.name, t.endpointMapping.headers?.Prefer]).toEqual([t.name, 'odata.maxpagesize=100']);
    }
  });

  it('lets every list tool page, filter, select and sort', () => {
    for (const t of listTools) {
      expect([t.name, Object.keys(t.endpointMapping.queryParams ?? {}).sort()]).toEqual([
        t.name,
        ['$filter', '$orderby', '$select', '$skip', '$top'],
      ]);
    }
  });

  it('covers the finance documents', () => {
    const paths = listTools.map((t) => t.endpointMapping.path);
    for (const p of [
      '/PurchaseInvoices',
      '/PurchaseCreditNotes',
      '/CreditNotes',
      '/VendorPayments',
      '/IncomingPayments',
      '/JournalEntries',
      '/ChartOfAccounts',
      '/BankStatements',
    ]) {
      expect(paths).toContain(p);
    }
  });

  it('reads reconciliations through the reconciliation service, not an entity set', () => {
    // /ExternalReconciliations does not exist ("Unrecognized resource path").
    const list = byName.get('b1_list_external_reconciliations')!;
    const one = byName.get('b1_get_external_reconciliation')!;
    expect(list.endpointMapping).toMatchObject({
      method: 'POST',
      path: '/ExternalReconciliationsService_GetReconciliationList',
    });
    expect(Object.keys(list.endpointMapping.bodyMapping ?? {})).toEqual([
      'ExternalReconciliationFilterParams',
    ]);
    expect(one.endpointMapping).toMatchObject({
      method: 'POST',
      path: '/ExternalReconciliationsService_GetReconciliation',
    });
    expect(list.annotations?.readOnlyHint).toBe(true);
    expect(one.annotations?.readOnlyHint).toBe(true);
  });

  it('writes only through b1_create_order', () => {
    const writes = a.tools.filter(
      (t) => t.endpointMapping.method !== 'GET' && !t.annotations?.readOnlyHint,
    );
    expect(writes.map((t) => t.name)).toEqual(['b1_create_order']);
  });
});

// Opt-in live check against a real Service Layer. Needs the five SAP_B1_*
// variables; skipped in CI.
const live = process.env.RUN_SAP_BUSINESS_ONE_LIVE === '1';
(live ? describe : describe.skip)('sap-business-one — live', () => {
  const base = `https://${process.env.SAP_B1_HOST}:${process.env.SAP_B1_PORT}/b1s/v2`;

  it('returns more than 20 rows in one call when asked for a larger page', async () => {
    const login = await fetch(`${base}/Login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        UserName: process.env.SAP_B1_USERNAME,
        Password: process.env.SAP_B1_PASSWORD,
        CompanyDB: process.env.SAP_B1_COMPANY_DB,
      }),
    });
    expect(login.status).toBe(200);
    const { SessionId } = (await login.json()) as { SessionId: string };
    const res = await fetch(`${base}/ChartOfAccounts?$select=Code&$top=50`, {
      headers: { Cookie: `B1SESSION=${SessionId}`, Prefer: 'odata.maxpagesize=100' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { value: unknown[] };
    // Every company has more than 20 G/L accounts.
    expect(body.value.length).toBeGreaterThan(20);
  });
});
