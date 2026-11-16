import { NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Injectable, Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { TelegramManagedBotController } from './telegram-managed-bot.controller';
import { TELEGRAM_ONE_TAP } from './telegram-managed-bot';

describe('TelegramManagedBotController (POST /api/telegram/manager-webhook)', () => {
  const SECRET = 'webhook-secret-for-tests-0123456789';
  const update = { update_id: 1, managed_bot: { user: { id: 5 }, bot: { id: 6, username: 'amcp_1a2b3c4d_bot' } } };
  let bots: { isConfigured: jest.Mock; verifyWebhookSecret: jest.Mock; handleUpdate: jest.Mock };
  let controller: TelegramManagedBotController;

  beforeEach(() => {
    bots = {
      isConfigured: jest.fn().mockReturnValue(true),
      verifyWebhookSecret: jest.fn((header: unknown) => header === SECRET),
      handleUpdate: jest.fn().mockResolvedValue('connected'),
    };
    controller = new TelegramManagedBotController(bots as any);
  });

  it('does not exist while the feature is not configured', async () => {
    bots.isConfigured.mockReturnValue(false);
    await expect(controller.receive(SECRET, update)).rejects.toBeInstanceOf(NotFoundException);
    expect(bots.handleUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['no secret', undefined],
    ['a wrong secret', 'another-secret-of-the-same-length-00'],
  ])('refuses a call with %s', async (_label, header) => {
    await expect(controller.receive(header, update)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(bots.handleUpdate).not.toHaveBeenCalled();
  });

  it('hands an update with the right secret to the service and answers 200', async () => {
    await expect(controller.receive(SECRET, update)).resolves.toEqual({ ok: true });
    expect(bots.handleUpdate).toHaveBeenCalledWith(update);
  });

  it.each(['ignored', 'unmatched', 'expired', 'already_connected', 'connector_has_token', 'token_refused', 'claimed', 'refused', 'greeted', 'limited'])(
    'answers 200 for %s: sending it again would change nothing',
    async (outcome) => {
      bots.handleUpdate.mockResolvedValue(outcome);
      await expect(controller.receive(SECRET, update)).resolves.toEqual({ ok: true });
    },
  );

  it('asks Telegram to send the update again when its API did not answer', async () => {
    bots.handleUpdate.mockResolvedValue('retry');
    await expect(controller.receive(SECRET, update)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('answers 200 when the handler throws: Telegram cannot fix that', async () => {
    bots.handleUpdate.mockRejectedValue(new Error('unexpected'));
    await expect(controller.receive(SECRET, update)).resolves.toEqual({ ok: true });
  });

  it('hands a /start in the manager bot\'s chat to the service like any other update', async () => {
    const start = { update_id: 2, message: { text: '/start 1a2b3c4d', from: { id: 5 }, chat: { id: 5, type: 'private' } } };
    bots.handleUpdate.mockResolvedValue('claimed');
    await expect(controller.receive(SECRET, start)).resolves.toEqual({ ok: true });
    expect(bots.handleUpdate).toHaveBeenCalledWith(start);
    // And never without the secret: anyone can write to the bot, only Telegram can post here.
    await expect(controller.receive(undefined, start)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(bots.handleUpdate).toHaveBeenCalledTimes(1);
  });

  it('has its own request limit, above the default: every update comes from Telegram\'s few addresses', () => {
    const handler = TelegramManagedBotController.prototype.receive;
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handler)).toBe(600);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', handler)).toBe(60_000);
  });
});

describe('TELEGRAM_ONE_TAP', () => {
  // The sign-in page lives in a module that does not import the adapters'
  // module: it finds the service by this token, as login.controller.ts does.
  it('resolves the service from a module that does not import its own', async () => {
    @Injectable()
    class Service {
      isEnabledFor() {
        return true;
      }
    }
    @Module({ providers: [Service, { provide: TELEGRAM_ONE_TAP, useExisting: Service }] })
    class Owner {}
    @Injectable()
    class Page {
      constructor(readonly moduleRef: ModuleRef) {}
    }
    @Module({ providers: [Page] })
    class Elsewhere {}

    const app = await Test.createTestingModule({ imports: [Owner, Elsewhere] }).compile();
    const found = app.get(Page).moduleRef.get(TELEGRAM_ONE_TAP, { strict: false });
    expect(found).toBe(app.get(Service));
    await app.close();
  });
});
