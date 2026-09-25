/**
 * The starter pack a new workspace is offered on /welcome.
 *
 * A workspace used to start empty, and most stay that way: on the cloud only
 * a third of workspaces ever add a connector. Installing these for everyone
 * would not fix that and would cost memory, because every connector's tools
 * live in the in-memory registry. So the pack is offered, not installed: a
 * few connectors that need no key, ticked by default, added in one click.
 *
 * Membership is chosen from production data: each one installs with no input
 * at all and answered its calls reliably over the previous 30 days. An entry
 * whose adapter is missing, hidden on this deployment (self-host only on the
 * cloud) or still needs a value from the user is left out when the pack is
 * served, so the list below can stay the same for cloud and self-host.
 */
export interface StarterPackEntry {
  slug: string;
  /** Ticked when the pack is shown. */
  preselected: boolean;
  /** One line on what it does for the user, shown on the card. */
  pitch: string;
}

export const STARTER_PACK: readonly StarterPackEntry[] = [
  {
    slug: 'agent-skills',
    preselected: true,
    pitch:
      'Find a ready-made skill for a task, like a README or release notes, and have your AI follow it.',
  },
  {
    slug: 'hackernews',
    preselected: true,
    pitch: 'Top, new and Ask HN stories with their comments, for tech news and research.',
  },
  {
    slug: 'nominatim',
    preselected: true,
    pitch: 'Turn addresses into coordinates and back, worldwide, with OpenStreetMap.',
  },
  {
    slug: 'vies-vat',
    preselected: false,
    pitch: 'Check that an EU VAT number is valid and see the company it belongs to.',
  },
  {
    slug: 'deutsche-bahn',
    preselected: false,
    pitch: 'Live departures, arrivals and journeys for trains in Germany.',
  },
  {
    slug: 'openplz',
    preselected: false,
    pitch: 'German postal codes, towns and streets, for checking addresses.',
  },
];

/** Upper bound on one install request; the pack itself is smaller. */
export const STARTER_PACK_MAX_INSTALL = 10;
