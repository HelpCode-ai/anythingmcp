import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { AuthController, NEUTRAL_REGISTRATION, RegisterDto } from './auth.controller';
import { ProductEventService, ProductEvents } from '../audit/product-event.service';

/**
 * Sign-up attribution: the register body may carry where the visitor came
 * from, and the server records it for a newly created cloud account only.
 */

// Configured exactly like main.ts: an undeclared field is a 400, which is
// why `attribution` needs its nested DTO.
const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
const validate = (body: unknown) =>
  pipe.transform(body, { type: 'body', metatype: RegisterDto, data: '' }) as Promise<RegisterDto>;

const base = {
  email: 'new@example.com',
  password: 'Some#Password1',
  name: 'Someone',
  acceptTerms: true,
};

const TS = Date.parse('2026-09-24T08:30:00Z');
const GCLID = 'Cj0KCQjw-abc_DEF123';

const ATTRIBUTION = {
  first_touch: {
    utm_source: 'google',
    utm_medium: 'cpc',
    utm_campaign: 'pmax-de',
    gad_source: '1',
    gad_campaignid: '22334455',
    paid: true,
    referrer_host: 'google.com',
    landing_path: '/de/guides/sap-business-one',
    ts: TS,
    captured_on: 'site',
  },
  last_touch: {
    referrer_host: 'chatgpt.com',
    utm_source: 'chatgpt.com',
    landing_path: '/login',
    ts: TS + 3_600_000,
    captured_on: 'cloud',
  },
};

