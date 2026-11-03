'use client';

import { useState } from 'react';
import { license, type EditionState } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { buildEnterpriseContactUrl } from '@/lib/marketing';
import { notifyEditionChanged, daysUntil, formatDay } from '@/lib/use-edition';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export const ENTERPRISE_CAPABILITIES = [
  'Single sign-on with Entra ID, Google, Okta or any OIDC provider',
  'SCIM provisioning and role sync from directory groups',
  'Require single sign-on for the whole workspace',
];

/**
 * Listed only as what Enterprise adds, never as what a running trial includes.
 * Starter and Team keys already include File Search, so only Community sees it.
 */
function enterpriseExtras(edition: EditionState): string[] {
  if (edition.business) return [];
  return [
    ...(edition.edition === 'community' ? ['File Search after the 30-day trial'] : []),
    'Support with a service level agreement',
  ];
}

/**
 * The name shown for an edition. The licensing layer still calls the trial and
 * the transition period `business` (as it does a Business key someone already
 * holds); the trial is offered as an Enterprise trial, and a transition keeps
 * what was in use on top of Community.
 */
function editionLabel(edition: EditionState): string {
  if (edition.source === 'trial') return 'Enterprise';
  if (edition.source === 'transition') return 'Community';
  return edition.edition.charAt(0).toUpperCase() + edition.edition.slice(1);
}

/**
 * Self-hosted: which edition runs, its users, and the ways to more. Self-hosted
 * is sold as Community (free) and Enterprise (on request); Starter and Team are
 * no longer sold, but an instance with such a key still shows it here.
 */
export function EditionCard({ edition, onChange }: { edition: EditionState; onChange?: () => void }) {
  const { token } = useAuth();
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
        <h2 className="text-sm font-semibold text-[var(--text)]">{editionLabel(edition)}</h2>
        {source && <Badge tone={edition.source === 'license' ? 'success' : 'info'}>{source}</Badge>}
      </div>
      <p className="text-sm text-[var(--text-2)]">
        {users}
        {edition.edition === 'community' &&
          ` · Community is free for any use, including commercial use, for up to ${edition.communitySeatLimit} active users.`}
      </p>

      <div className="mt-4">
        <div className="text-xs font-medium text-[var(--text-3)] mb-2">
          {edition.business ? 'Included' : 'With Enterprise'}
        </div>
        <ul className="space-y-1.5 text-sm text-[var(--text-2)]">
          <li className="flex gap-2">
            <span aria-hidden className={edition.business ? 'text-[var(--ok)]' : 'text-[var(--text-3)]'}>
              {edition.business ? '✓' : '+'}
            </span>
            More than {edition.communitySeatLimit} users
          </li>
          {ENTERPRISE_CAPABILITIES.map((c) => (
            <li key={c} className="flex gap-2">
              <span aria-hidden className={edition.business ? 'text-[var(--ok)]' : 'text-[var(--text-3)]'}>
                {edition.business ? '✓' : '+'}
              </span>
              {c}
            </li>
          ))}
          {enterpriseExtras(edition).map((c) => (
            <li key={c} className="flex gap-2">
              <span aria-hidden className="text-[var(--text-3)]">+</span>
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
              {starting ? 'Starting…' : `Try Enterprise free for ${edition.trialDays} days`}
            </Button>
          )}
          <a
            href={buildEnterpriseContactUrl()}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonVariants({ variant: edition.trialAvailable ? 'secondary' : 'primary' }))}
          >
            Contact us about Enterprise
          </a>
        </div>
      )}
      {edition.trialAvailable && (
        <p className="mt-2 text-xs text-[var(--text-3)]">No payment details, no email: the trial runs on this instance.</p>
      )}
    </Card>
  );
}
