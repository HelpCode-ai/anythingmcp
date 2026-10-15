'use client';

import { useEffect, useState } from 'react';
import { auth, license } from './api';
import { useAuth } from './auth-context';
import type { ClickIds } from './attribution';
import { buildPricingUrl } from './marketing';

interface PricingLinkData {
  ids: ClickIds | null;
  emailToken: string | null;
}

/**
 * One lookup per session, shared by every pricing link on the page. A failed
 * lookup resolves to null: the link then simply goes without it.
 */
let cached: { token: string; data: Promise<PricingLinkData> } | null = null;

function lookup(token: string): Promise<PricingLinkData> {
  if (cached?.token !== token) {
    const ids = auth.attributionClickIds(token).then(
      ({ gclid, gbraid, wbraid, oppref }) => ({ gclid, gbraid, wbraid, oppref }),
      () => null,
    );
    const emailToken = license.pricingLinkToken(token).then(
      (r) => (typeof r?.token === 'string' ? r.token : null),
      () => null,
    );
    cached = { token, data: Promise.all([ids, emailToken]).then(([i, t]) => ({ ids: i, emailToken: t })) };
  }
  return cached.data;
}

/**
 * The pricing link (see buildPricingUrl), on AnythingMCP Cloud carrying
 *   - the signed-in user's own ad click ids (Google Ads, ChatGPT Ads' oppref)
 *     when the Cloud stored them with their ad consent, so the purchase can
 *     be reported to the ad platform as a conversion;
 *   - their address token, so the pricing page knows who is buying and
 *     refuses a second subscription beside a card trial or plan the address
 *     already has.
 *
 * Self-hosted builds never ask for either and never add one. Until the lookup
 * answers, and whenever it fails, the plain link is returned.
 */
export function usePricingUrl(returnPath?: string): string {
  const { token, deploymentMode, deploymentModeLoaded } = useAuth();
  const isCloud = deploymentModeLoaded && deploymentMode === 'cloud';
  const [found, setFound] = useState<{ token: string; data: PricingLinkData } | null>(null);

  useEffect(() => {
    if (!isCloud || !token) return;
    let live = true;
    lookup(token).then((data) => {
      if (live) setFound({ token, data });
    });
    return () => {
      live = false;
    };
  }, [isCloud, token]);

  const data = isCloud && token && found?.token === token ? found.data : null;
  return buildPricingUrl(returnPath, data?.ids ?? null, deploymentModeLoaded && !isCloud, data?.emailToken ?? null);
}
