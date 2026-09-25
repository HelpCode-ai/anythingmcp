'use client';

import { useCallback, useState, type MouseEvent } from 'react';
import { license } from './api';
import { useAuth } from './auth-context';
import { buildManagePlanUrl } from './marketing';

/**
 * A "change plan" / "update billing" link.
 *
 * On Cloud, an admin's click opens the Stripe billing portal for their own
 * workspace's subscription straight away (POST /api/license/billing-portal,
 * which the licence site answers for this server only). Everyone else — other
 * roles, self-hosted instances, or when that call fails — follows the plain
 * link to /account on the marketing site, which emails the portal link to the
 * address on the subscription.
 */
export function useManagePlan(params?: Record<string, string>) {
  const { token, user, deploymentMode } = useAuth();
  const [opening, setOpening] = useState(false);
  const href = buildManagePlanUrl(params);
  const direct = deploymentMode === 'cloud' && !!token && user?.role === 'ADMIN';

  const onClick = useCallback(
    async (event: MouseEvent<HTMLAnchorElement>) => {
      if (!direct || !token) return;
      event.preventDefault();
      setOpening(true);
      try {
        const { url } = await license.billingPortal(token, window.location.href);
        window.location.href = url;
      } catch {
        // No portal for this workspace (no paid subscription on file, licence
        // site unreachable): the /account page still gets them there.
        setOpening(false);
        window.location.href = href;
      }
    },
    [direct, token, href],
  );

  return { href, onClick, opening };
}
