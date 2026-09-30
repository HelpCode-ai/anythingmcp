'use client';

import { useState } from 'react';
import Link from 'next/link';
import { license, type EditionState } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { usePricingUrl } from '@/lib/use-pricing-url';
import { notifyEditionChanged } from '@/lib/use-edition';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Inline notice on a page whose setup needs Business, with the ways to get it. */
export function BusinessNotice({
  edition,
  title,
  body,
}: {
  edition: EditionState;
  title: string;
  body: string;
}) {
  const { token } = useAuth();
  const pricingUrl = usePricingUrl();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  const startTrial = async () => {
    if (!token) return;
    setStarting(true);
    setError('');
    try {
      await license.startBusinessTrial(token);
      notifyEditionChanged();
    } catch (err: any) {
      setError(err.message || 'Could not start the trial.');
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="rounded-[12px] border border-[var(--brand)] bg-[var(--brand-tint)] p-4">
      <h3 className="text-sm font-semibold text-[var(--text)]">{title}</h3>
      <p className="text-[13px] text-[var(--text-2)] mt-1 max-w-2xl">{body}</p>
      {error && <p className="text-[13px] text-[var(--danger)] mt-2">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {edition.trialAvailable ? (
          <Button size="sm" onClick={startTrial} disabled={starting}>
            {starting ? 'Starting…' : `Try Business free for ${edition.trialDays} days`}
          </Button>
        ) : (
          <a
            href={pricingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonVariants({ size: 'sm' }))}
          >
            View plans
          </a>
        )}
        <Link href="/settings/license" className="text-[13px] text-[var(--brand)] hover:underline">
          Enter a license key
        </Link>
      </div>
    </div>
  );
}
