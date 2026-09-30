/**
 * The three web-app scenes, against the real frontend and the mock backend.
 * Values typed on camera are fictional; nothing here reaches Etsy or SAP.
 */
import type { SceneScript } from '../lib/scene';
import { APP } from '../lib/session';

const DISPLAY = {
  etsyKeystring: 'lc8x2qv7m1dz9ktw4hbn6f0r',
  etsySecret: 'q4n7w2m9xk',
  sapBase: 'https://s4.lumenandclay.com',
  sapUser: 'AMCP_READER',
  sapPassword: 'Kiln-Glaze-2026!',
  logisticsBase: 'https://api.lumenandclay.com/logistics/v1',
  logisticsSpec: 'https://api.lumenandclay.com/logistics/openapi.json',
  logisticsKey: 'lk_live_7d2f9a41c8e36b05',
};

/** ① Etsy from the marketplace: search, install, credentials, authorize. */
export const etsyUi: SceneScript = {
  stage: 'etsy',
  start: `${APP}/connectors`,
  async run(s) {
    const p = s.page;
    await s.wait(900);
    await s.click(p.getByRole('link', { name: 'Marketplace' }));
    await s.waitFor(p.getByPlaceholder('Search adapters...'));
    await s.wait(600);
    await s.type(p.getByPlaceholder('Search adapters...'), 'etsy', 0.8);
    const card = p.locator('div').filter({ has: p.getByText('Etsy', { exact: true }) }).filter({ has: p.getByRole('button', { name: /Install/ }) }).last();
    await s.hover(card.getByText('Etsy', { exact: true }), 900);
    await s.click(card.getByRole('button', { name: /Install/ }));
    await s.waitFor(p.getByText('Configure Etsy'));
    await s.wait(700);
    await s.paste(p.locator('#cred-ETSY_CLIENT_ID'), DISPLAY.etsyKeystring);
    await s.wait(300);
    await s.paste(p.locator('#cred-ETSY_CLIENT_SECRET'), DISPLAY.etsySecret);
    await s.wait(500);
    await s.click(p.getByRole('button', { name: 'Import with credentials' }));
    // "Add to MCP Server": keep the existing Lumen & Clay server.
    await s.waitFor(p.getByRole('button', { name: 'Assign to MCP Server' }));
    await s.wait(700);
    await s.click(p.getByText('Lumen & Clay', { exact: true }).last());
    await s.wait(300);
    await s.click(p.getByRole('button', { name: 'Assign to MCP Server' }));
    await s.waitFor(p.getByText(/^Assigned connectors/).first());
    await s.wait(1400);
    // Open the Etsy connector and authorize it.
    await s.click(p.getByRole('link', { name: 'Connectors', exact: true }));
    await s.waitFor(p.getByRole('link', { name: 'Etsy', exact: true }));
    await s.wait(600);
    await s.click(p.getByRole('link', { name: 'Etsy', exact: true }));
    await s.waitFor(p.getByRole('button', { name: 'Authorize with Provider' }));
    await s.wait(800);
    await s.click(p.getByRole('button', { name: 'Authorize with Provider' }));
    await s.waitFor(p.getByText(/OAuth2 authorization successful/));
    await s.wait(1400);
    await s.scrollTo(p.getByText(/^MCP Tools \(/));
    await s.wait(1800);
  },
};

/** ② SAP as a custom OData connector: SAP Gateway, client, Basic auth, test, create. */
export const sapUi: SceneScript = {
  stage: 'sap',
  start: `${APP}/connectors`,
  async run(s) {
    const p = s.page;
    await s.wait(900);
    await s.click(p.getByRole('banner').getByRole('link', { name: 'Add Connector' }));
    await s.waitFor(p.getByText('Choose connector type'));
    await s.wait(700);
    await s.click(p.getByRole('button', { name: /^OData/ }));
    await s.waitFor(p.getByText('Configure OData'));
    await s.type(p.getByPlaceholder('e.g., My REST API'), 'SAP S/4HANA', 0.9);
    await s.paste(p.getByPlaceholder('https://s4.example.com:44300'), DISPLAY.sapBase);
    await s.hover(p.getByText('SAP Gateway (S/4HANA, ECC, BW)'), 600);
    await s.type(p.getByPlaceholder('e.g. 100'), '100');
    await s.select(p.getByRole('combobox').last(), 'Basic Auth');
    const user = p.locator('label:text-is("Username") + input');
    const pass = p.locator('label:text-is("Password") + input');
    await s.type(user, DISPLAY.sapUser, 1.1);
    await s.paste(pass, DISPLAY.sapPassword);
    await s.wait(400);
    await s.click(p.getByRole('button', { name: 'Test connection' }));
    await s.waitFor(p.getByText(/SAP service catalog lists/));
    await s.wait(1600);
    await s.click(p.getByRole('button', { name: 'Create connector' }));
    await s.waitFor(p.getByText(/^Assigned connectors/).first());
    await s.wait(1500);
  },
};

/** ③ Any REST API from its OpenAPI spec. */
export const openapiUi: SceneScript = {
  stage: 'openapi',
  start: `${APP}/connectors/new`,
  async run(s) {
    const p = s.page;
    await s.wait(900);
    await s.click(p.getByRole('button', { name: /^REST API/ }));
    await s.waitFor(p.getByText('Configure REST API'));
    await s.type(p.getByPlaceholder('e.g., My REST API'), 'Lumen Logistics API', 0.9);
    await s.paste(p.getByPlaceholder('https://api.example.com/v1'), DISPLAY.logisticsBase);
    await s.paste(p.locator('label:has-text("OpenAPI Spec URL") + input'), DISPLAY.logisticsSpec);
    await s.select(p.getByRole('combobox').last(), 'API Key');
    await s.paste(p.getByPlaceholder('sk-...'), DISPLAY.logisticsKey);
    await s.wait(400);
    await s.click(p.getByRole('button', { name: 'Create connector' }));
    await s.waitFor(p.getByText(/^Assigned connectors/).first(), 40_000);
    await s.wait(1400);
    await s.hover(p.getByText('Lumen Logistics API').last(), 900);
    await s.scroll(520);
    await s.wait(2200);
  },
};
