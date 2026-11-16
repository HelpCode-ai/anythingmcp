'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import { license, organizations, ApiError } from '@/lib/api';
import { Button } from '@/components/ui/button';

/** A workspace whose subscription blocks a deletion (409 `active_subscription`). */
export interface SubscribedWorkspace {
  id: string;
  name: string;
}

/**
 * The workspaces named by a deletion refused with `code: 'active_subscription'`,
 * or null for any other error. Cloud only: self-hosted never sends it.
 */
export function subscribedWorkspacesOf(err: unknown): SubscribedWorkspace[] | null {
  if (!(err instanceof ApiError) || err.status !== 409 || err.body?.code !== 'active_subscription') return null;
  const list = Array.isArray(err.body?.organizations) ? err.body.organizations : [];
  return list.filter(
    (o: unknown): o is SubscribedWorkspace =>
      !!o && typeof (o as SubscribedWorkspace).id === 'string' && typeof (o as SubscribedWorkspace).name === 'string',
  );
}

/**
 * Shown in a deletion dialog when the workspace still has a subscription that
 * Stripe would go on charging: deleting the workspace does not cancel it, so
 * the deletion is refused until it is cancelled. The button opens Stripe's
 * cancellation page for that workspace and comes back to `returnPath`.
 *
 * A workspace other than the one in use is switched to first, because the
 * billing portal opens for the signed-in workspace only.
 */
export function ActiveSubscriptionNotice({
  workspaces,
  returnPath,
}: {
  workspaces: SubscribedWorkspace[];
  /** Page of this app to come back to from Stripe, e.g. `/settings/organization`. */
  returnPath: string;
}) {
  const t = useTranslations('activeSubscription');
  const { token, user, replaceSession } = useAuth();
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cancel = async (workspace: SubscribedWorkspace) => {
    if (!token) return;
    setOpening(workspace.id);
    setError(null);
    const returnUrl = new URL(returnPath, window.location.origin).toString();
    try {
      let session = token;
      if (workspace.id !== user?.organizationId) {
        const switched = await organizations.switchOrg(workspace.id, token);
        replaceSession(switched.accessToken, switched.user, switched.organization?.name ?? null);
        session = switched.accessToken;
      }
      // Stripe's cancellation page itself: the portal's start page has no
      // Cancel button on Cloud (the licence site leaves it out there).
      const { url } = await license.billingPortal(session, returnUrl, 'cancel');
      window.location.assign(url);
    } catch (err: any) {
      setError(err?.message || t('openFailed'));
      setOpening(null);
    }
  };

  if (workspaces.length === 0) return null;
  return (
    <div className="mb-4 p-3 rounded-[9px] border border-[var(--danger)]/30 bg-[var(--t-danger-bg)] text-sm text-[var(--t-danger-fg)]">
      <p className="font-medium mb-1">{t('title')}</p>
      <p className="mb-3">{t('body')}</p>
      <ul className="space-y-2">
        {workspaces.map((w) => (
          <li key={w.id} className="flex flex-wrap items-center justify-between gap-2">
            {workspaces.length > 1 && <span className="font-medium">{w.name}</span>}
            <Button
              variant="primary"
              size="sm"
              onClick={() => void cancel(w)}
              disabled={opening !== null}
            >
              {opening === w.id ? t('opening') : t('cancelButton')}
            </Button>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs">{t('after')}</p>
      {error && (
        <p className="mt-2">
          {error}{' '}
          <Link href="/settings/license" className="underline">
            {t('licensePage')}
          </Link>
        </p>
      )}
    </div>
  );
}
