import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'crypto';
import { SupportController, verifyLibredeskSignature } from './support.controller';

const ENV_KEYS = [
  'SUPPORT_CHAT_URL',
  'SUPPORT_CHAT_INBOX_ID',
  'SUPPORT_CHAT_SECRET',
  'LIBREDESK_API_URL',
  'LIBREDESK_API_KEY',
  'LIBREDESK_API_SECRET',
  'LIBREDESK_WEBHOOK_SECRET',
];

function withEnv(vars: Record<string, string>, fn: () => void | Promise<void>) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, vars);
  const restore = () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
  try {
    const r = fn();
    if (r instanceof Promise) return r.finally(restore);
    restore();
  } catch (e) {
    restore();
    throw e;
  }
}

const TRIAGE_ENV = {
  LIBREDESK_API_URL: 'https://desk.test',
  LIBREDESK_API_KEY: 'k',
  LIBREDESK_API_SECRET: 's',
  LIBREDESK_WEBHOOK_SECRET: 'whsec',
};

function signed(body: object, secret = 'whsec') {
  const raw = Buffer.from(JSON.stringify(body));
  const sig = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  return { req: { rawBody: raw, body }, sig };
}

function build() {
  const identity = { widgetSession: jest.fn().mockResolvedValue({ baseUrl: 'b', inboxId: 'i', userJwt: 'j' }) };
  const triage = { triage: jest.fn().mockResolvedValue(null) };
  return { controller: new SupportController(identity as any, triage as any), identity, triage };
}

describe('verifyLibredeskSignature', () => {
  it('accepts the sha256=<hex> HMAC of the raw body and rejects anything else', () => {
    const raw = Buffer.from('{"a":1}');
    const good = `sha256=${createHmac('sha256', 'x').update(raw).digest('hex')}`;
    expect(verifyLibredeskSignature(raw, good, 'x')).toBe(true);
    expect(verifyLibredeskSignature(raw, good, 'y')).toBe(false);
    expect(verifyLibredeskSignature(Buffer.from('{"a":2}'), good, 'x')).toBe(false);
    expect(verifyLibredeskSignature(raw, undefined, 'x')).toBe(false);
    expect(verifyLibredeskSignature(raw, 'sha256=short', 'x')).toBe(false);
  });
});

describe('SupportController', () => {
  it('widget is 404 when the chat is not configured', async () => {
    await withEnv({}, async () => {
      const { controller } = build();
      await expect(controller.widget({ user: { sub: 'u1', organizationId: 'o1' } })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  it('widget returns the session for the caller and their organization', async () => {
    await withEnv(
      { SUPPORT_CHAT_URL: 'https://desk.test', SUPPORT_CHAT_INBOX_ID: 'inbox', SUPPORT_CHAT_SECRET: 'sec' },
      async () => {
        const { controller, identity } = build();
        await controller.widget({ user: { sub: 'u1', organizationId: 'o1' } });
        expect(identity.widgetSession).toHaveBeenCalledWith('u1', 'o1');
      },
    );
  });

  it('webhook is 404 where the triage is not configured', () => {
    withEnv({}, () => {
      const { controller } = build();
      const { req, sig } = signed({ event: 'conversation.created', timestamp: new Date().toISOString() });
      expect(() => controller.webhook(req, sig)).toThrow(NotFoundException);
    });
  });

  it('webhook refuses a bad signature and a stale delivery', () => {
    withEnv(TRIAGE_ENV, () => {
      const { controller, triage } = build();
      const fresh = signed({ event: 'conversation.created', timestamp: new Date().toISOString(), payload: { uuid: 'c1' } });
      expect(() => controller.webhook(fresh.req, 'sha256=00')).toThrow(UnauthorizedException);

      const old = signed({
        event: 'conversation.created',
        timestamp: new Date(Date.now() - 60 * 60_000).toISOString(),
        payload: { uuid: 'c1' },
      });
      expect(() => controller.webhook(old.req, old.sig)).toThrow(UnauthorizedException);
      expect(triage.triage).not.toHaveBeenCalled();
    });
  });

  it('webhook hands conversation.created to the triage and ignores other events', () => {
    withEnv(TRIAGE_ENV, () => {
      const { controller, triage } = build();
      const created = signed({ event: 'conversation.created', timestamp: new Date().toISOString(), payload: { uuid: 'c1' } });
      expect(controller.webhook(created.req, created.sig)).toEqual({ ok: true });
      expect(triage.triage).toHaveBeenCalledWith({ uuid: 'c1' });

      const msg = signed({ event: 'message.created', timestamp: new Date().toISOString(), payload: { uuid: 'm1' } });
      expect(controller.webhook(msg.req, msg.sig)).toEqual({ ok: true });
      expect(triage.triage).toHaveBeenCalledTimes(1);
    });
  });
});
