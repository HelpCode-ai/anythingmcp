/**
 * The catalog in install order, for the website: its connector marketplace
 * and its guides lead with the connectors most workspaces install, instead of
 * the newest guide or the longest tool list.
 *
 * Ranked from this deployment's own data: how many workspaces have a
 * connector installed from the adapter today (one workspace with five Odoo
 * connectors counts once). Only the order leaves the server, never a count,
 * and an adapter needs MIN_WORKSPACES workspaces before it is ranked, so one
 * tenant's choice never shows through. Adapters below that, and every adapter
 * on a fresh self-host with no data, are left to the caller's own order.
 */
export const INSTALL_RANKING_MIN_WORKSPACES = 3;
/** Installs move slowly and the website caches for a day anyway. */
export const INSTALL_RANKING_CACHE_MS = 6 * 60 * 60 * 1000;