describe('RegisterDto through the global ValidationPipe', () => {
  it('accepts a sign-up without attribution, as before', async () => {
    const dto = await validate({ ...base });
    expect(dto.email).toBe('new@example.com');
    expect(dto.attribution).toBeUndefined();
  });

  it('accepts a sign-up with attribution', async () => {
    const dto = await validate({ ...base, attribution: ATTRIBUTION });
    expect(dto.attribution?.first_touch?.utm_campaign).toBe('pmax-de');
    expect(dto.attribution?.first_touch?.paid).toBe(true);
    expect(dto.attribution?.last_touch?.referrer_host).toBe('chatgpt.com');
  });

  it('accepts a first touch alone', async () => {
    const dto = await validate({ ...base, attribution: { first_touch: { captured_on: 'cloud', landing_path: '/login' } } });
    expect(dto.attribution?.last_touch).toBeUndefined();
  });

  it('refuses keys it does not know, such as a non-Google click id', async () => {
    await expect(
      validate({ ...base, attribution: { first_touch: { fbclid: 'IwAR0abc' } } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      validate({ ...base, attribution: { first_touch: { email: 'jane@example.com' } } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(validate({ ...base, attribution: { email: 'x' } })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts Google Ads click ids with an ad consent state', async () => {
    const dto = await validate({
      ...base,
      attribution: {
        first_touch: { gclid: GCLID, gbraid: 'Gb-1_x', wbraid: 'Wb_2-y', ad_consent: 'granted', paid: true },
        last_touch: { gclid: GCLID, ad_consent: 'denied' },
      },
    });
    expect(dto.attribution?.first_touch?.gclid).toBe(GCLID);
    expect(dto.attribution?.first_touch?.ad_consent).toBe('granted');
    expect(dto.attribution?.last_touch?.ad_consent).toBe('denied');
    await expect(
      validate({ ...base, attribution: { first_touch: { ad_consent: 'unknown' } } }),
    ).resolves.toBeDefined();
  });

  it.each([
    ['a character outside [A-Za-z0-9_-]', { gclid: 'Cj0KCQ.abc', ad_consent: 'granted' }],
    ['a space', { gbraid: 'abc def', ad_consent: 'granted' }],
    ['an address', { wbraid: 'jane@example.com', ad_consent: 'granted' }],
    ['more than 150 characters', { gclid: 'a'.repeat(151), ad_consent: 'granted' }],
    ['a non-string', { gclid: 12345, ad_consent: 'granted' }],
    ['an unknown consent state', { gclid: GCLID, ad_consent: 'yes' }],
  ])('refuses a click id touch with %s', async (_label, touch) => {
    await expect(validate({ ...base, attribution: { first_touch: touch } })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('accepts a click id of exactly 150 characters', async () => {
    const dto = await validate({
      ...base,
      attribution: { first_touch: { gclid: 'a'.repeat(150), ad_consent: 'granted' } },
    });
    expect(dto.attribution?.first_touch?.gclid).toHaveLength(150);
  });

  it('refuses values beyond the caps and of the wrong type', async () => {
    await expect(
      validate({ ...base, attribution: { first_touch: { utm_source: 'x'.repeat(101) } } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      validate({ ...base, attribution: { first_touch: { paid: 'yes' } } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      validate({ ...base, attribution: { first_touch: { captured_on: 'elsewhere' } } }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

function makeController(mode: 'cloud' | 'self-hosted', existingEmails: string[] = []) {
  const users: any[] = existingEmails.map((email, i) => ({ id: `u-existing-${i}`, email }));
  const events: any[] = [];
  const prisma = {
    organization: { findFirst: jest.fn(async () => ({ id: 'org-first' })) },
    emailVerificationToken: {
      updateMany: jest.fn(async () => ({ count: 0 })),
      create: jest.fn(async ({ data }: any) => data),
    },
    productEvent: {
      create: jest.fn(async ({ data }: any) => {
        events.push(data);
        return data;
      }),
    },
  };
  const usersService = {
    findByEmail: jest.fn(async (email: string) => users.find((u) => u.email === email) ?? null),
    count: jest.fn(async () => users.length),
    create: jest.fn(async (data: any) => {
      const u = { id: `u${users.length + 1}`, ...data, emailVerified: false };
      users.push(u);
      return u;
    }),
  };
  const controller = new AuthController(
    { hashPassword: jest.fn(async (p: string) => `hash:${p}`), generateToken: jest.fn(() => 'jwt') } as any,
    usersService as any,
    { createDefaultForUser: jest.fn(async () => undefined) } as any,
    prisma as any,
    {
      sendVerificationEmail: jest.fn(async () => true),
      sendExistingAccountEmail: jest.fn(async () => true),
    } as any,
    {
      get: jest.fn((key: string) => {
        if (key === 'DEPLOYMENT_MODE') return mode;
        if (key === 'ALLOW_OPEN_REGISTRATION') return 'true';
        return undefined;
      }),
    } as any,
    { get: jest.fn(async () => null) } as any,
    {
      create: jest.fn(async () => ({ id: 'org-new' })),
      addMember: jest.fn(async () => undefined),
    } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    new ProductEventService(prisma as any),
    { assertSeatAvailable: jest.fn(async () => undefined), getState: jest.fn(async () => ({ trialAvailable: true })) } as any, // edition
  );
  return { controller, events, usersService };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('AuthController — sign-up attribution', () => {
  const OLD_FLOOR = process.env.AUTH_NEUTRAL_FLOOR_MS;
  beforeEach(() => {
    process.env.AUTH_NEUTRAL_FLOOR_MS = '0';
  });
  afterAll(() => {
    process.env.AUTH_NEUTRAL_FLOOR_MS = OLD_FLOOR;
  });

  it('records the sanitized touches for a newly created cloud account', async () => {
    const { controller, events } = makeController('cloud');
    const dto = await validate({ ...base, attribution: ATTRIBUTION });
    await expect(controller.register({}, dto)).resolves.toEqual(NEUTRAL_REGISTRATION);
    await flush();

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      event: ProductEvents.SIGNUP_ATTRIBUTED,
      userId: 'u1',
      organizationId: 'org-new',
      metadata: {
        first_channel: 'google_ads',
        last_channel: 'ai_assistant',
        first_touch: {
          utm_source: 'google',
          utm_medium: 'cpc',
          utm_campaign: 'pmax-de',
          gad_source: '1',
          gad_campaignid: '22334455',
          paid: true,
          referrer_host: 'google.com',
          landing_path: '/de/guides/sap-business-one',
          ts: '2026-09-24T08:30:00.000Z',
          captured_on: 'site',
          channel: 'google_ads',
        },
        last_touch: {
          utm_source: 'chatgpt.com',
          referrer_host: 'chatgpt.com',
          landing_path: '/login',
          ts: '2026-09-24T09:30:00.000Z',
          captured_on: 'cloud',
          channel: 'ai_assistant',
        },
      },
    });
  });

  it('sanitizes again on the server: strips addresses, paths and control characters', async () => {
    const { controller, events } = makeController('cloud');
    // Straight to the controller, as if the pipe had been bypassed.
    await controller.register({}, {
      ...base,
      attribution: {
        first_touch: {
          utm_term: 'jane@example.com',
          utm_campaign: 'spring\u0000sale',
          referrer_host: 'WWW.LinkedIn.com',
          landing_path: '/pricing?email=jane@example.com#top',
          ts: 42,
        },
      } as any,
    } as any);
    await flush();

    const meta = events[0].metadata;
    expect(meta.first_touch).toEqual({
      utm_campaign: 'springsale',
      referrer_host: 'linkedin.com',
      landing_path: '/pricing',
      channel: 'social',
    });
    // No separate last touch was sent: it is the first.
    expect(meta.last_touch).toEqual(meta.first_touch);
    expect(JSON.stringify(meta)).not.toContain('jane');
  });

  it('stores a click id that comes with ad consent granted', async () => {
    const { controller, events } = makeController('cloud');
    const dto = await validate({
      ...base,
      attribution: {
        first_touch: { utm_source: 'google', gclid: GCLID, ad_consent: 'granted', captured_on: 'site', ts: TS },
      },
    });
    await controller.register({}, dto);
    await flush();

    expect(events[0].metadata.first_touch).toEqual({
      utm_source: 'google',
      gclid: GCLID,
      ad_consent: 'granted',
      paid: true,
      captured_on: 'site',
      ts: '2026-09-24T08:30:00.000Z',
      channel: 'google_ads',
    });
  });

  it.each([['denied'], ['unknown'], [undefined]])(
    'drops every click id when ad consent is %s, and keeps the rest of the touch',
    async (adConsent) => {
      const { controller, events } = makeController('cloud');
      const dto = await validate({
        ...base,
        attribution: {
          first_touch: {
            utm_source: 'google',
            gclid: GCLID,
            gbraid: 'Gb-1',
            wbraid: 'Wb-2',
            paid: true,
            captured_on: 'site',
            ...(adConsent && { ad_consent: adConsent }),
          },
        },
      });
      await controller.register({}, dto);
      await flush();

      const meta = events[0].metadata;
      expect(meta.first_touch).toEqual({
        utm_source: 'google',
        paid: true,
        captured_on: 'site',
        ...(adConsent && { ad_consent: adConsent }),
        channel: 'google_ads',
      });
      expect(JSON.stringify(meta)).not.toMatch(/gclid|gbraid|wbraid|Cj0KCQ/);
    },
  );

  it('records nothing for an address that already has an account', async () => {
    const { controller, events } = makeController('cloud', ['new@example.com']);
    const dto = await validate({ ...base, attribution: ATTRIBUTION });
    await expect(controller.register({}, dto)).resolves.toEqual(NEUTRAL_REGISTRATION);
    await flush();
    expect(events).toEqual([]);
  });

  it('records nothing for a sign-up that loses the race for a new address', async () => {
    const { controller, events, usersService } = makeController('cloud');
    usersService.create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    const dto = await validate({ ...base, attribution: ATTRIBUTION });
    await expect(controller.register({}, dto)).resolves.toEqual(NEUTRAL_REGISTRATION);
    await flush();
    expect(events).toEqual([]);
  });

  it('records nothing when the sign-up carries no attribution', async () => {
    const { controller, events } = makeController('cloud');
    await controller.register({}, await validate({ ...base }));
    await flush();
    expect(events).toEqual([]);
  });

  it('records nothing on a self-hosted instance', async () => {
    const { controller, events } = makeController('self-hosted');
    await controller.register({}, await validate({ ...base, attribution: ATTRIBUTION }));
    await flush();
    expect(events).toEqual([]);
  });

  it('does not let a client report a signup_attributed event of its own', () => {
    const service = new ProductEventService({} as any);
    expect(service.isKnown(ProductEvents.SIGNUP_ATTRIBUTED)).toBe(false);
    expect(service.isKnown(ProductEvents.MCP_URL_COPIED)).toBe(true);
  });
});
