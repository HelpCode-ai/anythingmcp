// Curated, zero-credential connectors used for the onboarding "aha moment":
// install in one click (no auth), then auto-run a sample tool so a brand-new
// user sees a real, successful result before being asked to connect anything.
// All of them are authType NONE in the adapter catalog.
export interface DemoConnector {
  slug: string;
  name: string;
  emoji: string;
  blurb: string;
  /** Tool to auto-run after install (must exist on the installed adapter). */
  tool: string;
  /** Sample arguments chosen to reliably return a non-empty result. */
  params: Record<string, unknown>;
}

// Also the "Try it" call offered after a starter-pack install (keyed by
// slug), so each entry must work with no key from a datacenter address.
export const DEMO_CONNECTORS: DemoConnector[] = [
  {
    slug: 'agent-skills',
    name: 'Agent Skills Finder',
    emoji: '🧩',
    blurb: 'Ready-made skills for your AI — no key.',
    tool: 'skills_search',
    params: { q: 'readme', limit: 5 },
  },
  {
    slug: 'hackernews',
    name: 'Hacker News',
    emoji: '📰',
    blurb: 'Stories and comments — no key.',
    tool: 'hackernews_get_item',
    params: { id: 8863 },
  },
  {
    slug: 'nominatim',
    name: 'Nominatim',
    emoji: '🗺️',
    blurb: 'Geocoding with OpenStreetMap — no key.',
    tool: 'nominatim_search',
    params: { q: 'Brandenburg Gate, Berlin' },
  },
  {
    slug: 'vies-vat',
    name: 'VIES VAT',
    emoji: '🧾',
    blurb: 'EU VAT number checks — no key.',
    tool: 'vies_check_vat',
    params: { countryCode: 'IE', vatNumber: '6388047V' },
  },
  {
    slug: 'openplz',
    name: 'OpenPLZ',
    emoji: '📮',
    blurb: 'German postal codes — no key.',
    tool: 'openplz_lookup_postalcode',
    params: { postalCode: '10115' },
  },
  {
    slug: 'deutsche-bahn',
    name: 'Deutsche Bahn',
    emoji: '🚆',
    blurb: 'Live German train times — no API key.',
    tool: 'db_search_locations',
    params: { query: 'Berlin' },
  },
  {
    slug: 'bundesbank',
    name: 'Bundesbank',
    emoji: '🏦',
    blurb: 'Official EUR exchange rates — no key.',
    tool: 'bundesbank_get_exchange_rates',
    params: { currency: 'USD' },
  },
];

export function findDemoByTool(tool: string): DemoConnector | undefined {
  return DEMO_CONNECTORS.find((d) => d.tool === tool);
}

export function findDemoBySlug(slug: string): DemoConnector | undefined {
  return DEMO_CONNECTORS.find((d) => d.slug === slug);
}
