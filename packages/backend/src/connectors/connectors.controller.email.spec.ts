import { BadRequestException } from '@nestjs/common';
import { ConnectorsController } from './connectors.controller';
import { decrypt, encrypt } from '../common/crypto/encryption.util';

const KEY = 'a'.repeat(48);

function build(opts: { cloud: boolean; connectorsService?: any }) {
  const connectorsService = opts.connectorsService ?? {
    create: jest.fn().mockResolvedValue({ id: 'c1', type: 'EMAIL' }),
  };
  const prisma = { mcpTool: { create: jest.fn().mockResolvedValue({}) } };
  const mcpServer = { reloadConnectorTools: jest.fn().mockResolvedValue(undefined) };
  const controller = new ConnectorsController(
    connectorsService,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    prisma as any,
    mcpServer as any,
    { get: jest.fn(() => KEY) } as any,
    { checkCanCreateConnector: jest.fn().mockResolvedValue(undefined) } as any,
    { attachToDefaultServer: jest.fn().mockResolvedValue(null) } as any,
    { isCloud: () => opts.cloud } as any,
  );
  return { controller, connectorsService, prisma, mcpServer };
}

const req = { user: { sub: 'u1', organizationId: 'org1', role: 'ADMIN' } };
const dto = (email: Record<string, unknown>) => ({
  name: 'Office Mail',
  type: 'EMAIL' as any,
  baseUrl: 'imaps://imap.ionos.de:993',
  authType: 'BASIC_AUTH' as any,
  authConfig: { username: 'anna@example.com', password: 'pw' },
  config: { email },
});

describe('ConnectorsController: EMAIL connectors', () => {
  it('creates the built-in email tools with the connector', async () => {
    const { controller, prisma, mcpServer } = build({ cloud: true });
    await controller.create(req, dto({ imapHost: 'imap.ionos.de', smtpHost: 'smtp.ionos.de' }));
    const names = prisma.mcpTool.create.mock.calls.map((c: any[]) => c[0].data.name);
    expect(names).toEqual([
      'office_mail_list_folders',
      'office_mail_search_messages',
      'office_mail_get_message',
      'office_mail_get_attachment',
      'office_mail_set_flags',
      'office_mail_move_messages',
      'office_mail_delete_messages',
      'office_mail_save_draft',
      'office_mail_send_message',
    ]);
    expect(mcpServer.reloadConnectorTools).toHaveBeenCalledWith('c1');
    const off = prisma.mcpTool.create.mock.calls.filter((c: any[]) => c[0].data.isEnabled === false).map((c: any[]) => c[0].data.name);
    expect(off).toEqual(['office_mail_delete_messages', 'office_mail_send_message']);
  });

  it('refuses SMTP port 25 on Cloud', async () => {
    const { controller } = build({ cloud: true });
    await expect(controller.create(req, dto({ imapHost: 'imap.ionos.de', smtpHost: 'mx.example.com', smtpPort: 25 }))).rejects.toThrow(
      /port 25/,
    );
  });

  it('refuses plaintext and odd ports on Cloud before saving anything', async () => {
    const { controller, connectorsService } = build({ cloud: true });
    await expect(
      controller.create(req, dto({ imapHost: 'imap.ionos.de', imapPort: 143, imapSecurity: 'none' })),
    ).rejects.toThrow(BadRequestException);
    await expect(controller.create(req, dto({ imapHost: 'imap.ionos.de', imapPort: 6379 }))).rejects.toThrow(/port 6379/);
    await expect(
      controller.create(req, dto({ imapHost: 'imap.ionos.de', allowSelfSigned: true })),
    ).rejects.toThrow(/self-hosted/);
    expect(connectorsService.create).not.toHaveBeenCalled();
  });

  it('allows them self-hosted', async () => {
    const { controller, connectorsService } = build({ cloud: false });
    await controller.create(req, {
      ...dto({ imapHost: 'dovecot', imapPort: 143, imapSecurity: 'none', allowSelfSigned: true }),
      baseUrl: 'imap://dovecot:143',
    });
    expect(connectorsService.create).toHaveBeenCalled();
  });

  it('keeps the stored password when the edit form sends it back empty', async () => {
    const stored = encrypt(JSON.stringify({ username: 'anna@example.com', password: 'old-secret', smtpPassword: 'smtp-secret' }), KEY);
    const connectorsService = {
      findById: jest.fn().mockResolvedValue({ id: 'c1', type: 'EMAIL', organizationId: 'org1', userId: 'u1', authConfig: stored }),
      update: jest.fn().mockResolvedValue({ id: 'c1' }),
    };
    const { controller } = build({ cloud: true, connectorsService });
    const stored2 = encrypt(
      JSON.stringify({ username: 'anna@example.com', password: 'old-secret', smtpUsername: 'relay', smtpPassword: 'smtp-secret' }),
      KEY,
    );
    connectorsService.findById.mockResolvedValue({ id: 'c1', type: 'EMAIL', organizationId: 'org1', userId: 'u1', authConfig: stored2 });
    // A new username only: password and SMTP login stay.
    await controller.update(req, 'c1', { authConfig: { username: 'info@example.com', password: '' } } as any);
    expect(connectorsService.update.mock.calls[0][1].authConfig).toEqual({
      username: 'info@example.com',
      password: 'old-secret',
      smtpUsername: 'relay',
      smtpPassword: 'smtp-secret',
    });
    // An empty username keeps the stored one too.
    await controller.update(req, 'c1', { authConfig: { username: '', password: 'p2' } } as any);
    expect(connectorsService.update.mock.calls[1][1].authConfig).toMatchObject({ username: 'anna@example.com', password: 'p2' });
    // smtpUsername sent empty removes the separate SMTP login.
    await controller.update(req, 'c1', { authConfig: { smtpUsername: '' } } as any);
    expect(connectorsService.update.mock.calls[2][1].authConfig).toEqual({ username: 'anna@example.com', password: 'old-secret' });
    connectorsService.findById.mockResolvedValue({ id: 'c1', type: 'EMAIL', organizationId: 'org1', userId: 'u1', authConfig: stored });
    connectorsService.update.mockClear();

    await controller.update(req, 'c1', { authConfig: { username: 'anna@example.com', password: 'new-secret' } } as any);
    expect(connectorsService.update.mock.calls[0][1].authConfig).toMatchObject({ password: 'new-secret', smtpPassword: 'smtp-secret' });
    // Nothing in the stored value itself changed here; the service encrypts what it gets.
    expect(JSON.parse(decrypt(stored, KEY)).password).toBe('old-secret');
  });

  it('checks edited settings on Cloud', async () => {
    const connectorsService = {
      findById: jest.fn().mockResolvedValue({ id: 'c1', type: 'EMAIL', organizationId: 'org1', userId: 'u1', baseUrl: 'imaps://imap.ionos.de:993' }),
      update: jest.fn(),
    };
    const { controller } = build({ cloud: true, connectorsService });
    await expect(
      controller.update(req, 'c1', { config: { email: { imapHost: 'imap.ionos.de', imapSecurity: 'none', imapPort: 143 } } } as any),
    ).rejects.toThrow(BadRequestException);
    expect(connectorsService.update).not.toHaveBeenCalled();
  });
});
