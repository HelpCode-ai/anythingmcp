// ESM-only, and only needed to run SSO flows; the routes are read, never run.
jest.mock('openid-client', () => ({}));

import 'reflect-metadata';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ForbiddenException, Logger, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { of } from 'rxjs';
import { ROLES_KEY } from '../auth/roles.guard';
import { ADMIN_WHEN_RESTRICTED_MESSAGE, MemberVisibilityInterceptor } from './member-visibility.interceptor';
import { MEMBER_VISIBILITY_DECISIONS, MEMBER_VISIBILITY_ROUTES } from './member-visibility.routes';
import { MemberVisibilityService } from './member-visibility.service';

/**
 * Every HTTP route of the API must carry an explicit member-visibility
 * decision in member-visibility.routes.ts.
 *
 * The routes are read the way Nest reads them: every source file that
 * declares a controller is loaded, and every handler with route metadata on
 * a class marked as a controller counts. A route that returns workspace data
 * and has no decision fails this spec, so it cannot reach a restricted member
 * unnoticed. A decision for a route that no longer exists fails it too, so
 * the table stays the list of real routes.
 *
 * Where reflection can check a decision, it does: `admin-only` without a note
 * must carry `@Roles('ADMIN')`, and a `scoped` route's controller must inject
 * MemberVisibilityService (three listed routes delegate to a service that does). `admin-when-restricted` is enforced by
 * MemberVisibilityInterceptor, tested below on every such route.
 */

const SRC = join(__dirname, '..');

interface Route {
  key: string;
  controller: any;
  handler: (...args: unknown[]) => unknown;
  method: string;
  path: string;
}

/** Source files that declare a controller (generated code and specs excluded). */
function controllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'generated' && entry.name !== 'node_modules') out.push(...controllerFiles(path));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.d.ts') &&
      readFileSync(path, 'utf8').includes('@Controller(')
    ) {
      out.push(path);
    }
  }
  return out.sort();
}

function joinPath(base: unknown, sub: unknown): string {
  const parts = [base, sub].filter((p): p is string => typeof p === 'string' && p !== '' && p !== '/');
  return ('/' + parts.join('/')).replace(/\/+/g, '/');
}

function collectRoutes(): { routes: Route[]; controllers: Set<string> } {
  const routes: Route[] = [];
  const controllers = new Set<string>();
  for (const file of controllerFiles(SRC)) {
     
    const mod = require(file) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== 'function' || !Reflect.getMetadata('__controller__', value)) continue;
      controllers.add(name);
      const base = Reflect.getMetadata(PATH_METADATA, value);
      const proto = (value as { prototype: Record<string, unknown> }).prototype;
      for (const prop of Object.getOwnPropertyNames(proto)) {
        const handler = proto[prop];
        if (prop === 'constructor' || typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler);
        if (method === undefined) continue;
        routes.push({
          key: `${name}.${prop}`,
          controller: value,
          handler: handler as (...args: unknown[]) => unknown,
          method: RequestMethod[method as RequestMethod],
          path: joinPath(base, Reflect.getMetadata(PATH_METADATA, handler)),
        });
      }
    }
  }
  return { routes, controllers };
}

// Loading every controller compiles most of the backend once.
jest.setTimeout(180_000);

let ROUTES: Route[];
let CONTROLLERS: Set<string>;
beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  ({ routes: ROUTES, controllers: CONTROLLERS } = collectRoutes());
});
afterAll(() => jest.restoreAllMocks());

describe('member visibility: a decision for every route', () => {
  it('finds the controllers (the scan cannot silently come back empty)', () => {
    expect(CONTROLLERS.size).toBeGreaterThan(50);
    expect(ROUTES.length).toBeGreaterThan(350);
    expect(CONTROLLERS).toContain('McpServersController');
    expect(CONTROLLERS).toContain('FileSearchController');
    // ee/ controllers are part of the API too.
    expect(CONTROLLERS).toContain('LearningController');
  });

  it('every route has a registered decision', () => {
    const missing = ROUTES.filter((r) => !MEMBER_VISIBILITY_ROUTES[r.key]).map((r) => `${r.key} (${r.method} ${r.path})`);
    // A new route: decide what a member who is not an admin gets from it in a
    // restricted workspace, then add it to member-visibility.routes.ts.
    expect(missing).toEqual([]);
  });

  it('every registered decision belongs to a route that exists', () => {
    const keys = new Set(ROUTES.map((r) => r.key));
    expect(Object.keys(MEMBER_VISIBILITY_ROUTES).filter((k) => !keys.has(k))).toEqual([]);
  });

  it('every decision is one of the known ones', () => {
    const known = new Set<string>(MEMBER_VISIBILITY_DECISIONS);
    const unknown = Object.entries(MEMBER_VISIBILITY_ROUTES)
      .filter(([, v]) => !known.has(v.decision))
      .map(([k]) => k);
    expect(unknown).toEqual([]);
  });

  it('admin-only without a note carries @Roles(\'ADMIN\')', () => {
    const wrong = ROUTES.filter((r) => {
      const rule = MEMBER_VISIBILITY_ROUTES[r.key];
      if (rule?.decision !== 'admin-only' || rule.note) return false;
      const roles = Reflect.getMetadata(ROLES_KEY, r.handler) ?? Reflect.getMetadata(ROLES_KEY, r.controller);
      return !(Array.isArray(roles) && roles.length === 1 && roles[0] === 'ADMIN');
    }).map((r) => r.key);
    expect(wrong).toEqual([]);
  });

  it('scoped routes inject MemberVisibilityService, unless they delegate to a service that does', () => {
    // A note explains the decision; it does not excuse the controller from
    // asking the service. These routes delegate to McpConnectionGrantService.
    const delegated = new Set([
      'LoginController.handleServerSelection',
      'McpConnectionsController.targets',
      'McpConnectionsController.update',
    ]);
    const wrong = ROUTES.filter((r) => {
      if (MEMBER_VISIBILITY_ROUTES[r.key]?.decision !== 'scoped' || delegated.has(r.key)) return false;
      const params: unknown[] = Reflect.getMetadata('design:paramtypes', r.controller) ?? [];
      return !params.includes(MemberVisibilityService);
    }).map((r) => r.key);
    expect(wrong).toEqual([]);
  });
});

