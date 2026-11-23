'use client';

import { useEffect, useState } from 'react';
import { memberVisibility, type MemberVisibilityState } from './api';
import { useAuth } from './auth-context';
import { writeNavHint } from './member-access';

const OPEN: MemberVisibilityState = Object.freeze({ mode: 'open', restrictedForMe: false }) as MemberVisibilityState;
const CHANGED = 'amcp:member-visibility-changed';

/**
 * One request per session and workspace, shared by every mounted hook. The
 * key holds the token and the workspace id: switching workspace issues a new
 * token, so the next read loads again. Only the latest key is kept.
 */
let cached: { key: string; promise: Promise<MemberVisibilityState> } | null = null;
/**
 * The answer of the latest key once it has arrived. The app shell (and with
 * it the sidebar) is mounted again by every page, and a hook that only knew
 * the promise reported "still loading" for one frame on each of them: the
 * navigation of a member would flicker on every click.
 */
let settled: { key: string; state: MemberVisibilityState } | null = null;

/** Keeps the answer for the next mount and for the next page load (the navigation hint). */
function settle(key: string, state: MemberVisibilityState): void {
  settled = { key, state };
  writeNavHint(state.restrictedForMe ? 'restricted' : null);
}

function cacheKey(token: string, organizationId: string | null | undefined): string {
  return `${organizationId ?? ''}:${token}`;
}

/** Anything but a well-formed answer reads as open, so nothing narrows by accident. */
function normalize(raw: unknown): MemberVisibilityState {
  const r = (raw ?? {}) as Partial<MemberVisibilityState>;
  return {
    mode: r.mode === 'restricted' ? 'restricted' : 'open',
    restrictedForMe: r.mode === 'restricted' && r.restrictedForMe === true,
  };
}

function load(token: string, organizationId: string | null | undefined): Promise<MemberVisibilityState> {
  const key = cacheKey(token, organizationId);
  if (cached?.key === key) return cached.promise;
  const promise = memberVisibility
    .get(token)
    .then((raw) => {
      const state = normalize(raw);
      if (cached?.key === key) settle(key, state);
      return state;
    })
    .catch(() => {
      // Not kept: the next mount asks again instead of staying open for good.
      if (cached?.key === key) cached = null;
      return OPEN;
    });
  cached = { key, promise };
  return promise;
}

/**
 * Store what an admin just saved, so every mounted hook shows it without
 * another request.
 */
export function notifyMemberVisibilityChanged(
  token: string,
  organizationId: string | null | undefined,
  state: MemberVisibilityState,
): void {
  const key = cacheKey(token, organizationId);
  const normalized = normalize(state);
  cached = { key, promise: Promise.resolve(normalized) };
  settle(key, normalized);
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGED));
}

/**
 * The member visibility of the active workspace (Settings → Organization).
 * `restrictedForMe` is true for a member who is not an admin in a workspace
 * set to restricted; such a member sees only their own calls and what their
 * roles reach. While loading, when signed out and on error the hook reports
 * `{ mode: 'open', restrictedForMe: false }`, so no page changes by accident.
 * `loaded` tells "still loading" apart from "open" for the callers that must
 * wait (the onboarding redirect).
 */
export function useMemberVisibility(): MemberVisibilityState & { loaded: boolean } {
  const { token, user } = useAuth();
  const organizationId = user?.organizationId;
  const key = token ? cacheKey(token, organizationId) : null;
  const [result, setResult] = useState<{ key: string; state: MemberVisibilityState } | null>(null);

  useEffect(() => {
    if (!token || !key) return;
    let active = true;
    const read = () => {
      load(token, organizationId).then((state) => {
        if (active) setResult({ key, state });
      });
    };
    read();
    window.addEventListener(CHANGED, read);
    return () => {
      active = false;
      window.removeEventListener(CHANGED, read);
    };
  }, [token, organizationId, key]);

  // A result for another session or workspace is not this one's.
  if (!key) return { ...OPEN, loaded: false };
  if (result?.key === key) return { ...result.state, loaded: true };
  // Already answered for this session (another mount asked): no loading frame.
  if (settled?.key === key) return { ...settled.state, loaded: true };
  return { ...OPEN, loaded: false };
}
