import { expect, test, type Page } from '@playwright/test';

/**
 * /upload/<token>: the page an AI client hands to the user when its code
 * sandbox cannot send a file to AnythingMCP (file_upload_link). No sign-in:
 * the token is the credential. The user picks the file and it is PUT to the
 * one-time upload link.
 */

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz012345';

type Status = { filename: string; max_bytes: number; state: string; link_expires_at: string; bytes: number | null } | 404;

async function open(page: Page, status: Status, putStatus = 200) {
  const puts: Array<{ contentType: string | null; size: number }> = [];
  await page.route(/\/(api|health)\//, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const json = (body: unknown, code = 200) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/health/server-info') {
      return json({ deploymentMode: 'cloud', mcpAuthMode: 'oauth2', hasUsers: true, registrationEnabled: true, ssoProviders: [] });
    }
    if (p === `/api/uploads/u/${TOKEN}` && req.method() === 'GET') {
      return status === 404 ? json({ message: 'This upload link does not exist.' }, 404) : json(status);
    }
    if (p === `/api/uploads/u/${TOKEN}` && req.method() === 'PUT') {
      puts.push({ contentType: req.headers()['content-type'] ?? null, size: req.postDataBuffer()?.length ?? 0 });
      return putStatus === 200
        ? json({ file_ref: 'amcp-file:0123456789abcdef01234567', bytes: req.postDataBuffer()?.length ?? 0 })
        : json({ message: 'This upload link was already used. Ask for a new one.' }, putStatus);
    }
    return json({});
  });
  await page.goto(`/upload/${TOKEN}`);
  return puts;
}

const WAITING = { filename: 'mug-front.png', max_bytes: 50 * 1024 * 1024, state: 'waiting', link_expires_at: '2030-01-01T10:15:00.000Z', bytes: null };

test('uploads the chosen file without a sign-in', async ({ page }) => {
  const puts = await open(page, WAITING);
  await expect(page.getByTestId('upload-filename')).toHaveText('mug-front.png');
  await expect(page).toHaveURL(new RegExp(`/upload/${TOKEN}$`));
  await page.getByTestId('upload-input').setInputFiles({ name: 'mug.png', mimeType: 'image/png', buffer: Buffer.alloc(2048, 7) });
  await expect(page.getByRole('status')).toContainText('Uploaded');
  expect(puts).toEqual([{ contentType: 'application/octet-stream', size: 2048 }]);
});

test('refuses a file over the limit before sending it', async ({ page }) => {
  const puts = await open(page, { ...WAITING, max_bytes: 1024 });
  await page.getByTestId('upload-input').setInputFiles({ name: 'big.zip', mimeType: 'application/zip', buffer: Buffer.alloc(4096, 1) });
  await expect(page.locator('main').getByRole('alert')).toContainText('limit');
  expect(puts).toHaveLength(0);
});

test('says when the link was already used', async ({ page }) => {
  await open(page, WAITING, 409);
  await page.getByTestId('upload-input').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: Buffer.alloc(10, 1) });
  await expect(page.locator('main').getByRole('alert')).toContainText('expired or was already used');
});

test('shows an uploaded file and an unknown link', async ({ page }) => {
  await open(page, { ...WAITING, state: 'uploaded', bytes: 2048 });
  await expect(page.getByRole('status')).toContainText('already uploaded');
  await expect(page.getByTestId('upload-input')).toHaveCount(0);

  const other = await page.context().newPage();
  await open(other, 404);
  await expect(other.getByText('This upload link is not available')).toBeVisible();
});
