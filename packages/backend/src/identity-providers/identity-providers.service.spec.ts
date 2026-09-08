import {
  IdentityProvidersService,
  IdentityProviderError,
} from './identity-providers.service';
import { PrismaService } from '../common/prisma.service';
import { DeploymentService } from '../common/deployment.service';

const TENANT = 'aaaabbbb-cccc-dddd-eeee-ffff11112222';

describe('IdentityProvidersService', () => {
  let service: IdentityProvidersService;
  let prisma: any;
  let deployment: DeploymentService;

  const baseInput = () => ({
    type: 'ENTRA' as any,
    name: 'Entra',
    clientId: 'client-1',
    clientSecret: 'SUPER-SECRET',
    config: { tenantId: TENANT },
  });

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = 'a-test-encryption-key-of-32-chars!!';
    prisma = {
      identityProvider: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
      },
      $transaction: jest.fn((fn: any) => fn(prisma)),
    };
    deployment = { mode: 'cloud', isCloud: () => true, isSelfHosted: () => false } as any;
    service = new IdentityProvidersService(
      prisma as unknown as PrismaService,
      deployment,
    );
  });

  describe('client secret at rest', () => {
    it('round-trips through the AAD it binds on write', async () => {
      // The highest-value test in this file: a typo in `aadFor` would make
      // every stored client secret permanently undecryptable, and nothing else
      // would catch it — the write and the read would each look fine alone.
      prisma.identityProvider.create.mockResolvedValue({ id: 'p1' });
      let stored: string | undefined;
      prisma.identityProvider.update.mockImplementation(({ data }: any) => {
        stored = data.clientSecretEnc;
        return { id: 'p1' };
      });

      await service.create('org-1', baseInput());
      expect(stored).toBeDefined();

      prisma.identityProvider.findFirst.mockResolvedValue({
        clientSecretEnc: stored,
      });
      expect(await service.getClientSecret('p1', 'org-1')).toBe('SUPER-SECRET');
    });

    it('refuses to decrypt a secret belonging to another organization', async () => {
      prisma.identityProvider.create.mockResolvedValue({ id: 'p1' });
      let stored: string | undefined;
      prisma.identityProvider.update.mockImplementation(({ data }: any) => {
        stored = data.clientSecretEnc;
        return { id: 'p1' };
      });
      await service.create('org-1', baseInput());

      // Same ciphertext, read as if it belonged to another workspace: the AAD
      // no longer matches and GCM rejects it. Without the binding it would
      // decrypt happily, because the encryption key is instance-wide.
      prisma.identityProvider.findFirst.mockResolvedValue({
        clientSecretEnc: stored,
      });
      await expect(service.getClientSecret('p1', 'org-2')).rejects.toThrow();
    });

    it('never stores the plaintext', async () => {
      prisma.identityProvider.create.mockResolvedValue({ id: 'p1' });
      let stored = '';
      prisma.identityProvider.update.mockImplementation(({ data }: any) => {
        stored = data.clientSecretEnc;
        return { id: 'p1' };
      });

      await service.create('org-1', baseInput());

      expect(stored).not.toContain('SUPER-SECRET');
    });

    it('requires a secret on create', async () => {
      await expect(
        service.create('org-1', { ...baseInput(), clientSecret: undefined }),
      ).rejects.toThrow(IdentityProviderError);
    });
  });

  describe('update', () => {
    const existing = {
      id: 'p1',
      type: 'GOOGLE',
      config: { hostedDomain: 'corp.example.com' },
    };

    it('preserves the stored config when the caller omits it', async () => {
      // REGRESSION GUARD. `config` used to be written unconditionally, and
      // `parseProviderConfig` returns {} for a type whose fields are all
      // optional — so a PUT that only toggled `isActive` erased
      // `hostedDomain`, the one thing making Google authoritative for a
      // non-gmail address. Sign-in silently widened to every Google account.
      prisma.identityProvider.findFirst
        .mockResolvedValueOnce(existing) // the pre-read inside update()
        .mockResolvedValueOnce({ id: 'p1' }); // the read-back afterwards

      await service.update('p1', 'org-1', {
        type: 'GOOGLE' as any,
        name: 'Google',
        clientId: 'c',
        isActive: false,
      });

      expect(prisma.identityProvider.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            config: { hostedDomain: 'corp.example.com' },
          }),
        }),
      );
    });

    it('replaces the config when one IS supplied', async () => {
      prisma.identityProvider.findFirst
        .mockResolvedValueOnce(existing)
        .mockResolvedValueOnce({ id: 'p1' });

      await service.update('p1', 'org-1', {
        type: 'GOOGLE' as any,
        name: 'Google',
        clientId: 'c',
        config: { hostedDomain: 'other.example.com' },
      });

      expect(prisma.identityProvider.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            config: { hostedDomain: 'other.example.com' },
          }),
        }),
      );
    });

    it('scopes the write itself by organization, not just the check', async () => {
      prisma.identityProvider.findFirst
        .mockResolvedValueOnce(existing)
        .mockResolvedValueOnce({ id: 'p1' });

      await service.update('p1', 'org-1', {
        type: 'GOOGLE' as any,
        name: 'Google',
        clientId: 'c',
      });

      expect(prisma.identityProvider.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'p1', organizationId: 'org-1' },
        }),
      );
    });

    it('refuses to change the provider type', async () => {
      // The stored config was validated against the old schema and the issuer
      // against the old host allowlist; neither survives a type change.
      prisma.identityProvider.findFirst.mockResolvedValue(existing);

      await expect(
        service.update('p1', 'org-1', {
          type: 'ENTRA' as any,
          name: 'x',
          clientId: 'c',
        }),
      ).rejects.toThrow(/type cannot be changed/);
    });

    it('returns null for an id in another organization', async () => {
      prisma.identityProvider.findFirst.mockResolvedValue(null);
      expect(
        await service.update('p1', 'org-2', {
          type: 'GOOGLE' as any,
          name: 'x',
          clientId: 'c',
        }),
      ).toBeNull();
      expect(prisma.identityProvider.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('JIT role capping', () => {
    it('rejects anything above VIEWER rather than downgrading silently', async () => {
      await expect(
        service.create('org-1', { ...baseInput(), jitDefaultRole: 'EDITOR' as any }),
      ).rejects.toThrow(/only grant VIEWER/);
    });

    it('accepts VIEWER', async () => {
      prisma.identityProvider.create.mockResolvedValue({ id: 'p1' });
      prisma.identityProvider.update.mockResolvedValue({ id: 'p1' });
      await expect(
        service.create('org-1', { ...baseInput(), jitDefaultRole: 'VIEWER' as any }),
      ).resolves.toBeDefined();
    });
  });

  describe('issuer resolution', () => {
    it('derives a single-tenant Entra authority and ignores a supplied issuer', async () => {
      prisma.identityProvider.create.mockResolvedValue({ id: 'p1' });
      prisma.identityProvider.update.mockResolvedValue({ id: 'p1' });

      await service.create('org-1', {
        ...baseInput(),
        issuer: 'https://evil.tld/tenant/v2.0',
      });

      expect(prisma.identityProvider.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
          }),
        }),
      );
    });

    it('refuses a generic OIDC issuer in cloud', async () => {
      await expect(
        service.create('org-1', {
          type: 'OIDC' as any,
          name: 'Keycloak',
          clientId: 'c',
          clientSecret: 's',
          issuer: 'https://keycloak.internal/realms/x',
        }),
      ).rejects.toThrow(/self-hosted/);
    });
  });

  describe('PUBLIC_SELECT', () => {
    it('never selects the encrypted secret on any read path', async () => {
      // Guarded today only by a hand-maintained field list, so an added
      // `include` or a spread could leak it silently.
      prisma.identityProvider.findMany.mockResolvedValue([]);
      await service.findAll('org-1');
      prisma.identityProvider.findFirst.mockResolvedValue(null);
      await service.findByIdForOrg('p1', 'org-1');

      const selects = [
        prisma.identityProvider.findMany.mock.calls[0][0].select,
        prisma.identityProvider.findFirst.mock.calls[0][0].select,
      ];
      for (const select of selects) {
        expect(select).not.toHaveProperty('clientSecretEnc');
      }
    });
  });
});
