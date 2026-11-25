'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { mcpServers, memory } from './api';
import { useAuth } from './auth-context';
import {
  accessTo,
  canCreateWorkspace,
  type Access,
  type MemberAccessFacts,
  type NavHint,
} from './member-access';
import { useMemberVisibility } from './use-member-visibility';

/**
 * The navigation hint the server read from its cookie (see member-access.ts),
 * the same on the server and while hydrating.
 */
const NavHintContext = createContext<NavHint>(null);

export function NavHintProvider({ hint, children }: { hint: NavHint; children: ReactNode }) {
  return <NavHintContext.Provider value={hint}>{children}</NavHintContext.Provider>;
}

/**
 * What only a restricted member's navigation needs to know. `null`: the
 * request for it failed, so it is not known.
 */
interface RestrictedFacts {
  ownsMcpServer: boolean | null;
  memoryAccess: boolean | null;
}

/**
 * One load per session and workspace, shared by every mounted hook, like the
 * member visibility itself: the app shell is mounted again by every page.
 *
 * Only a complete answer is kept. When a request fails, nothing is cached:
 * the next page asks again, so one failed request does not take "MCP Servers"
 * away from a member until they reload.
 */
let cached: { key: string; promise: Promise<RestrictedFacts> } | null = null;
let settled: { key: string; facts: RestrictedFacts } | null = null;

function loadFacts(key: string, token: string): Promise<RestrictedFacts> {
  if (cached?.key === key) return cached.promise;
  const promise = Promise.all([
    // A restricted member is listed only the servers they own.
    mcpServers
      .list(token)
      .then((list) => Array.isArray(list) && list.length > 0)
      .catch(() => null),
    memory
      .status(token)
      .then((s) => !!s?.licensed && (s.isCurator === true || (!!s.access && s.access !== 'none')))
      .catch(() => null),
  ]).then(([ownsMcpServer, memoryAccess]) => {
    const facts = { ownsMcpServer, memoryAccess };
    if (cached?.key === key) {
      if (ownsMcpServer === null || memoryAccess === null) cached = null;
      else settled = { key, facts };
    }
    return facts;
  });
  cached = { key, promise };
  return promise;
}

export interface MemberAccess {
  /**
   * The role and member visibility of this session are known. Until then the
   * answers below are the guess described at `restricted`.
   */
  decided: boolean;
  /**
   * Member visibility narrows this member's view. While not `decided` it is
   * true only when the browser's last known answer was "restricted" (the
   * navigation hint), so everyone else gets the page as always.
   */
  restricted: boolean;
  /** `allow`, `deny`, or `pending` while a fact the path depends on loads. */
  access: (pathname: string) => Access;
  /** Shorthand for `access(pathname) === 'allow'`: show the entry, render the link. */
  can: (pathname: string) => boolean;
  /** May create a workspace (Cloud: everyone; self-hosted: admins). */
  canCreateWorkspace: boolean;
}

/**
 * What the signed-in member may open: the single source for the sidebar, the
 * command palette, the settings navigation, links on pages and the route
 * guard. The rules live in member-access.ts; this hook supplies the facts.
 *
 * Admins and members of an Open workspace get `allow` for everything and no
 * extra request. For a restricted member it asks, once per session, whether
 * they own an MCP server and whether Memory has something for them. A fact
 * whose request failed counts as "yes" for now and is asked again by the next
 * page: a failed request never hides an entry or refuses a page, the API
 * still decides what the page shows.
 */
export function useMemberAccess(): MemberAccess {
  const { token, user, isLoading, deploymentMode } = useAuth();
  const visibility = useMemberVisibility();
  const hint = useContext(NavHintContext);

  const role = user?.role;
  const isAdmin = role === 'ADMIN';
  const decided = !isLoading && !!user && (isAdmin || visibility.loaded);
  const restricted = isAdmin
    ? false
    : user && visibility.loaded
      ? visibility.restrictedForMe
      : hint === 'restricted';

  const key = token && user ? `${user.organizationId ?? ''}:${token}` : null;
  const needsFacts = decided && restricted && !!key;
  const [loaded, setLoaded] = useState<{ key: string; facts: RestrictedFacts } | null>(null);

  useEffect(() => {
    if (!needsFacts || !key || !token) return;
    let active = true;
    loadFacts(key, token).then((facts) => {
      if (active) setLoaded({ key, facts });
    });
    return () => {
      active = false;
    };
  }, [needsFacts, key, token]);

  // A complete answer another mount got (after this one's request failed) wins.
  const known =
    !needsFacts || !key ? null : settled?.key === key ? settled.facts : loaded?.key === key ? loaded.facts : null;
  // Still loading: null (pending). Asked and failed: not a reason to refuse.
  const ownsMcpServer = known ? (known.ownsMcpServer ?? true) : null;
  const memoryAccess = known ? (known.memoryAccess ?? true) : null;

  const facts: MemberAccessFacts = useMemo(
    () => ({ role, restricted, ownsMcpServer, memoryAccess }),
    [role, restricted, ownsMcpServer, memoryAccess],
  );
  const access = useCallback((pathname: string) => accessTo(pathname, facts), [facts]);
  const can = useCallback((pathname: string) => accessTo(pathname, facts) === 'allow', [facts]);

  return {
    decided,
    restricted,
    access,
    can,
    canCreateWorkspace: canCreateWorkspace(role, deploymentMode === 'cloud'),
  };
}
