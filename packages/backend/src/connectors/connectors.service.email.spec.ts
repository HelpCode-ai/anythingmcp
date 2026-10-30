import { ConnectorsService } from './connectors.service';
import { encrypt } from '../common/crypto/encryption.util';
import { EmailConnectorError } from './email/email-settings';

/**
 * EMAIL connectors in ConnectorsService: the in-app "Run Test", the install
 * probe and Test connection reach the email engine with the catalog's
 * {{VARIABLES}} resolved, and a refused login reads as auth_failed.
 */
describe('ConnectorsService with EMAIL connectors', () => {
  const KEY = 'k'.repeat(24) + 'Zq7!pL2@vN9#xR4$';
  const emailEngine = { execute: jest.fn(), testConnection: jest.fn() };
  const prisma = { connector: { findUnique: jest.fn() } };
  const service = new ConnectorsService(
    prisma as any,
    { get: () => KEY } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    emailEngine as any,
  );

  // A catalog install: settings keep {{VAR}}, the values are in envVars.
  const connector = {
    id: 'c1',
    name: 'Email (IMAP/SMTP)',
    type: 'EMAIL',
    baseUrl: 'imap://imap.ionos.de:993',
    authType: 'BASIC_AUTH',
    authConfig: encrypt(JSON.stringify({ username: 'anna@example.com', password: 'pw' }), KEY),
    headers: null,
    specUrl: null,
    credentialScope: 'SHARED',
    organizationId: 'org1',
    config: { email: { imapHost: '{{EMAIL_IMAP_HOST}}', imapPort: '{{EMAIL_IMAP_PORT}}', toolPrefix: 'imap_smtp' } },
    envVars: { EMAIL_IMAP_HOST: 'imap.ionos.de', EMAIL_IMAP_PORT: '993', EMAIL_PASSWORD: 'pw' },
  } as any;

  beforeEach(() => {
    emailEngine.execute.mockReset().mockResolvedValue({ folders: [] });
    emailEngine.testConnection.mockReset();
    jest.spyOn(service, 'findById').mockResolvedValue(connector);
  });

  it('runs a built-in tool through the email engine with resolved settings', async () => {
    await service.executeConnectorCall(connector, { method: 'email_list_folders', path: '' }, {}, 'imap_smtp_list_folders');
    expect(emailEngine.execute).toHaveBeenCalledWith(
      { authConfig: { username: 'anna@example.com', password: 'pw' }, baseUrl: 'imap://imap.ionos.de:993' },
      expect.objectContaining({ method: 'email_list_folders' }),
      expect.any(Object),
      { imapHost: 'imap.ionos.de', imapPort: '993', toolPrefix: 'imap_smtp' },
    );
  });

  it('reports a successful test connection with folders and SMTP', async () => {
    emailEngine.testConnection.mockResolvedValue({ folders: 7, smtp: 'ok' });
    const out = await service.testConnection('c1');
    expect(out).toMatchObject({ ok: true, kind: 'ok' });
    expect(out.message).toMatch(/IMAP login accepted, 7 folders; SMTP login accepted/);
    expect(emailEngine.testConnection.mock.calls[0][1]).toEqual({ imapHost: 'imap.ionos.de', imapPort: '993', toolPrefix: 'imap_smtp' });
  });

  it('reports SMTP blocked on Cloud without failing the IMAP part', async () => {
    emailEngine.testConnection.mockResolvedValue({ folders: 3, smtp: 'blocked', smtpMessage: 'the hosting provider blocks port 587' });
    const out = await service.testConnection('c1');
    expect(out).toMatchObject({ ok: true, kind: 'ok' });
    expect(out.message).toMatch(/IMAP login accepted, 3 folders; SMTP not reachable: the hosting provider blocks port 587/);
  });

  it('maps a refused login to auth_failed', async () => {
    emailEngine.testConnection.mockRejectedValue(new EmailConnectorError('The mail server refused the login.', 'auth_failed'));
    await expect(service.testConnection('c1')).resolves.toEqual({
      ok: false,
      kind: 'auth_failed',
      message: 'The mail server refused the login.',
    });
  });
});
