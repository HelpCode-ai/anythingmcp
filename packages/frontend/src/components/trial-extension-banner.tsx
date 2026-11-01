'use client';

import { useEffect, useState } from 'react';
import { trialExtensionNotice, type TrialExtensionNotice } from '@/lib/trial-extension';

/**
 * Cloud: the result of the one-click trial extension from the "your trial has
 * ended" email, shown once on the dashboard. The query parameters are taken
 * out of the address bar so a reload does not show it again.
 */
export function TrialExtensionBanner() {
  const [notice, setNotice] = useState<TrialExtensionNotice | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const found = trialExtensionNotice(url.searchParams.get('trial_extended'), url.searchParams.get('until'));
    if (!url.searchParams.has('trial_extended')) return;
    url.searchParams.delete('trial_extended');
    url.searchParams.delete('until');
    window.history.replaceState(window.history.state, '', url.toString());
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNotice(found);
  }, []);

  if (!notice) return null;
  const tone =
    notice.tone === 'success'
      ? 'border-[var(--ok)]/30 bg-[var(--t-success-bg)] text-[var(--t-success-fg)]'
      : notice.tone === 'error'
        ? 'border-[var(--danger)]/30 bg-[var(--t-danger-bg)] text-[var(--t-danger-fg)]'
        : 'border-[var(--brand)]/30 bg-[var(--brand-tint)]';
  return (
    <div role="status" className={`flex items-start justify-between gap-3 rounded-[14px] border px-5 py-3 text-sm ${tone}`}>
      <span>{notice.text}</span>
      <button
        type="button"
        onClick={() => setNotice(null)}
        className="shrink-0 text-xs text-[var(--text-2)] hover:underline"
        aria-label="Dismiss"
      >
        Dismiss
      </button>
    </div>
  );
}