describe('MemberVisibilityInterceptor', () => {
  const ORG = 'org-1';
  const build = (mode: 'open' | 'restricted') => {
    const orgSettings = { get: jest.fn(async () => (mode === 'restricted' ? 'restricted' : null)) };
    const roles = { getAllowedToolIds: jest.fn(async () => ['t1']) };
    const visibility = new MemberVisibilityService(orgSettings as any, roles as any);
    return { interceptor: new MemberVisibilityInterceptor(visibility), orgSettings, roles };
  };
  const context = (route: Route, role: string | null) =>
    ({
      getType: () => 'http',
      getClass: () => route.controller,
      getHandler: () => route.handler,
      switchToHttp: () => ({
        getRequest: () => (role ? { user: { sub: 'user-1', role, organizationId: ORG } } : {}),
      }),
    }) as any;
  const next = () => ({ handle: jest.fn(() => of('handled')) });

  const adminWhenRestricted = () =>
    ROUTES.filter((r) => MEMBER_VISIBILITY_ROUTES[r.key]?.decision === 'admin-when-restricted');

  it('has routes to enforce', () => {
    expect(adminWhenRestricted().map((r) => r.key)).toEqual(
      expect.arrayContaining(['KgController.getGraph', 'LearningController.list', 'LicenseController.planFitForUser']),
    );
  });

  it.each(['EDITOR', 'VIEWER'])('refuses every admin-when-restricted route to a restricted %s, before the handler', async (role) => {
    const { interceptor } = build('restricted');
    for (const route of adminWhenRestricted()) {
      const n = next();
      const err = await interceptor.intercept(context(route, role), n).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).message).toBe(ADMIN_WHEN_RESTRICTED_MESSAGE);
      expect(n.handle).not.toHaveBeenCalled();
    }
  });

  it('lets admins through in a restricted workspace without reading the mode', async () => {
    const { interceptor, orgSettings } = build('restricted');
    for (const route of adminWhenRestricted()) {
      const n = next();
      await interceptor.intercept(context(route, 'ADMIN'), n);
      expect(n.handle).toHaveBeenCalledTimes(1);
    }
    expect(orgSettings.get).not.toHaveBeenCalled();
  });

  it.each(['EDITOR', 'VIEWER'])('lets a %s through in an open workspace', async (role) => {
    const { interceptor, roles } = build('open');
    for (const route of adminWhenRestricted()) {
      const n = next();
      await interceptor.intercept(context(route, role), n);
      expect(n.handle).toHaveBeenCalledTimes(1);
    }
    expect(roles.getAllowedToolIds).not.toHaveBeenCalled();
  });

  it('passes every other route through without a database read', async () => {
    const { interceptor, orgSettings } = build('restricted');
    const others = ROUTES.filter((r) => MEMBER_VISIBILITY_ROUTES[r.key]?.decision !== 'admin-when-restricted');
    for (const route of others) {
      const n = next();
      await interceptor.intercept(context(route, 'VIEWER'), n);
      expect(n.handle).toHaveBeenCalledTimes(1);
    }
    expect(orgSettings.get).not.toHaveBeenCalled();
  });

  it('fails closed when the mode lookup throws', async () => {
    const boom = new Error('settings unavailable');
    const visibility = new MemberVisibilityService(
      { get: jest.fn(async () => Promise.reject(boom)) } as any,
      { getAllowedToolIds: jest.fn() } as any,
    );
    const interceptor = new MemberVisibilityInterceptor(visibility);
    const route = adminWhenRestricted()[0];
    const n = next();
    await expect(interceptor.intercept(context(route, 'VIEWER'), n)).rejects.toBe(boom);
    expect(n.handle).not.toHaveBeenCalled();
  });
});
