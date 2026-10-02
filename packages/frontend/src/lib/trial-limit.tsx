import Link from 'next/link';

/**
 * The backend blocks a connector or MCP-server create on a trial with a message
 * that starts "Trial limit reached (…". A bare red toast of that text is a dead
 * end: the user doesn't know a trial is capped, nor that adding a card lifts the
 * cap. Detect it so the UI can offer the way forward instead.
 */
export function isTrialLimitMessage(message?: string | null): boolean {
  return !!message && /trial limit reached/i.test(message);
}

/**
 * Shown in place of a raw trial-cap error: it explains the cap and links to the
 * card-trial offer (which lifts it to the chosen plan) and to the connectors
 * list (where a slot can be freed by removing one).
 */
export function TrialLimitNotice({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-[11px] border px-4 py-3 text-sm"
      style={{
        background: 'var(--t-warn-bg)',
        color: 'var(--t-warn-fg)',
        borderColor: 'color-mix(in srgb, var(--t-warn-fg) 25%, transparent)',
      }}
    >
      <p className="font-medium">{message}</p>
      <p className="mt-1">
        Your free trial includes a limited number of connectors.{' '}
        <Link href="/start-trial" className="font-semibold underline hover:no-underline">
          Add a payment method
        </Link>{' '}
        to unlock your full plan, or{' '}
        <Link href="/connectors" className="font-semibold underline hover:no-underline">
          remove a connector
        </Link>{' '}
        to free a slot.
      </p>
    </div>
  );
}
