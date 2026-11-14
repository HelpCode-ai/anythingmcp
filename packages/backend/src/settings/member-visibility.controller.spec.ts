process.env.ENCRYPTION_KEY ??= 'unit-test-encryption-key-0123456789abcdef';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { JwtOrManagementKeyGuard } from '../auth/jwt-or-management-key.guard';
import { RolesGuard } from '../auth/roles.guard';
import { PrismaService } from '../common/prisma.service';
import { SecurityEventService } from '../audit/security-event.service';
import { RolesService } from '../roles/roles.service';
import { OrgSettingsService } from './org-settings.service';
import { SiteSettingsService } from './site-settings.service';
import { MemberVisibilityService } from './member-visibility.service';
import {
  MemberVisibilityAdminController,
  MemberVisibilityMemberController,
} from './member-visibility.controller';

const ORG = 'org1';

// One management key per caller. The real guard resolves the key to its
// owner's identity and their role in the key's workspace.
const KEYS = {
  admin: { key: 'mcp_a0', userId: 'admin1', role: 'ADMIN', scope: 'MANAGEMENT_ADMIN' },
  adminRead: { key: 'mcp_a1', userId: 'admin1', role: 'ADMIN', scope: 'MANAGEMENT_READ' },
  editor: { key: 'mcp_e0', userId: 'editor1', role: 'EDITOR', scope: 'MANAGEMENT_ADMIN' },
  viewer: { key: 'mcp_b0', userId: 'viewer1', role: 'VIEWER', scope: 'MANAGEMENT_ADMIN' },
} as const;
type Caller = keyof typeof KEYS;

