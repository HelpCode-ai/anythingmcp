import 'reflect-metadata';
import { LoginController } from './login.controller';

/**
 * Test helper. The page after approving into an empty workspace is no longer
 * the body of the request that finished the sign-in: that request answers
 * with a redirect to `GET /auth/next`, which renders the page from signed
 * cookies. The specs written against the page call the sign-in entry points
 * with a fake response; this makes those calls follow the redirect in place,
 * as a browser would, so the page lands in the same fake response.
 *
 * What the specs still see: every cookie the first response set, `_sent` with
 * the page, `_followed = '/auth/next'`, and no `_redirect`. The redirect
 * itself and the page's own route are tested in login.controller.paused-page.spec.ts
 * with `rawEntryPoints`, which are the methods as they are.
 */
const ENTRY_POINTS = [
  'handleLogin',
  'socialCallback',
  'handleServerSelection',
  'handleEmailCode',
  'continueAfterEmailLink',
] as const;

type EntryPoint = (typeof ENTRY_POINTS)[number];

export const rawEntryPoints: Partial<Record<EntryPoint, (...args: any[]) => Promise<unknown>>> = {};

const isFakeRes = (v: any) => !!v && typeof v === 'object' && '_cookies' in v && typeof v.redirect === 'function';
const isReq = (v: any) => !!v && typeof v === 'object' && !isFakeRes(v) && ('cookies' in v || 'signedCookies' in v || 'headers' in v);

export async function followPausedPage(controller: LoginController, res: any, req: any): Promise<void> {
  if (!isFakeRes(res) || res._redirect !== '/auth/next') return;
  const signed: Record<string, unknown> = { ...(req?.signedCookies ?? {}) };
  for (const name of (res._cleared as string[] | undefined) ?? []) delete signed[name];
  for (const [name, cookie] of Object.entries(res._cookies as Record<string, any>)) {
    if (cookie?.options?.signed) signed[name] = cookie.value;
  }
  res._redirect = undefined;
  res._followed = '/auth/next';
  await controller.showPausedPage({ ...(req ?? {}), signedCookies: signed } as any, res);
}

let installed = false;

/** Call once at the top of a spec file (module scope). */
export function followPausedPageInPlace(): void {
  if (installed) return;
  installed = true;
  for (const name of ENTRY_POINTS) {
    const original = (LoginController.prototype as any)[name] as (...args: any[]) => Promise<unknown>;
    rawEntryPoints[name] = original;
    const wrapper = async function (this: LoginController, ...args: any[]) {
      const out = await original.apply(this, args);
      await followPausedPage(this, args.find(isFakeRes), args.find(isReq));
      return out;
    };
    // Guards read the route's decorators (rate limits, …) and its name from
    // the handler function: the wrapper must look like the method it wraps.
    Object.defineProperty(wrapper, 'name', { value: name });
    for (const key of Reflect.getMetadataKeys(original)) {
      Reflect.defineMetadata(key, Reflect.getMetadata(key, original), wrapper);
    }
    (LoginController.prototype as any)[name] = wrapper;
  }
}
