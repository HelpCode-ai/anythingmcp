import * as adapter from './imap-smtp.json';
import { EmailEngine } from '../../connectors/engines/email.engine';

const a = adapter as unknown as {
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, string>;
    config: { email: Record<string, string> };
  };
  requiredEnvVars: string[];
  optionalEnvVars: string[];
};

describe('imap-smtp adapter — static spec conformance', () => {
  it('is an EMAIL connector signing in with the mailbox login', () => {
    expect(a.connector.type).toBe('EMAIL');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({
      username: '{{EMAIL_USERNAME}}',
      password: '{{EMAIL_PASSWORD}}',
      smtpUsername: '{{EMAIL_SMTP_USERNAME}}',
      smtpPassword: '{{EMAIL_SMTP_PASSWORD}}',
    });
  });

  it('keeps every server setting a variable, resolved per call', () => {
    expect(a.connector.baseUrl).toBe('imap://{{EMAIL_IMAP_HOST}}:{{EMAIL_IMAP_PORT}}');
    expect(a.connector.config.email).toMatchObject({
      imapHost: '{{EMAIL_IMAP_HOST}}',
      imapPort: '{{EMAIL_IMAP_PORT}}',
      smtpHost: '{{EMAIL_SMTP_HOST}}',
      smtpPort: '{{EMAIL_SMTP_PORT}}',
      toolPrefix: 'imap_smtp',
    });
    // Every {{VAR}} the connector uses is one the install form asks for.
    const declared = new Set([...a.requiredEnvVars, ...a.optionalEnvVars]);
    const used = JSON.stringify(a.connector).match(/\{\{([A-Z0-9_]+)\}\}/g)!.map((m) => m.slice(2, -2));
    expect(used.filter((v) => !declared.has(v))).toEqual([]);
  });
});

/**
 * Read-only check against a real mailbox, opt-in only:
 *   RUN_IMAP_SMTP_LIVE=1 IMAP_SMTP_LIVE_IMAP_HOST=… IMAP_SMTP_LIVE_USERNAME=… IMAP_SMTP_LIVE_PASSWORD=… npx jest imap-smtp.live
 * It lists folders and searches the inbox. It never sends, moves or flags.
 */
const live = process.env.RUN_IMAP_SMTP_LIVE === '1' ? describe : describe.skip;
live('imap-smtp adapter — live (read-only)', () => {
  const engine = new EmailEngine();
  const config = {
    authConfig: {
      username: process.env.IMAP_SMTP_LIVE_USERNAME ?? '',
      password: process.env.IMAP_SMTP_LIVE_PASSWORD ?? '',
    },
  };
  const settings = {
    imapHost: process.env.IMAP_SMTP_LIVE_IMAP_HOST,
    imapPort: process.env.IMAP_SMTP_LIVE_IMAP_PORT ?? '993',
  };

  it('lists folders', async () => {
    const out = (await engine.execute(config, { method: 'email_list_folders' }, {}, settings)) as { folders: unknown[] };
    expect(out.folders.length).toBeGreaterThan(0);
  }, 30_000);

  it('searches the inbox', async () => {
    const out = (await engine.execute(config, { method: 'email_search' }, { limit: 3 }, settings)) as { messages: unknown[] };
    expect(Array.isArray(out.messages)).toBe(true);
  }, 30_000);
});