describe('member visibility routes', () => {
  let app: INestApplication;
  let base: string;
  let visibility: MemberVisibilityService;
  const settings = new Map<string, string>();
  const securityEvents = { log: jest.fn(async () => undefined) };
  const roles = { getAllowedToolIds: jest.fn(async () => null) };

  const prisma = {
    mcpApiKey: {
      findFirst: jest.fn(async ({ where }: any) => {
        const presented = where.OR.find((w: any) => 'key' in w)?.key;
        const k = Object.values(KEYS).find((x) => x.key === presented);
        if (!k) return null;
        return {
          id: `key-${k.key}`,
          key: k.key,
          keyHash: 'hashed',
          isActive: true,
          expiresAt: null,
          scope: k.scope,
          userId: k.userId,
          organizationId: ORG,
          user: { id: k.userId, email: `${k.userId}@example.test`, role: 'ADMIN', organizationId: ORG },
        };
      }),
      update: jest.fn(async () => ({})),
    },
    organizationMember: {
      findUnique: jest.fn(async ({ where }: any) => {
        const k = Object.values(KEYS).find((x) => x.userId === where.userId_organizationId.userId);
        return k ? { deactivatedAt: null, role: k.role } : null;
      }),
    },
    orgSettings: {
      findUnique: jest.fn(async ({ where }: any) => {
        const { organizationId, key } = where.organizationId_key;
        const value = settings.get(`${organizationId}:${key}`);
        return value === undefined ? null : { organizationId, key, value };
      }),
      upsert: jest.fn(async ({ where, update }: any) => {
        const { organizationId, key } = where.organizationId_key;
        settings.set(`${organizationId}:${key}`, update.value);
        return {};
      }),
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MemberVisibilityMemberController, MemberVisibilityAdminController],
      providers: [
        MemberVisibilityService,
        OrgSettingsService,
        { provide: SiteSettingsService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
        { provide: RolesService, useValue: roles },
        { provide: SecurityEventService, useValue: securityEvents },
      ],
    }).compile();
    visibility = moduleRef.get(MemberVisibilityService);
    app = moduleRef.createNestApplication();
    // Same options as main.ts.
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    settings.clear();
    // Each test starts with a cold 30 s mode cache.
    (visibility as any).cache.clear();
    jest.clearAllMocks();
  });

  const call = (caller: Caller, method: 'GET' | 'PUT', path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${KEYS[caller].key}`,
        'Content-Type': 'application/json',
        'User-Agent': 'spec-agent',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const get = (caller: Caller) => call(caller, 'GET', '/api/settings/member-visibility');
  const put = (caller: Caller, body: unknown) => call(caller, 'PUT', '/api/admin/settings/member-visibility', body);
  const stored = () => settings.get(`${ORG}:member_visibility`);

  describe('GET /api/settings/member-visibility', () => {
    it.each(['admin', 'adminRead', 'editor', 'viewer'] as Caller[])('answers open for %s in a workspace without the setting', async (caller) => {
      const res = await get(caller);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ mode: 'open', restrictedForMe: false });
    });

    it('reports restrictedForMe for members who are not admins in a restricted workspace', async () => {
      settings.set(`${ORG}:member_visibility`, 'restricted');
      expect(await (await get('viewer')).json()).toEqual({ mode: 'restricted', restrictedForMe: true });
      expect(await (await get('editor')).json()).toEqual({ mode: 'restricted', restrictedForMe: true });
      expect(await (await get('admin')).json()).toEqual({ mode: 'restricted', restrictedForMe: false });
    });

    it('reads the caller workspace only, and no role lookup', async () => {
      await get('viewer');
      expect(prisma.orgSettings.findUnique).toHaveBeenCalledWith({
        where: { organizationId_key: { organizationId: ORG, key: 'member_visibility' } },
      });
      expect(roles.getAllowedToolIds).not.toHaveBeenCalled();
    });

    it('refuses a request without credentials', async () => {
      const res = await fetch(`${base}/api/settings/member-visibility`, {
        headers: { Authorization: 'Bearer mcp_ff' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('PUT /api/admin/settings/member-visibility', () => {
    it('lets an ADMIN switch to restricted, and writes a security event', async () => {
      const res = await put('admin', { mode: 'restricted' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ mode: 'restricted', restrictedForMe: false });
      expect(stored()).toBe('restricted');
      expect(securityEvents.log).toHaveBeenCalledTimes(1);
      expect(securityEvents.log).toHaveBeenCalledWith({
        event: 'MEMBER_VISIBILITY_CHANGED',
        actorType: 'USER',
        organizationId: ORG,
        actorUserId: 'admin1',
        metadata: { from: 'open', to: 'restricted' },
        ip: expect.any(String),
        userAgent: 'spec-agent',
      });
      // The member view follows at once in this process.
      expect(await (await get('viewer')).json()).toEqual({ mode: 'restricted', restrictedForMe: true });
    });

    it('switches back to open and logs the old and new mode', async () => {
      settings.set(`${ORG}:member_visibility`, 'restricted');
      const res = await put('admin', { mode: 'open' });
      expect(res.status).toBe(200);
      expect(stored()).toBe('open');
      expect(securityEvents.log).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { from: 'restricted', to: 'open' } }),
      );
    });

    it('writes no row and no event when the mode does not change', async () => {
      const res = await put('admin', { mode: 'open' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ mode: 'open', restrictedForMe: false });
      expect(prisma.orgSettings.upsert).not.toHaveBeenCalled();
      expect(securityEvents.log).not.toHaveBeenCalled();
    });

    it.each(['editor', 'viewer'] as Caller[])('refuses %s with 403', async (caller) => {
      const res = await put(caller, { mode: 'restricted' });
      expect(res.status).toBe(403);
      expect(stored()).toBeUndefined();
      expect(securityEvents.log).not.toHaveBeenCalled();
    });

    it('refuses a read-only management key of an ADMIN with 403', async () => {
      const res = await put('adminRead', { mode: 'restricted' });
      expect(res.status).toBe(403);
      expect((await res.json()).message).toBe('This API key is read-only');
      expect(stored()).toBeUndefined();
      expect(securityEvents.log).not.toHaveBeenCalled();
    });

    it.each([
      [{ mode: 'closed' }],
      [{ mode: 'RESTRICTED' }],
      [{ mode: true }],
      [{}],
      [{ mode: 'restricted', organizationId: 'org2' }],
    ])('answers 400 for %j', async (body) => {
      const res = await put('admin', body);
      expect(res.status).toBe(400);
      expect(prisma.orgSettings.upsert).not.toHaveBeenCalled();
      expect(securityEvents.log).not.toHaveBeenCalled();
    });

    it("always writes the caller's own workspace", async () => {
      await put('admin', { mode: 'restricted' });
      expect(prisma.orgSettings.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { organizationId_key: { organizationId: ORG, key: 'member_visibility' } } }),
      );
    });
  });

  describe('OpenAPI', () => {
    it('documents both operations with a description, an amcp example and the mode enum', () => {
      const doc = SwaggerModule.createDocument(app, new DocumentBuilder().build());
      const getOp = (doc.paths['/api/settings/member-visibility'] as any).get;
      const putOp = (doc.paths['/api/admin/settings/member-visibility'] as any).put;
      expect(getOp.description).toContain('amcp api GET /api/settings/member-visibility');
      expect(putOp.description).toContain('amcp api PUT /api/admin/settings/member-visibility');
      expect(putOp.description).toContain('MEMBER_VISIBILITY_CHANGED');
      const schema = (doc.components?.schemas as any).MemberVisibilityDto;
      expect(schema.properties.mode.enum).toEqual(['open', 'restricted']);
      expect(schema.required).toEqual(['mode']);
    });
  });

  describe('guards', () => {
    it('GET needs a signed-in member, with no role restriction', () => {
      expect(Reflect.getMetadata(GUARDS_METADATA, MemberVisibilityMemberController)).toEqual([JwtOrManagementKeyGuard]);
      expect(Reflect.getMetadata('roles', MemberVisibilityMemberController)).toBeUndefined();
    });

    it('PUT is ADMIN only', () => {
      expect(Reflect.getMetadata(GUARDS_METADATA, MemberVisibilityAdminController)).toEqual([
        JwtOrManagementKeyGuard,
        RolesGuard,
      ]);
      expect(Reflect.getMetadata('roles', MemberVisibilityAdminController)).toEqual(['ADMIN']);
    });
  });
});
