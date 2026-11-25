'use client';

import { useEffect, useState } from 'react';
import { users } from './api';
import { useAuth } from './auth-context';

interface Members {
  /** Name (or e-mail) by user id, of every member, active or not. */
  names: Map<string, string>;
  /** Members who are not deactivated. */
  active: number;
}

/** One load per session and workspace: the list and the detail page both ask. */
let cached: { key: string; promise: Promise<Members> } | null = null;

function load(key: string, token: string): Promise<Members> {
  if (cached?.key === key) return cached.promise;
  const promise = users
    .list(token)
    .then((list) => {
      const names = new Map<string, string>();
      let active = 0;
      for (const u of Array.isArray(list) ? list : []) {
        if (!u?.id) continue;
        names.set(u.id, u.name || u.email || u.id);
        if (u.active !== false && !u.deactivatedAt) active++;
      }
      return { names, active };
    })
    .catch(() => {
      if (cached?.key === key) cached = null;
      return { names: new Map<string, string>(), active: 0 };
    });
  cached = { key, promise };
  return promise;
}

/**
 * Who owns a connector, for the admins of a workspace with several members.
 *
 * Ownership decides what a member sees and manages (an EDITOR always sees the
 * connectors they own, in full, and only the owner or an admin changes one),
 * but nothing in the dashboard said who the owner was. An admin who made a
 * member a Viewer could not tell why that member still had "their" connectors.
 *
 * In a workspace with one active member the answer is always that member, so
 * nothing is shown there.
 *
 * `memberCount` is the number of active members when the page already knows
 * it: Cloud pages have it from the plan usage they load anyway
 * (`usePlanUsage`), and with one member the members list is not requested at
 * all. Pass `null` while that number is loading, and `undefined` where no
 * page has it (self-hosted, whose only count is of the whole instance): the
 * hook then makes the one request for the workspace's members itself.
 *
 * Returns the name (or e-mail) of the member with that id; `null` for an
 * owner who is no longer a member of the workspace; `undefined` when no owner
 * line is to be shown (loading, not an admin, or a single-member workspace).
 */
export function useConnectorOwners(
  memberCount?: number | null,
): (userId: string | null | undefined) => string | null | undefined {
  const { token, user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const worthAsking = memberCount === undefined || (memberCount !== null && memberCount > 1);
  const key = token && isAdmin && worthAsking ? `${user?.organizationId ?? ''}:${token}` : null;
  const [result, setResult] = useState<{ key: string; members: Members } | null>(null);

  useEffect(() => {
    if (!key || !token) return;
    let active = true;
    load(key, token).then((members) => {
      if (active) setResult({ key, members });
    });
    return () => {
      active = false;
    };
  }, [key, token]);

  return (userId) => {
    if (!key || result?.key !== key || !userId) return undefined;
    if (result.members.active <= 1) return undefined;
    return result.members.names.get(userId) ?? null;
  };
}
