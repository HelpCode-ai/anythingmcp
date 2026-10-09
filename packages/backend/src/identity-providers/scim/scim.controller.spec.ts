import { ScimController } from './scim.controller';
import { ScimError } from './scim.errors';

describe('ScimController — provisioning and the edition', () => {
  const req = { scimProvider: { id: 'p1', organizationId: 'o1' }, headers: {}, ip: '127.0.0.1', protocol: 'https' } as any;

  function make(edition: { business: boolean; seat: { ok: boolean; limit: number | null } }) {
    const users = { create: jest.fn(async () => ({ id: 'u' })), patch: jest.fn(async () => ({})), remove: jest.fn(async () => undefined) };
    const groups = { create: jest.fn(async () => ({ id: 'g' })) };
    const config = { get: () => 'https://amcp.example' };
    const ed = {
      hasBusiness: jest.fn(async () => edition.business),
      seatAvailable: jest.fn(async () => edition.seat),
    };
    const controller = new ScimController(users as any, groups as any, config as any, ed as any);
    return { controller, users, groups };
  }

  it('creates a user with Business and a free seat', async () => {
    const { controller, users } = make({ business: true, seat: { ok: true, limit: null } });
    await controller.createUser(req, {});
    expect(users.create).toHaveBeenCalled();
  });

  it('refuses to create a user without Business, as a SCIM 403', async () => {
    const { controller, users } = make({ business: false, seat: { ok: true, limit: 3 } });
    const err = await controller.createUser(req, {}).catch((e) => e);
    expect(err).toBeInstanceOf(ScimError);
    expect(err.getStatus()).toBe(403);
    expect(err.getResponse().detail).toContain('AnythingMCP Enterprise');
    expect(users.create).not.toHaveBeenCalled();
  });

  it('refuses to create a user when no seat is free', async () => {
    const { controller, users } = make({ business: true, seat: { ok: false, limit: 10 } });
    const err = await controller.createUser(req, {}).catch((e) => e);
    expect(err.getStatus()).toBe(403);
    expect(err.getResponse().detail).toContain('10 active users');
    expect(users.create).not.toHaveBeenCalled();
  });

  it('refuses to create a group without Business', async () => {
    const { controller, groups } = make({ business: false, seat: { ok: true, limit: 3 } });
    await expect(controller.createGroup(req, {})).rejects.toBeInstanceOf(ScimError);
    expect(groups.create).not.toHaveBeenCalled();
  });

  // A directory must always be able to take a leaver's access away.
  it('keeps updates and deletions working without Business', async () => {
    const { controller, users } = make({ business: false, seat: { ok: false, limit: 3 } });
    await controller.patchUser(req, 'u1', { Operations: [] });
    await controller.deleteUser(req, 'u1');
    expect(users.patch).toHaveBeenCalled();
    expect(users.remove).toHaveBeenCalled();
  });
});
