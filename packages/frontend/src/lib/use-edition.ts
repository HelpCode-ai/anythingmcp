'use client';

import { useCallback, useEffect, useState } from 'react';
import { license, type EditionState } from './api';
import { useAuth } from './auth-context';

const CHANGED = 'amcp:edition-changed';

/** Tell every mounted useEdition to reload, e.g. after a trial started or a key was activated. */
export function notifyEditionChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(CHANGED));
}

/**
 * The edition of this self-hosted instance (Community or a licensed plan), its
 * user limit and whether the one-time trial of the Enterprise capabilities
 * (single sign-on, SCIM, more users) is still available. Null on Cloud, while
 * loading, and when signed out.
 */
export function useEdition(): { edition: EditionState | null; reload: () => void } {
  const { token, deploymentMode, deploymentModeLoaded } = useAuth();
  const [edition, setEdition] = useState<EditionState | null>(null);
  const selfHosted = deploymentModeLoaded && deploymentMode !== 'cloud';

  const reload = useCallback(() => {
    if (!token || !selfHosted) return;
    license.getEdition(token).then(setEdition).catch(() => setEdition(null));
  }, [token, selfHosted]);

  useEffect(() => {
    reload();
    window.addEventListener(CHANGED, reload);
    return () => window.removeEventListener(CHANGED, reload);
  }, [reload]);

  return { edition: token && selfHosted ? edition : null, reload };
}

export function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));
}

export function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}
