import { ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthController, NEUTRAL_PASSWORD_RESET, NEUTRAL_REGISTRATION } from './auth.controller';

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
}: {
  mode: 'cloud' | 'self-hosted';
  accounts?: Account[];
  openRegistration?: boolean;
}) {
  const users = [...accounts];
  const sent: string[] = [];
  const tokens: { userId: string; createdAt: Date; usedAt: Date | null }[] = [];

  const authService = {
    hashPassword: jest.fn(async (p: string) => `hash:${p}`),
    comparePassword: jest.fn(async (p: string, h: string) => h === `hash:${p}`),
    generateToken: jest.fn(() => 'jwt'),
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
  };
  const mcpServersService = { createDefaultForUser: jest.fn(async () => undefined) };
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
    {} as any, // licenseService
    {} as any, // securityEvents
    {} as any, // rolesService
    {} as any, // recoveryCodes
    ssoEnforcement as any,
  );
  return { controller, users, sent, authService, usersService, emailService, prisma };
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
