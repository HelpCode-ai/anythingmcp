import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * AppModule skips @rekog/mcp-nest-auth's cookie-parser bootstrap check while
 * Sentry is on, because Sentry's Express instrumentation hides the layer name
 * the check looks for. That is only safe while main.ts mounts cookie-parser
 * itself, unconditionally: the OAuth handshake reads its state cookies from
 * req.cookies. This keeps that promise from being broken silently.
 */
describe('main.ts mounts cookie-parser', () => {
  const source = readFileSync(join(__dirname, 'main.ts'), 'utf8');

  it('calls app.use(cookieParser(...)) in bootstrap', () => {
    expect(source).toMatch(/import cookieParser from 'cookie-parser';/);
    expect(source).toMatch(/^\s{2}app\.use\(cookieParser\(/m);
  });
});
