import { IdentityProvidersService, IdentityProviderError } from './identity-providers.service';

/**
 * `setEnforceSso` is the one setting in the product that can lock every human
 * out of a workspace, so each precondition gets its own test.
 */
describe('IdentityProvidersService.setEnforceSso', () => {
  let prisma: any;
  let service: IdentityProvidersService;

  const provider = (over: Record<string, unknown> = {}) => ({
    id: 'idp1',
    isActive: true,
    enforceSso: false,
    lastSuccessfulLoginAt: new Date(),
    ...over,
  });

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = 'a-test-encryption-key-of-32-chars!!';
    prisma = {
      identityProvider: {
        findFirst: jest.fn(async () => provider()),
        update: jest.fn(async () => ({ id: 'idp1', enforceSso: true })),
      },
    };
    service = new IdentityProvidersService(prisma, {
      mode: 'self-hosted',
      isCloud: () => false,
      isSelfHosted: () => true,
    } as any);
  });

  const actor = { userId: 'u1', hasRecoveryCodes: true };

  it('enables enforcement when every precondition holds', async () => {
    await service.setEnforceSso('idp1', 'org1', true, actor);
    expect(prisma.identityProvider.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { enforceSso: true } }),
    );
  });

  // Without this the admin is trusting a configuration nobody has ever used.
  it('refuses when nobody has completed a sign-in through the provider', async () => {
    prisma.identityProvider.findFirst.mockResolvedValue(
      provider({ lastSuccessfulLoginAt: null }),
    );
    await expect(service.setEnforceSso('idp1', 'org1', true, actor)).rejects.toThrow(
      IdentityProviderError,
    );
    expect(prisma.identityProvider.update).not.toHaveBeenCalled();
  });

  // The whole reason recovery codes exist.
  it('refuses when the admin holds no recovery codes', async () => {
    await expect(
      service.setEnforceSso('idp1', 'org1', true, { userId: 'u1', hasRecoveryCodes: false }),
    ).rejects.toThrow(IdentityProviderError);
    expect(prisma.identityProvider.update).not.toHaveBeenCalled();
  });

  // An inactive provider cannot be signed in through, so requiring it would
  // mean requiring something impossible.
  it('refuses when the provider is inactive', async () => {
    prisma.identityProvider.findFirst.mockResolvedValue(provider({ isActive: false }));
    await expect(service.setEnforceSso('idp1', 'org1', true, actor)).rejects.toThrow(
      IdentityProviderError,
    );
  });

  // Undoing a lockout risk must never be gated — including when the very
  // conditions that would allow enabling it no longer hold.
  it('always allows disabling, even with no recovery codes and no prior sign-in', async () => {
    prisma.identityProvider.findFirst.mockResolvedValue(
      provider({ enforceSso: true, isActive: false, lastSuccessfulLoginAt: null }),
    );
    await service.setEnforceSso('idp1', 'org1', false, {
      userId: 'u1',
      hasRecoveryCodes: false,
    });
    expect(prisma.identityProvider.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { enforceSso: false } }),
    );
  });

  it('returns null for a provider belonging to another workspace', async () => {
    prisma.identityProvider.findFirst.mockResolvedValue(null);
    expect(await service.setEnforceSso('idp1', 'other', true, actor)).toBeNull();
  });
});
