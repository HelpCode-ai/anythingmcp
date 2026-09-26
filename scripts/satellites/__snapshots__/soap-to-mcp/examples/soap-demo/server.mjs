#!/usr/bin/env node
/**
 * A deliberately small SOAP 1.1 service for the soap-to-mcp demo: no
 * dependencies, three document/literal operations over an in-memory
 * inventory. It stands in for the SOAP service your ERP or warehouse system
 * already exposes.
 *
 *   GET  /inventory?wsdl   the WSDL
 *   POST /inventory        SOAP envelopes
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 8080);
const HERE = dirname(fileURLToPath(import.meta.url));
const WSDL = readFileSync(join(HERE, 'inventory.wsdl'), 'utf8').replace(
  'http://soap-demo:8080/inventory',
  process.env.PUBLIC_URL ?? 'http://soap-demo:8080/inventory',
);

const ITEMS = [
  { sku: 'DR-1001', name: 'Steel door T30, 875 x 2000 mm', warehouse: 'FREIBURG', onHand: 4, reorderLevel: 6, unitPrice: '489.00' },
  { sku: 'DR-1002', name: 'Wooden interior door, oak, 860 x 1985 mm', warehouse: 'FREIBURG', onHand: 22, reorderLevel: 10, unitPrice: '219.90' },
  { sku: 'LK-2040', name: 'Mortise lock, profile cylinder, 55 mm backset', warehouse: 'FREIBURG', onHand: 3, reorderLevel: 25, unitPrice: '18.40' },
  { sku: 'HG-3100', name: 'Door hinge, stainless, 3D adjustable', warehouse: 'BASEL', onHand: 140, reorderLevel: 60, unitPrice: '12.75' },
  { sku: 'CL-5200', name: 'Overhead door closer, EN 2-5', warehouse: 'BASEL', onHand: 9, reorderLevel: 12, unitPrice: '96.00' },
];
const ORDERS = {
  'SO-24017': { customer: 'Bauer Holzbau GmbH', status: 'SHIPPED', promisedDate: '2026-09-22' },
  'SO-24031': { customer: 'Stadtwerke Lörrach', status: 'IN_PRODUCTION', promisedDate: '2026-10-06' },
  'SO-24044': { customer: 'Hotel Schwarzwaldblick', status: 'WAITING_FOR_STOCK', promisedDate: '2026-10-13' },
};

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const field = (xml, name) => {
  const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${name}>([^<]*)</(?:[\\w-]+:)?${name}>`));
  return m ? m[1].trim() : undefined;
};
const itemXml = (i) =>
  `<tns:sku>${esc(i.sku)}</tns:sku><tns:name>${esc(i.name)}</tns:name><tns:warehouse>${esc(i.warehouse)}</tns:warehouse>` +
  `<tns:onHand>${i.onHand}</tns:onHand><tns:reorderLevel>${i.reorderLevel}</tns:reorderLevel><tns:unitPrice>${i.unitPrice}</tns:unitPrice>`;
const envelope = (body) =>
  `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tns="urn:example:inventory"><soap:Body>${body}</soap:Body></soap:Envelope>`;
const fault = (msg) =>
  envelope(`<soap:Fault><faultcode>soap:Client</faultcode><faultstring>${esc(msg)}</faultstring></soap:Fault>`);

function handle(xml) {
  if (/<(?:[\w-]+:)?GetItem[\s>]/.test(xml)) {
    const sku = field(xml, 'sku');
    const item = ITEMS.find((i) => i.sku.toLowerCase() === String(sku ?? '').toLowerCase());
    return envelope(`<tns:GetItemResponse>${item ? `<tns:item>${itemXml(item)}</tns:item>` : ''}</tns:GetItemResponse>`);
  }
  if (/<(?:[\w-]+:)?ListLowStock[\s>/]/.test(xml)) {
    const wh = field(xml, 'warehouse');
    const low = ITEMS.filter((i) => i.onHand <= i.reorderLevel && (!wh || i.warehouse === wh.toUpperCase()));
    return envelope(`<tns:ListLowStockResponse>${low.map((i) => `<tns:item>${itemXml(i)}</tns:item>`).join('')}</tns:ListLowStockResponse>`);
  }
  if (/<(?:[\w-]+:)?GetOrderStatus[\s>]/.test(xml)) {
    const no = field(xml, 'orderNumber');
    const o = ORDERS[String(no ?? '').toUpperCase()];
    if (!o) return fault(`Unknown order ${no}`);
    return envelope(
      `<tns:GetOrderStatusResponse><tns:orderNumber>${esc(no.toUpperCase())}</tns:orderNumber><tns:customer>${esc(o.customer)}</tns:customer>` +
        `<tns:status>${o.status}</tns:status><tns:promisedDate>${o.promisedDate}</tns:promisedDate></tns:GetOrderStatusResponse>`,
    );
  }
  return fault('Unknown operation');
}

createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/inventory' && url.search.toLowerCase().includes('wsdl')) {
    res.writeHead(200, { 'content-type': 'text/xml; charset=utf-8' }).end(WSDL);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/inventory') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const out = handle(body);
      res.writeHead(out.includes('<soap:Fault>') ? 500 : 200, { 'content-type': 'text/xml; charset=utf-8' }).end(out);
    });
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, () => console.log(`soap-demo listening on :${PORT}`));
