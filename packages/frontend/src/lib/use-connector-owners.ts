'use client';

import { useEffect, useState } from 'react';
import { users } from './api';
import { useAuth } from './auth-context';

type Owners = Map<string, string>;

/** One load per session and workspace: the list and the detail page both ask. */
let cached: { key: string; promise: Promise<Owners> } | null = null;

function load(key: string, token: string): Promise<Owners> {
  if (cached?.key === key) return cached.promise;
  const promise = users
    .list(token)
    .then((list) => {
      const owners: Owners = new Map();
      for (const u of Array.isArray(list) ? list : []) {
        if (u?.id) owners.set(u.id, u.name || u.email || u.id);
      }
      return owners;
    })
    .catch(() => {
      if (cached?.key === key) cached = null;
      return new Map() as Owners;
    });
  cached = { key, promise };
  return promise;
}

/**
 * Who owns a connector, for workspace admins.
 *
 * Ownership decides what a member sees and manages (an EDITOR always sees the
 * connectors they own, in full, and only the owner or an admin changes one),
 * but nothing in the dashboard said who the owner was. An admin who made a
 * member a Viewer could not tell why that member still had "their" connectors.
 *
 * Returns the name (or e-mail) of the member with that id; `null` for an
 * owner who is no longer a member of the workspace, and `undefined` while
 * loading or for anyone who is not an admin (the members list is theirs
 * alone, so nobody else asks for it).
 */
export function useConnectorOwners(): (userId: string | null | undefined) => string | null | undefined {
  const { token, user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const key = token && isAdmin ? `${user?.organizationId ?? ''}:${token}` : null;
  const [result, setResult] = useState<{ key: string; owners: Owners } | null>(null);

  useEffect(() => {
    if (!key || !token) return;
    let active = true;
    load(key, token).then((owners) => {
      if (active) setResult({ key, owners });
    });
    return () => {
      active = false;
    };
  }, [key, token]);

  return (userId) => {
    if (!key || result?.key !== key || !userId) return undefined;
    return result.owners.get(userId) ?? null;
  };
}
