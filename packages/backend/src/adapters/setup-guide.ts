import type { AdapterDefinition } from './catalog';
import { setupKind } from './env-var-meta';

/**
 * A step-by-step setup for one adapter, written by hand for the connectors
 * people struggle with (Etsy: an app of their own, a callback URL, two keys).
 * The setup page shows it one step at a time instead of the form and the long
 * instructions. Optional: an adapter without one keeps the plain form.
 *
 * Not part of the catalog fingerprint: rewording a guide changes nothing in an
 * installed connector. Checked by scripts/validate-adapters.mjs.
 */
export interface SetupGuide {
  /** What the setup asks of the user, for the badge and the intro. */
  effort: SetupEffortKind;
  /** About how long it takes, in minutes. */
  minutes: number;
  /** Things to ask the AI once it works: on the intro and the success screen. */
  examples?: string[];
  /** What to have ready, one short line each (Markdown). */
  needs?: string[];
  /** Why the setup is the way it is ("Why do I need an Etsy app?"), Markdown. */
  why?: string;
  steps: SetupGuideStep[];
}

export interface SetupGuideStep {
  /** Stable, kebab-case: reported in the step events, keys the saved progress. */
  id: string;
  title: string;
  /** Markdown. */
  body?: string;
  /** The provider page this step happens on; opened in a new tab. */
  action?: { label: string; url: string };
  /**
   * What to type or pick on the provider's page, in its order. `value` may use
   * {{redirectUri}} (this instance's OAuth callback URL). A `pick` is an option
   * to select there, shown without a copy button.
   */
  values?: Array<{ label: string; value: string; note?: string; pick?: boolean }>;
  /** A screenshot under packages/frontend/public. Only real ones: no mock-ups. */
  image?: { src: string; alt: string; capturedAt: string };
  /** The adapter variables entered in this step, in display order. */
  fields?: string[];
  /** "Common problems", collapsed. Markdown answers. */
  problems?: Array<{ q: string; a: string }>;
  /** A checkbox to tick before Continue, for a step done on the provider's side. */
  confirm?: string;
}

export type SetupEffortKind = 'none' | 'one_click' | 'api_key' | 'own_app' | 'admin_needed';

/** The marketplace badge: what a setup takes, without opening it. */
export interface SetupEffort {
  effort: SetupEffortKind;
  minutes: number;
}

/**
 * The guide's own estimate, or one derived from how the adapter signs in:
 * nothing to enter, a sign-in only (the vendor's MCP registers itself), an
 * app of the user's own at the provider, or values to paste.
 */
export function setupEffort(
  adapter: Pick<AdapterDefinition, 'connector' | 'requiredEnvVars'> & { setupGuide?: SetupGuide },
): SetupEffort {
  if (adapter.setupGuide) return { effort: adapter.setupGuide.effort, minutes: adapter.setupGuide.minutes };
  const kind = setupKind(adapter);
  if (kind === 'none') return { effort: 'none', minutes: 0 };
  if (kind === 'oauth_browser') {
    return adapter.requiredEnvVars.length === 0 ? { effort: 'one_click', minutes: 1 } : { effort: 'own_app', minutes: 10 };
  }
  return { effort: 'api_key', minutes: 3 };
}
