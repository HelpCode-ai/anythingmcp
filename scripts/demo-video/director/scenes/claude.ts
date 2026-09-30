/**
 * The Claude scenes, in claude.ai (recording profile, signed in once by hand).
 * Claude reaches the Lumen & Clay data through the "Lumen & Clay Demo" MCP
 * server on AnythingMCP Cloud, whose connectors point at the mock Worker.
 *
 * Before each take (see README): only the demo connector enabled in the chat's
 * tools menu, sidebar collapsed, a new empty chat.
 */
import type { Page } from 'playwright-core';
import type { Scene, SceneScript } from '../lib/scene';

export const PROMPTS = {
  etsy: 'What were my best-selling Etsy listings in the last 30 days? Show units and revenue.',
  sap: 'Which products are below safety stock in our Lisbon plant (1000)?',
  finale:
    'Which of my Etsy orders are stuck in shipping, and do we have stock in SAP to send replacements? Put it in a compact table (order, item, problem, stock, action), a few words per cell.',
};

async function ask(s: Scene, prompt: string): Promise<void> {
  const p = s.page;
  const box = p.locator('div[contenteditable="true"]').first();
  await s.waitFor(box);
  await s.wait(1200);
  await s.type(box, prompt, 0.95);
  await s.wait(500);
  await s.click(p.getByRole('button', { name: /send message/i }));
  await waitForAnswer(s);
  await s.wait(1500);
  // Read through the answer from the top, as a viewer would.
  await s.scroll(-100_000);
  await s.wait(1800);
  for (let i = 0; i < 4; i++) {
    await s.scroll(380);
    await s.wait(1400);
  }
  await s.wait(1500);
}

/** Done when the stop button is gone and the page has not changed for a few seconds. */
async function waitForAnswer(s: Scene, timeoutMs = 180_000): Promise<void> {
  const p = s.page;
  const t0 = Date.now();
  await s.wait(3000);
  let last = '';
  let stableSince = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const streaming = await p.getByRole('button', { name: /stop (response|generating)/i }).isVisible().catch(() => false);
    const text = await p.locator('body').innerText().catch(() => '');
    if (text !== last) {
      last = text;
      stableSince = Date.now();
    }
    if (!streaming && Date.now() - stableSince > 3500) return;
    await s.wait(500);
  }
  throw new Error('Claude did not finish answering in time.');
}

const claudeScene = (prompt: string): SceneScript => ({
  start: 'https://claude.ai/new?incognito=true',
  run: (s) => ask(s, prompt),
});

export const etsyClaude = claudeScene(PROMPTS.etsy);
export const sapClaude = claudeScene(PROMPTS.sap);
export const finaleClaude = claudeScene(PROMPTS.finale);

/**
 * The per-server MCP endpoint of the "Lumen & Clay Demo" server on AnythingMCP
 * Cloud, printed by mock-api/cloud-setup.cjs.
 */
const MCP_URL = process.env.LUMEN_MCP_URL ?? 'https://cloud.anythingmcp.com/mcp/YOUR_SERVER_ID';
const CONNECTOR = 'Lumen & Clay';
const CONNECTORS = 'https://claude.ai/customize/connectors';

/** Off camera: remove the connector so the take can add it again, and hide the chat history. */
async function resetConnector(p: Page): Promise<void> {
  await p.goto(CONNECTORS, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  const hide = p.getByRole('button', { name: 'Hide sidebar' });
  if (await hide.isVisible().catch(() => false)) await hide.click();
  await p.getByRole('tab', { name: /^(My|Mine|Yours)/ }).or(p.getByText(/^(My|Mine|Yours)$/)).first().click();
  await p.waitForTimeout(1500);
  const row = p.getByText(CONNECTOR, { exact: true }).first();
  if (!(await row.isVisible().catch(() => false))) return;
  await row.click();
  await p.waitForTimeout(2000);
  // Removing alone keeps the OAuth grant, and adding the same URL back would
  // skip the consent page; disconnecting first revokes it.
  const disconnect = p.getByRole('button', { name: 'Disconnect', exact: true });
  if (await disconnect.isVisible().catch(() => false)) {
    await disconnect.click();
    await disconnect.last().click();
    await p.waitForTimeout(2000);
  }
  await p.getByRole('button', { name: `More options for ${CONNECTOR}` }).click();
  await p.getByRole('menuitem', { name: 'Remove' }).click();
  await p.getByRole('button', { name: 'Remove', exact: true }).last().click();
  await p.waitForTimeout(2500);
}

/**
 * Off camera: reset the connector, then open the Discover tab, so the take
 * never shows the list of the account's own connectors.
 */
async function prepareConnect(p: Page): Promise<void> {
  await resetConnector(p);
  await p.goto(CONNECTORS, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  await p.getByText('Discover', { exact: true }).first().click();
  await p.waitForTimeout(1500);
}

export const connectClaude: SceneScript = {
  start: CONNECTORS,
  prepare: prepareConnect,
  async run(s) {
    const p = s.page;
    await s.wait(900);
    await s.click(p.getByRole('button', { name: 'Add connector', exact: true }));
    await s.click(p.getByRole('menuitem', { name: 'Add custom connector' }));
    const form = p.getByRole('dialog').last();
    await s.type(form.getByPlaceholder('Name'), CONNECTOR, 0.9);
    await s.paste(form.getByPlaceholder('MCP server URL'), MCP_URL);
    await s.wait(500);
    await s.click(form.getByRole('button', { name: 'Continue' }));
    await s.wait(900);
    await s.click(p.getByRole('dialog').last().getByRole('button', { name: 'Add', exact: true }));
    // Claude hands over to AnythingMCP's consent page, directly or after Connect.
    const approve = p.getByRole('button', { name: 'Approve' });
    const connect = p.getByRole('button', { name: 'Connect', exact: true });
    await s.waitFor(approve.or(connect), 40_000);
    if (await connect.isVisible().catch(() => false)) {
      await s.wait(900);
      await s.click(connect);
    }
    await s.waitFor(approve, 40_000);
    await s.wait(1000);
    await s.hover(p.getByText('claude.ai', { exact: true }), 1100);
    await s.click(approve);
    // Back in Claude: the server's tools, read-only ones allowed without asking.
    const perm = p.getByRole('button', { name: /permission for group/i }).first();
    await s.waitFor(perm, 40_000);
    await s.wait(1500);
    await s.click(perm);
    await s.click(p.locator('[role^=menuitem]', { hasText: 'Always allow' }).last());
    await s.wait(1200);
    await s.scroll(420);
    await s.wait(2500);
  },
};
