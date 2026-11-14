/**
 * The outcome of the one-click trial extension (backend
 * trial-extension.controller.ts), which redirects to the dashboard with
 * `?trial_extended=<outcome>` and, on success, `&until=<ISO date>`.
 */
export type TrialExtensionNotice = { tone: 'success' | 'info' | 'error'; text: string };

const REFUSALS: Record<string, TrialExtensionNotice> = {
  already_extended: { tone: 'info', text: 'Your trial was already extended once. To keep going, choose a plan in Settings, License.' },
  too_late: { tone: 'info', text: 'The extension is offered for 7 days after the trial ends, and that time has passed. Choose a plan in Settings, License to continue.' },
  expired: { tone: 'info', text: 'This extension link has expired. Choose a plan in Settings, License to continue.' },
  not_trial: { tone: 'info', text: 'This workspace is not on a trial, so there is nothing to extend.' },
  not_found: { tone: 'error', text: 'We could not find a trial for this workspace. Reply to the email and we will sort it out.' },
  revoked: { tone: 'error', text: 'This trial can no longer be extended. Reply to the email and we will sort it out.' },
  invalid_key: { tone: 'error', text: 'We could not find a trial for this workspace. Reply to the email and we will sort it out.' },
  invalid: { tone: 'error', text: 'This extension link does not work. It may have been shortened or changed on its way here.' },
  unavailable: { tone: 'error', text: 'We could not extend your trial right now. Please try the link again in a few minutes.' },
};

/** The banner for a `trial_extended` outcome, or null when there is none to show. */
export function trialExtensionNotice(outcome: string | null, until: string | null): TrialExtensionNotice | null {
  if (!outcome) return null;
  if (outcome === 'ok') {
    const date = until ? new Date(until) : null;
    const when =
      date && !Number.isNaN(date.getTime())
        ? date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
        : null;
    return { tone: 'success', text: when ? `Your trial is extended until ${when}.` : 'Your trial is extended by 7 days.' };
  }
  return REFUSALS[outcome] ?? null;
}
