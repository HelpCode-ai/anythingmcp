'use client';

import { useCallback, useEffect, useRef } from 'react';
import { productEvents } from './api';
import type { CatalogSearchResult } from './catalog-search';

/** Quiet time after the last keystroke before a query counts as a search. */
const SETTLE_MS = 1500;

export type CatalogSearchSurface = 'store' | 'welcome';

/**
 * Reports what people search the connector catalog for, so the searches that
 * find nothing tell us which connectors to build next.
 *
 * Only a settled query is sent: once typing has paused for SETTLE_MS, when a
 * result is picked, or when the page is left. "s", "sh", "sho" on the way to
 * "shopify" never reach the server, and the same query is not sent twice in a
 * row. `search` is null while the catalog is still loading; nothing is sent
 * until it is known. With the result count go the words nothing matched
 * (`missing`) and, when something did, how (`match`: 'fuzzy' for a typo
 * forgiven, see catalog-search.ts).
 *
 * Returns `picked(slug)`, to call when a result is opened after a search.
 */
export function useCatalogSearchReport(
  token: string | null,
  via: CatalogSearchSurface,
  query: string,
  search: CatalogSearchResult<unknown> | null,
): (adapterSlug: string) => void {
  const latest = useRef({ query, search });
  const sent = useRef('');

  useEffect(() => {
    latest.current = { query, search };
  }, [query, search]);

  const flush = useCallback(() => {
    const q = latest.current.query.trim();
    const s = latest.current.search;
    if (!token || q.length < 2 || s == null || q === sent.current) return;
    sent.current = q;
    productEvents.track('catalog_search', token, {
      query: q,
      results: s.hits.length,
      via,
      ...(s.missing.length ? { missing: s.missing.join(' ') } : {}),
      ...(s.hits.length ? { match: s.match } : {}),
    });
  }, [token, via]);

  useEffect(() => {
    const timer = setTimeout(flush, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [query, search, flush]);

  // Leaving the page (tab closed, or navigating away) mid-pause still counts.
  useEffect(() => {
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [flush]);

  return useCallback(
    (adapterSlug: string) => {
      const q = latest.current.query.trim();
      if (!token || q.length < 2) return;
      flush();
      productEvents.track('catalog_search_picked', token, { query: q, adapterSlug, via });
    },
    [token, via, flush],
  );
}
