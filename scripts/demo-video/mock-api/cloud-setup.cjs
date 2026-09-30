/**
 * Creates the demo MCP server and its three connectors on AnythingMCP Cloud,
 * through the backend's own API, pointing at the mock container.
 *
 * Runs inside the backend container (it signs a short-lived JWT for the
 * workspace owner with the backend's JWT_SECRET):
 *
 *   docker cp cloud-setup.cjs amcp-cloud-backend:/tmp/
 *   docker exec -e NODE_PATH=/app/backend/node_modules \
 *     -e DEMO_USER_ID=... -e DEMO_ORG_ID=... -e DEMO_EMAIL=... \
 *     amcp-cloud-backend node /tmp/cloud-setup.cjs
 *
 * New connectors are auto-attached to the owner's oldest server; the script
 * detaches them again so they appear on the demo server only.
 */
const jwt = require('jsonwebtoken');

const MOCK = process.env.DEMO_MOCK_URL || 'http://demo-api.lumenandclay.internal:8787';
const { DEMO_USER_ID: sub, DEMO_ORG_ID: organizationId, DEMO_EMAIL: email } = process.env;
if (!sub || !organizationId || !email) throw new Error('DEMO_USER_ID, DEMO_ORG_ID and DEMO_EMAIL are required');

const token = jwt.sign({ sub, email, role: 'ADMIN', organizationId }, process.env.JWT_SECRET, { expiresIn: '1h' });

async function api(method, path, body) {
  const res = await fetch(`http://localhost:4000/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const INSTRUCTIONS = [
  'Lumen & Clay is a ceramics studio in Lisbon. Its data lives in three systems:',
  '- Etsy (etsy_* tools): the shop. shop_id 48213377, owner user_id 902214. Orders are receipts; each transaction has the listing SKU. Receipts are paged (limit up to 100).',
  '- SAP S/4HANA (s4_* tools): stock is in service /sap/opu/odata/sap/ZLC_STOCK_OVERVIEW_SRV, entity set StockOverview (Material = the Etsy SKU, Plant 1000 Lisbon Studio, Plant 1100 Porto Warehouse, UnrestrictedStock, SafetyStock).',
  '- Lumen Logistics API (logistics_* tools): shipments of Etsy orders, order_ref ETSY-<receipt_id>; status delayed or lost marks a problem. Warehouse LIS-1 = plant 1000, OPO-1 = plant 1100.',
  'Answer concisely; use a table when comparing several items.',
].join('\n');

const created = { server: null, connectors: [] };

(async () => {
  let servers = await api('GET', '/mcp-servers');
  if (process.argv.includes('--reset')) {
    // Remove a previous run: the demo server and every connector it exposes.
    for (const s of servers.filter((x) => x.name === 'Lumen & Clay Demo')) {
      const full = await api('GET', `/mcp-servers/${s.id}`);
      for (const c of full.connectors) await api('DELETE', `/connectors/${c.connectorId}`);
      await api('DELETE', `/mcp-servers/${s.id}`);
    }
    servers = await api('GET', '/mcp-servers');
  }
  for (const s of servers.filter((x) => x.name === 'Lumen & Clay Demo')) {
    throw new Error(`A "Lumen & Clay Demo" server already exists (${s.id}); run with --reset.`);
  }
  const before = new Map();
  for (const s of servers) {
    const full = await api('GET', `/mcp-servers/${s.id}`);
    before.set(s.id, full.connectors.map((c) => c.connectorId));
  }

  const server = await api('POST', '/mcp-servers', {
    name: 'Lumen & Clay Demo',
    description: 'Demo video: fictional Etsy, SAP and logistics data',
  });
  created.server = server.id;
  await api('PUT', `/mcp-servers/${server.id}`, { instructions: INSTRUCTIONS });

  // Etsy: the real adapter's tools, re-pointed at the mock without OAuth.
  const etsy = await api('POST', '/adapters/etsy/import', {
    credentials: { ETSY_CLIENT_ID: 'demo-keystring', ETSY_CLIENT_SECRET: 'demo-secret' },
  });
  created.connectors.push(etsy.connectorId);
  await api('PUT', `/connectors/${etsy.connectorId}`, {
    name: 'Etsy',
    baseUrl: `${MOCK}/etsy/v3/application`,
    authType: 'NONE',
    authConfig: {},
  });

  const sap = await api('POST', '/connectors', {
    name: 'SAP S/4HANA',
    type: 'ODATA',
    baseUrl: MOCK,
    authType: 'BASIC_AUTH',
    authConfig: { username: 'AMCP_READER', password: 'demo' },
    config: { odata: { sap: true, sapClient: '100', sapLanguage: 'EN', toolPrefix: 's4' } },
  });
  created.connectors.push(sap.id);

  const logistics = await api('POST', '/connectors', {
    name: 'Lumen Logistics API',
    type: 'REST',
    baseUrl: `${MOCK}/logistics/v1`,
    authType: 'API_KEY',
    authConfig: { headerName: 'X-API-Key', apiKey: 'demo' },
    specUrl: `${MOCK}/logistics/openapi.json`,
  });
  created.connectors.push(logistics.id);
  const imported = await api('POST', `/connectors/${logistics.id}/import-spec`);
  if (imported.error) throw new Error(`import-spec: ${imported.error}`);

  const ids = [etsy.connectorId, sap.id, logistics.id];
  await api('PUT', `/mcp-servers/${server.id}/connectors`, { connectorIds: ids });

  // Undo the automatic attachment to the owner's other servers.
  for (const [id, prev] of before) {
    const now = (await api('GET', `/mcp-servers/${id}`)).connectors.map((c) => c.connectorId);
    if (now.some((c) => ids.includes(c))) {
      await api('PUT', `/mcp-servers/${id}/connectors`, { connectorIds: prev });
    }
  }

  const check = await api('GET', `/mcp-servers/${server.id}`);
  console.log(JSON.stringify({
    server: server.id,
    connectors: check.connectors.map((c) => c.connector.name),
    etsy: etsy.connectorId,
    sap: sap.id,
    logistics: logistics.id,
    logisticsTools: imported.created,
  }, null, 2));
})().catch(async (err) => {
  console.error(err.message);
  // Leave nothing half-made behind (new connectors land on the owner's
  // default server until the script reassigns them).
  for (const id of created.connectors) await api('DELETE', `/connectors/${id}`).catch(() => {});
  if (created.server) await api('DELETE', `/mcp-servers/${created.server}`).catch(() => {});
  process.exit(1);
});
