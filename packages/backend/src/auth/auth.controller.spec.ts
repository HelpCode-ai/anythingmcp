import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthController, NEUTRAL_PASSWORD_RESET, NEUTRAL_REGISTRATION } from './auth.controller';
import { ProductEventService } from '../audit/product-event.service';

/**
 * Sign-up, password reset and login must not say — by their answer or by how
 * long it takes — whether an address has an account.
 */

type Account = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  organizationId: string | null;
  mcpRoleId: string | null;
  emailVerified: boolean;
  passwordHash: string | null;
  passwordLoginDisabled: boolean;
};

function makeController({
  mode,
  accounts = [],
  openRegistration = true,
  orgLicense = null,
  orgEndedLicense = null,
}: {
  mode: 'cloud' | 'self-hosted';
  accounts?: Account[];
  openRegistration?: boolean;
  /** The workspace's active licence (cloud), if any. */
  orgLicense?: { plan: string } | null;
  /** Its latest ended licence (cloud), if any. */
  orgEndedLicense?: { plan: string; status: string } | null;
}) {
  const users = [...accounts];
  const sent: string[] = [];
  const tokens: { userId: string; createdAt: Date; usedAt: Date | null }[] = [];
  const events: any[] = [];
  const invites: any[] = [];

  const authService = {
    hashPassword: jest.fn(async (p: string) => `hash:${p}`),
    comparePassword: jest.fn(async (p: string, h: string) => h === `hash:${p}`),
    generateToken: jest.fn(() => 'jwt'),
    // Test sessions are the literal string `sess:<email>`; anything else is an
    // invalid token.
    verifyToken: jest.fn((t: string) => {
      if (typeof t === 'string' && t.startsWith('sess:')) return { email: t.slice(5) };
      throw new Error('invalid token');
    }),
  };
  const usersService = {
    findByEmail: jest.fn(async (email: string) => users.find((u) => u.email === email) ?? null),
    count: jest.fn(async () => users.length),
    create: jest.fn(async (data: any) => {
      const u: Account = {
        id: `u${users.length + 1}`,
        email: data.email,
        name: data.name,
        role: data.role,
        organizationId: data.organizationId,
        mcpRoleId: null,
        emailVerified: false,
        passwordHash: data.passwordHash,
        passwordLoginDisabled: false,
      };
      users.push(u);
      return u;
    }),
    update: jest.fn(async (id: string, data: any) => {
      const u = users.find((x) => x.id === id);
      if (u) Object.assign(u, data);
      return u;
    }),
  };
  const prisma = {
    organization: { findFirst: jest.fn(async () => ({ id: 'org-first' })) },
    emailVerificationToken: {
      updateMany: jest.fn(async () => ({ count: 0 })),
      create: jest.fn(async ({ data }: any) => {
        tokens.push({ userId: data.userId, createdAt: new Date(), usedAt: null });
        return data;
      }),
      count: jest.fn(async ({ where }: any) =>
        tokens.filter(
          (t) => t.userId === where.userId && !t.usedAt && t.createdAt > where.createdAt.gt,
        ).length,
      ),
    },
    passwordResetToken: { create: jest.fn(async ({ data }: any) => data) },
    invitationToken: {
      findUnique: jest.fn(async ({ where }: any) => invites.find((i) => i.token === where.token) ?? null),
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: any) => {
        invites.push({ ...data });
        return data;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const inv = invites.find((i) => i.token === where.token || i.id === where.id);
        if (inv) Object.assign(inv, data);
        return inv;
      }),
    },
    productEvent: {
      create: jest.fn(async ({ data }: any) => {
        events.push(data);
        return data;
      }),
    },
  };
  const emailService = {
    sendVerificationEmail: jest.fn(async (to: string) => {
      sent.push(`verify ${to}`);
      return true;
    }),
    sendExistingAccountEmail: jest.fn(async (to: string) => {
      sent.push(`existing ${to}`);
      return true;
    }),
    sendPasswordResetEmail: jest.fn(async (to: string) => {
      sent.push(`reset ${to}`);
      return true;
    }),
  };
  const configService = {
    get: jest.fn((key: string) => {
      if (key === 'DEPLOYMENT_MODE') return mode;
      if (key === 'ALLOW_OPEN_REGISTRATION') return openRegistration ? 'true' : undefined;
      if (key === 'FRONTEND_URL') return 'https://app.example.test';
      return undefined;
    }),
  };
  const siteSettings = { get: jest.fn(async () => null) };
  const organizationsService = {
    create: jest.fn(async () => ({ id: `org-${users.length + 1}` })),
    addMember: jest.fn(async () => undefined),
    getMembership: jest.fn(async () => null),
    switchOrg: jest.fn(async (userId: string, organizationId: string) => {
      const u = users.find((x) => x.id === userId);
      return { ...(u ?? {}), organizationId };
    }),
  };
  const mcpServersService = { createDefaultForUser: jest.fn(async () => undefined) };
  const rolesService = { setUserRoles: jest.fn(async () => undefined) };
  const ssoEnforcement = { isPasswordLoginBlocked: jest.fn(async () => false) };

  const controller = new AuthController(
    authService as any,
    usersService as any,
    mcpServersService as any,
    prisma as any,
    emailService as any,
    configService as any,
    siteSettings as any,
    organizationsService as any,
    {
      getCurrentLicense: jest.fn(async () => orgLicense),
      getLatestInactiveLicense: jest.fn(async () => orgEndedLicense),
    } as any, // licenseService
    {} as any, // securityEvents
    rolesService as any, // rolesService
    {} as any, // recoveryCodes
    ssoEnforcement as any,
    // The real service, so the test sees what would actually be stored.
    new ProductEventService(prisma as any),
    { assertSeatAvailable: jest.fn(async () => undefined), getState: jest.fn(async () => ({ trialAvailable: true })) } as any, // edition
  );
  return {
    controller,
    users,
    sent,
    events,
    invites,
    authService,
    usersService,
    emailService,
    organizationsService,
    prisma,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const EXISTING: Account = {
  id: 'u-existing',
  email: 'taken@example.com',
  name: 'Taken',
  role: 'ADMIN',
  organizationId: 'org-x',
  mcpRoleId: null,
  emailVerified: true,
  passwordHash: 'hash:Correct#Horse1',
  passwordLoginDisabled: false,
};

const signup = (email: string) => ({
  email,
  password: 'Some#Password1',
  name: 'Someone',
  acceptTerms: true as const,
});

describe('AuthController — answers that do not reveal accounts', () => {
  const OLD_FLOOR = process.env.AUTH_NEUTRAL_FLOOR_MS;
  beforeEach(() => {
    process.env.AUTH_NEUTRAL_FLOOR_MS = '0';
  });
  afterAll(() => {
    process.env.AUTH_NEUTRAL_FLOOR_MS = OLD_FLOOR;
  });

  describe('cloud sign-up', () => {
    it('answers a new and an already-registered address identically', async () => {
      const a = makeController({ mode: 'cloud', accounts: [EXISTING] });
      const fresh = await a.controller.register({}, signup('new@example.com'));
      const taken = await a.controller.register({}, signup('taken@example.com'));

      expect(fresh).toEqual(NEUTRAL_REGISTRATION);
      expect(taken).toEqual(NEUTRAL_REGISTRATION);
      expect(JSON.stringify(fresh)).not.toMatch(/accessToken|jwt/);
    });

    it('creates the new account and mails it a code; mails the existing owner a sign-in notice instead', async () => {
      const { controller, users, sent } = makeController({ mode: 'cloud', accounts: [EXISTING] });
      await controller.register({}, signup('new@example.com'));
      await controller.register({}, signup('taken@example.com'));
      await flush();

      expect(users.map((u) => u.email)).toEqual(['taken@example.com', 'new@example.com']);
      expect(sent).toEqual(['verify new@example.com', 'existing taken@example.com']);
    });

    it('does the same password hashing for an existing address as for a new one', async () => {
      const { controller, authService } = makeController({ mode: 'cloud', accounts: [EXISTING] });
      await controller.register({}, signup('taken@example.com'));
      expect(authService.hashPassword).toHaveBeenCalledTimes(1);
    });

    it('sends the existing-account notice at most once an hour per address', async () => {
      const { controller, sent } = makeController({ mode: 'cloud', accounts: [EXISTING] });
      for (let i = 0; i < 4; i++) {
        await expect(controller.register({}, signup('taken@example.com'))).resolves.toEqual(
          NEUTRAL_REGISTRATION,
        );
      }
      await flush();
      expect(sent).toEqual(['existing taken@example.com']);
    });

    it('answers no sooner than the floor, whichever path it took', async () => {
      process.env.AUTH_NEUTRAL_FLOOR_MS = '120';
      const { controller } = makeController({ mode: 'cloud', accounts: [EXISTING] });
      for (const email of ['taken@example.com', 'new@example.com']) {
        const started = Date.now();
        await controller.register({}, signup(email));
        expect(Date.now() - started).toBeGreaterThanOrEqual(115);
      }
    });

    it('treats a sign-up that loses a race for the same new address as an existing one', async () => {
      const { controller, usersService, sent } = makeController({ mode: 'cloud' });
      usersService.create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
      await expect(controller.register({}, signup('race@example.com'))).resolves.toEqual(
        NEUTRAL_REGISTRATION,
      );
      await flush();
      expect(sent).toEqual(['existing race@example.com']);
    });

    it('lets the new account sign in straight away without mailing a second code', async () => {
      const { controller, sent } = makeController({ mode: 'cloud' });
      await controller.register({}, signup('new@example.com'));
      const session = await controller.login({}, { email: 'new@example.com', password: 'Some#Password1' });
      await flush();

      expect(session.accessToken).toBe('jwt');
      expect(session.user.emailVerified).toBe(false);
      expect(sent).toEqual(['verify new@example.com']);
    });

    it('does not sign anyone in to an existing account with the sign-up password', async () => {
      const { controller } = makeController({ mode: 'cloud', accounts: [EXISTING] });
      await controller.register({}, signup('taken@example.com'));
      await expect(
        controller.login({}, { email: 'taken@example.com', password: 'Some#Password1' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('self-hosted sign-up (unchanged: a session straight away)', () => {
    it('returns a session for a new address and a conflict for a taken one', async () => {
      const { controller } = makeController({ mode: 'self-hosted', accounts: [EXISTING] });
      await expect(controller.register({}, signup('new@example.com'))).resolves.toMatchObject({
        accessToken: 'jwt',
        isFirstUser: false,
        user: { email: 'new@example.com', role: 'EDITOR', organizationId: 'org-first' },
      });
      await expect(controller.register({}, signup('taken@example.com'))).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('makes the first user an admin of a new workspace', async () => {
      const { controller } = makeController({ mode: 'self-hosted', openRegistration: false });
      await expect(controller.register({}, signup('first@example.com'))).resolves.toMatchObject({
        isFirstUser: true,
        user: { role: 'ADMIN' },
      });
    });

    it('refuses closed registration before looking at the address', async () => {
      const { controller, usersService } = makeController({
        mode: 'self-hosted',
        accounts: [EXISTING],
        openRegistration: false,
      });
      for (const email of ['taken@example.com', 'new@example.com']) {
        await expect(controller.register({}, signup(email))).rejects.toBeInstanceOf(ForbiddenException);
      }
      expect(usersService.findByEmail).not.toHaveBeenCalled();
    });
  });

  describe('password reset', () => {
    it('answers an unknown, a known and an SSO-only address identically', async () => {
      const sso: Account = { ...EXISTING, id: 'u-sso', email: 'sso@example.com', passwordLoginDisabled: true };
      const { controller, sent } = makeController({ mode: 'cloud', accounts: [EXISTING, sso] });

      const answers = [
        await controller.forgotPassword({}, { email: 'nobody@example.com' }),
        await controller.forgotPassword({}, { email: 'taken@example.com' }),
        await controller.forgotPassword({}, { email: 'sso@example.com' }),
      ];
      for (const a of answers) expect(a).toEqual(NEUTRAL_PASSWORD_RESET);
      await flush();
      expect(sent).toEqual(['reset taken@example.com']);
    });

    it('does not wait for the mail server before answering', async () => {
      const { controller, emailService } = makeController({ mode: 'cloud', accounts: [EXISTING] });
      let release!: (v: boolean) => void;
      emailService.sendPasswordResetEmail.mockReturnValueOnce(new Promise((r) => (release = r)));
      await expect(controller.forgotPassword({}, { email: 'taken@example.com' })).resolves.toEqual(
        NEUTRAL_PASSWORD_RESET,
      );
      release(true);
    });
  });

  describe('login', () => {
    it('spends the same bcrypt work on an unknown address as on a wrong password', async () => {
      const { controller, authService } = makeController({ mode: 'cloud', accounts: [EXISTING] });
      await expect(
        controller.login({}, { email: 'nobody@example.com', password: 'Wrong#Pass1' }),
      ).rejects.toThrow('Invalid email or password');
      await expect(
        controller.login({}, { email: 'taken@example.com', password: 'Wrong#Pass1' }),
      ).rejects.toThrow('Invalid email or password');
      expect(authService.comparePassword).toHaveBeenCalledTimes(2);
    });
  });
});

/**
 * Every cloud admin used to be told they "need licence setup" at each sign-in
 * (the check read an instance-wide key that cloud never writes), and the app
 * showed "Trial Activated!" to paying workspaces. Only a workspace without any
 * licence needs setup now.
 */
describe('AuthController.login — cloud licence setup', () => {
  const login = (controller: any) =>
    controller.login({}, { email: 'taken@example.com', password: 'Correct#Horse1' });

  it('does not ask a workspace with an active licence to set one up', async () => {
    const { controller } = makeController({ mode: 'cloud', accounts: [EXISTING], orgLicense: { plan: 'team' } });
    expect((await login(controller)).needsLicenseSetup).toBeUndefined();
  });

  it('does not ask a workspace whose trial ended (the licence wall offers the plans)', async () => {
    const { controller } = makeController({
      mode: 'cloud',
      accounts: [EXISTING],
      orgEndedLicense: { plan: 'trial', status: 'expired' },
    });
    expect((await login(controller)).needsLicenseSetup).toBeUndefined();
  });

  it('asks a workspace that never had a licence', async () => {
    const { controller } = makeController({ mode: 'cloud', accounts: [EXISTING] });
    expect((await login(controller)).needsLicenseSetup).toBe(true);
  });
});

/**
 * An invitation link is not proof that whoever holds it controls the invited
 * address. Accepting an invite for an address that ALREADY has an account must
 * require that account's password (or a live session for it) — otherwise any
 * admin (i.e. any signed-up user) could invite an arbitrary address and take
 * the account over by accepting the invite themselves.
 */
describe('AuthController — accept-invite ownership check', () => {
  const makeInvite = (over: Partial<any> = {}) => ({
    id: 'inv1',
    token: 'invite-token',
    email: 'taken@example.com',
    role: 'EDITOR',
    mcpRoleId: null,
    mcpRoleIds: [],
    organizationId: 'org-new',
    expiresAt: new Date(Date.now() + 3600_000),
    usedAt: null,
    ...over,
  });

  it('refuses to attach an existing account without the right password', async () => {
    const a = makeController({ mode: 'cloud', accounts: [EXISTING] });
    a.invites.push(makeInvite());
    await expect(
      a.controller.acceptInvite({ headers: {} }, { token: 'invite-token', password: 'Wrong#Pass9' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(a.organizationsService.addMember).not.toHaveBeenCalled();
  });

  it('refuses with no password at all', async () => {
    const a = makeController({ mode: 'cloud', accounts: [EXISTING] });
    a.invites.push(makeInvite());
    await expect(
      a.controller.acceptInvite({ headers: {} }, { token: 'invite-token' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(a.organizationsService.addMember).not.toHaveBeenCalled();
  });

  it('accepts an existing account with its correct password', async () => {
    const a = makeController({ mode: 'cloud', accounts: [EXISTING] });
    a.invites.push(makeInvite());
    const res = await a.controller.acceptInvite(
      { headers: {} },
      { token: 'invite-token', password: 'Correct#Horse1' },
    );
    expect(res.accessToken).toBe('jwt');
    expect(a.organizationsService.addMember).toHaveBeenCalledWith(
      'u-existing',
      'org-new',
      'EDITOR',
    );
  });

  it('accepts an existing account with a live session for the same address, no password', async () => {
    const a = makeController({ mode: 'cloud', accounts: [EXISTING] });
    a.invites.push(makeInvite());
    const res = await a.controller.acceptInvite(
      { headers: { authorization: 'Bearer sess:taken@example.com' } },
      { token: 'invite-token' },
    );
    expect(res.accessToken).toBe('jwt');
    expect(a.organizationsService.addMember).toHaveBeenCalled();
  });

  it('ignores a session that belongs to a different address', async () => {
    const a = makeController({ mode: 'cloud', accounts: [EXISTING] });
    a.invites.push(makeInvite());
    await expect(
      a.controller.acceptInvite(
        { headers: { authorization: 'Bearer sess:attacker@example.com' } },
        { token: 'invite-token' },
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(a.organizationsService.addMember).not.toHaveBeenCalled();
  });

  it('tells an SSO-only existing account to sign in first (password cannot prove it)', async () => {
    const sso: Account = { ...EXISTING, passwordHash: null };
    const a = makeController({ mode: 'cloud', accounts: [sso] });
    a.invites.push(makeInvite());
    await expect(
      a.controller.acceptInvite({ headers: {} }, { token: 'invite-token', password: 'anything' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('creates a brand-new account from an invite (no ownership check needed)', async () => {
    const a = makeController({ mode: 'cloud', accounts: [] });
    a.invites.push(makeInvite({ email: 'fresh@example.com' }));
    const res = await a.controller.acceptInvite(
      { headers: {} },
      { token: 'invite-token', password: 'Brand#New123', name: 'Fresh' },
    );
    expect(res.accessToken).toBe('jwt');
    expect(a.users.map((u) => u.email)).toContain('fresh@example.com');
  });

  it('rejects a weak password for a brand-new account', async () => {
    const a = makeController({ mode: 'cloud', accounts: [] });
    a.invites.push(makeInvite({ email: 'fresh@example.com' }));
    await expect(
      a.controller.acceptInvite(
        { headers: {} },
        { token: 'invite-token', password: 'weak', name: 'Fresh' },
      ),
    ).rejects.toBeTruthy();
  });

  it('verifyInvite reports whether the address already exists', async () => {
    const a = makeController({ mode: 'cloud', accounts: [EXISTING] });
    a.invites.push(makeInvite());
    a.invites.push(makeInvite({ id: 'inv2', token: 't2', email: 'fresh@example.com' }));
    expect(await a.controller.verifyInvite('invite-token')).toMatchObject({ exists: true });
    expect(await a.controller.verifyInvite('t2')).toMatchObject({ exists: false });
  });
});
