/**
 * Writes tools.snapshot.json: the MCP tools AnythingMCP generates for the three
 * demo connectors, produced by the product's own code (Etsy adapter JSON, the
 * OData built-ins, the OpenAPI parser), so the simulated UI lists exactly the
 * tools the real cloud connectors have.
 *
 * Run from packages/backend (uses its tsconfig and node_modules):
 *   npx tsx ../../video/demo/director/mock-backend/snapshot-tools.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildODataBuiltinTools, odataToolPrefix } from '../../../../packages/backend/src/connectors/odata/odata-builtins';
import { OpenApiParser } from '../../../../packages/backend/src/connectors/parsers/openapi.parser';
import { listAdapters, getAdapter } from '../../../../packages/backend/src/adapters/catalog';
import { logisticsOpenApi } from '../../mock-api/src/openapi';

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const root = path.resolve(HERE, '../../../..');
  const etsy = JSON.parse(readFileSync(path.join(root, 'packages/backend/src/adapters/intl/etsy.json'), 'utf8'));
  const sapName = 'SAP S/4HANA';
  const odata = buildODataBuiltinTools({ prefix: odataToolPrefix({ toolPrefix: 's4', name: sapName }), displayName: sapName, sap: true });
  const logistics = await new OpenApiParser().parse(logisticsOpenApi('https://api.lumenandclay.com/logistics/v1') as any);
  const pick = (t: any) => ({ name: t.name, description: t.description, parameters: t.parameters ?? t.inputSchema ?? {}, endpointMapping: t.endpointMapping ?? {} });
  const out = {
    etsy: { adapter: { ...etsy, tools: undefined }, tools: etsy.tools.map(pick) },
    sap: { tools: odata.map(pick) },
    logistics: { tools: logistics.map(pick) },
  };
  const catalog = listAdapters().filter((a) => !a.selfHostOnly);
  writeFileSync(path.join(HERE, 'adapters.snapshot.json'), JSON.stringify({ list: catalog, etsy: getAdapter('etsy') }, null, 1));
  console.log('adapters', catalog.length);
  writeFileSync(path.join(HERE, 'tools.snapshot.json'), JSON.stringify(out, null, 2));
  console.log('etsy', out.etsy.tools.length, 'sap', out.sap.tools.length, 'logistics', out.logistics.tools.length);
  console.log(out.sap.tools.map((t) => t.name).join(', '));
  console.log(out.logistics.tools.map((t) => t.name).join(', '));
}
main();
