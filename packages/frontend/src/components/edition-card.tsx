'use client';

import { useState } from 'react';
import { license, type EditionState } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { usePricingUrl } from '@/lib/use-pricing-url';
import { notifyEditionChanged, daysUntil, formatDay } from '@/lib/use-edition';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export const BUSINESS_CAPABILITIES = [
  'Single sign-on with Entra ID, Google, Okta or any OIDC provider',
  'SCIM provisioning and role sync from directory groups',
  'Require single sign-on for the whole workspace',
];

/** Self-hosted: which edition runs, its users, and the way to Business. */
export function EditionCard({ edition, onChange }: { edition: EditionState; onChange?: () => void }) {
  const { token } = useAuth();
  const pricingUrl = usePricingUrl();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  const startTrial = async () => {
    if (!token) return;
    setError('');
    setStarting(true);
    try {
      await license.startBusinessTrial(token);
      notifyEditionChanged();
      onChange?.();
    } catch (err: any) {
      setError(err.message || 'Could not start the trial.');
    } finally {
      setStarting(false);
    }
  };

  const source =
    edition.source === 'license'
      ? `License (${edition.plan})`
      : edition.source === 'trial' && edition.trialEndsAt
        ? `Trial, ${daysUntil(edition.trialEndsAt)} days left`
        : edition.source === 'transition' && edition.transitionUntil
          ? `Until ${formatDay(edition.transitionUntil)}`
          : null;

  const users =
    edition.seatLimit === null
      ? `${edition.seatsUsed} active user${edition.seatsUsed === 1 ? '' : 's'}`
      : edition.seatsUsed <= edition.seatLimit
        ? `${edition.seatsUsed} of ${edition.seatLimit} active users`
        : `${edition.seatsUsed} active users, ${edition.seatLimit} included`;

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <h2 className="text-sm font-semibold text-[var(--text)] capitalize">{edition.edition}</h2>
        {source && <Badge tone={edition.source === 'license' ? 'success' : 'info'}>{source}</Badge>}
      </div>
      <p className="text-sm text-[var(--text-2)]">
        {users}
        {edition.edition === 'community' && ` · Community includes up to ${edition.communitySeatLimit} users.`}
      </p>

      <div className="mt-4">
        <div className="text-xs font-medium text-[var(--text-3)] mb-2">
          {edition.business ? 'Included' : 'With Business'}
        </div>
        <ul className="space-y-1.5 text-sm text-[var(--text-2)]">
          <li className="flex gap-2">
            <span aria-hidden className={edition.business ? 'text-[var(--ok)]' : 'text-[var(--text-3)]'}>
              {edition.business ? '✓' : '+'}
            </span>
            More than {edition.communitySeatLimit} users
          </li>
          {BUSINESS_CAPABILITIES.map((c) => (
            <li key={c} className="flex gap-2">
              <span aria-hidden className={edition.business ? 'text-[var(--ok)]' : 'text-[var(--text-3)]'}>
                {edition.business ? '✓' : '+'}
              </span>
              {c}
            </li>
          ))}
        </ul>
      </div>

      {edition.source === 'transition' && (
        <p className="mt-4 text-sm text-[var(--text-2)]">
          This instance was already using these, so they stay available until{' '}
          {formatDay(edition.transitionUntil!)}. Activate a license key to keep them after that. Users and
          sign-ins that exist today keep working either way.
        </p>
      )}
      {edition.source === 'trial' && (
        <p className="mt-4 text-sm text-[var(--text-2)]">
          When the trial ends nothing is deleted and nobody is signed out: existing users and single sign-on
          identities keep working, and adding users or changing the single sign-on setup needs a license key.
        </p>
      )}

      {error && <p className="mt-3 text-sm text-[var(--danger)]">{error}</p>}

      {!(edition.source === 'license' && edition.business) && (
        <div className="mt-4 pt-4 border-t border-[var(--border)] flex flex-wrap gap-3">
          {edition.trialAvailable && (
            <Button onClick={startTrial} disabled={starting}>
              {starting ? 'Starting…' : `Try Business free for ${edition.trialDays} days`}
            </Button>
          )}
          <a
            href={pricingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonVariants({ variant: edition.trialAvailable ? 'secondary' : 'primary' }))}
          >
            View plans
          </a>
        </div>
      )}
      {edition.trialAvailable && (
        <p className="mt-2 text-xs text-[var(--text-3)]">No payment details, no email: the trial runs on this instance.</p>
      )}
    </Card>
  );
}
