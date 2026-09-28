'use client';

import { useEffect, useState } from 'react';
import { auth } from './api';
import { useAuth } from './auth-context';
import type { ClickIds } from './attribution';
import { buildPricingUrl } from './marketing';

/**
 * One lookup per session, shared by every pricing link on the page. A failed
 * lookup resolves to null: the link then simply goes without a click id.
 */
let cached: { token: string; ids: Promise<ClickIds | null> } | null = null;

function lookupClickIds(token: string): Promise<ClickIds | null> {
  if (cached?.token !== token) {
    const ids = auth.attributionClickIds(token).then(
      ({ gclid, gbraid, wbraid }) => ({ gclid, gbraid, wbraid }),
      () => null,
    );
    cached = { token, ids };
  }
  return cached.ids;
}

/**
 * The pricing link (see buildPricingUrl), carrying the signed-in user's own
 * Google Ads click id when AnythingMCP Cloud stored one with their ad consent,
 * so the purchase can be reported to Google Ads as an offline conversion.
 *
 * Self-hosted builds never ask for it and never add one. Until the lookup
 * answers, and whenever it fails, the plain link is returned.
 */
export function usePricingUrl(returnPath?: string): string {
  const { token, deploymentMode, deploymentModeLoaded } = useAuth();
  const isCloud = deploymentModeLoaded && deploymentMode === 'cloud';
  const [found, setFound] = useState<{ token: string; ids: ClickIds | null } | null>(null);

  useEffect(() => {
    if (!isCloud || !token) return;
    let live = true;
    lookupClickIds(token).then((ids) => {
      if (live) setFound({ token, ids });
    });
    return () => {
      live = false;
    };
  }, [isCloud, token]);

  const clickIds = isCloud && token && found?.token === token ? found.ids : null;
  return buildPricingUrl(returnPath, clickIds);
}
