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

export const DEMO_CONNECTORS: DemoConnector[] = [
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
