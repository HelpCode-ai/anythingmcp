#!/usr/bin/env node
/**
 * A small REST API with an OpenAPI 3.0 spec, for the openapi-to-mcp demo: no
 * dependencies, in-memory data. It stands in for the REST API your ERP,
 * shop or in-house service already exposes.
 *
 *   GET  /openapi.json               the spec AnythingMCP imports
 *   GET  /customers[?country=DE]     GET /customers/{id}
 *   GET  /orders[?status=OPEN]       GET /orders/{orderNumber}
 *   POST /orders/{orderNumber}/notes
 *
 * Requests need the header X-Api-Key: demo-key, so the demo also shows how a
 * connector carries credentials the model never sees.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8080);
const API_KEY = process.env.API_KEY ?? 'demo-key';
const PUBLIC_URL = process.env.PUBLIC_URL ?? 'http://api-demo:8080';

const customers = [
  { id: 1, name: 'Bauer Holzbau GmbH', city: 'Freiburg', country: 'DE', creditLimit: 50000 },
  { id: 2, name: 'Stadtwerke Lörrach', city: 'Lörrach', country: 'DE', creditLimit: 120000 },
  { id: 3, name: 'Hotel Schwarzwaldblick', city: 'Titisee', country: 'DE', creditLimit: 20000 },
  { id: 4, name: 'Tischlerei Keller AG', city: 'Basel', country: 'CH', creditLimit: 35000 },
];
const orders = [
  { orderNumber: 'SO-24017', customerId: 1, status: 'SHIPPED', total: 3098.8, promisedDate: '2026-09-22', notes: [] },
  { orderNumber: 'SO-24031', customerId: 2, status: 'OPEN', total: 11588.0, promisedDate: '2026-10-06', notes: [] },
  { orderNumber: 'SO-24044', customerId: 3, status: 'OPEN', total: 1759.2, promisedDate: '2026-10-13', notes: [] },
  { orderNumber: 'SO-24052', customerId: 4, status: 'INVOICED', total: 1020.0, promisedDate: '2026-09-29', notes: [] },
];

const Customer = {
  type: 'object',
  properties: {
    id: { type: 'integer' }, name: { type: 'string' }, city: { type: 'string' },
    country: { type: 'string', description: 'ISO 3166-1 alpha-2' }, creditLimit: { type: 'number' },
  },
};
const Order = {
  type: 'object',
  properties: {
    orderNumber: { type: 'string' }, customerId: { type: 'integer' },
    status: { type: 'string', enum: ['OPEN', 'SHIPPED', 'INVOICED'] },
    total: { type: 'number', description: 'EUR, net' }, promisedDate: { type: 'string', format: 'date' },
    notes: { type: 'array', items: { type: 'string' } },
  },
};
const spec = {
  openapi: '3.0.3',
  info: { title: 'Orders API (demo)', version: '1.0.0', description: 'Customers and sales orders of a small wholesale business.' },
  servers: [{ url: PUBLIC_URL }],
  components: { securitySchemes: { apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } } },
  security: [{ apiKey: [] }],
  paths: {
    '/customers': {
      get: {
        operationId: 'listCustomers', summary: 'List customers',
        description: 'All customers, optionally only those in one country.',
        parameters: [{ name: 'country', in: 'query', required: false, schema: { type: 'string' }, description: 'ISO country code, e.g. DE' }],
        responses: { 200: { description: 'Customers', content: { 'application/json': { schema: { type: 'array', items: Customer } } } } },
      },
    },
    '/customers/{id}': {
      get: {
        operationId: 'getCustomer', summary: 'Get one customer',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { 200: { description: 'Customer', content: { 'application/json': { schema: Customer } } }, 404: { description: 'Not found' } },
      },
    },
    '/orders': {
      get: {
        operationId: 'listOrders', summary: 'List sales orders',
        description: 'Sales orders with status, net total and promised delivery date. Filter by status to find open orders.',
        parameters: [{ name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['OPEN', 'SHIPPED', 'INVOICED'] } }],
        responses: { 200: { description: 'Orders', content: { 'application/json': { schema: { type: 'array', items: Order } } } } },
      },
    },
    '/orders/{orderNumber}': {
      get: {
        operationId: 'getOrder', summary: 'Get one sales order',
        parameters: [{ name: 'orderNumber', in: 'path', required: true, schema: { type: 'string' }, description: 'e.g. SO-24031' }],
        responses: { 200: { description: 'Order', content: { 'application/json': { schema: Order } } }, 404: { description: 'Not found' } },
      },
    },
    '/orders/{orderNumber}/notes': {
      post: {
        operationId: 'addOrderNote', summary: 'Add a note to a sales order',
        description: 'Appends an internal note, for example a delivery remark. Changes data.',
        parameters: [{ name: 'orderNumber', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } } } },
        responses: { 201: { description: 'Updated order', content: { 'application/json': { schema: Order } } } },
      },
    },
  },
};

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
  if (req.method === 'GET' && path === '/openapi.json') return send(res, 200, spec);
  if (req.headers['x-api-key'] !== API_KEY) return send(res, 401, { error: 'missing or wrong X-Api-Key' });

  let m;
  if (req.method === 'GET' && path === '/customers') {
    const c = url.searchParams.get('country');
    return send(res, 200, c ? customers.filter((x) => x.country === c.toUpperCase()) : customers);
  }
  if (req.method === 'GET' && (m = path.match(/^\/customers\/(\d+)$/))) {
    const c = customers.find((x) => x.id === Number(m[1]));
    return c ? send(res, 200, c) : send(res, 404, { error: 'not found' });
  }
  if (req.method === 'GET' && path === '/orders') {
    const s = url.searchParams.get('status');
    return send(res, 200, s ? orders.filter((o) => o.status === s.toUpperCase()) : orders);
  }
  if (req.method === 'GET' && (m = path.match(/^\/orders\/([\w-]+)$/))) {
    const o = orders.find((x) => x.orderNumber === m[1].toUpperCase());
    return o ? send(res, 200, o) : send(res, 404, { error: 'not found' });
  }
  if (req.method === 'POST' && (m = path.match(/^\/orders\/([\w-]+)\/notes$/))) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const o = orders.find((x) => x.orderNumber === m[1].toUpperCase());
      if (!o) return send(res, 404, { error: 'not found' });
      let text;
      try { text = JSON.parse(body || '{}').text; } catch { /* fall through */ }
      if (!text) return send(res, 400, { error: 'text is required' });
      o.notes.push(String(text));
      send(res, 201, o);
    });
    return;
  }
  send(res, 404, { error: 'not found' });
}).listen(PORT, () => console.log(`api-demo listening on :${PORT}`));
