'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { StatusPill } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ConnectorSetupStatus } from '@/lib/api';

/** Where a connector that is not set up gets finished. */
export function finishSetupHref(connector: { id: string; config?: { adapterSlug?: string } | null }): string {
  const slug = connector.config?.adapterSlug;
  return slug
    ? `/connectors/setup/${encodeURIComponent(slug)}?connector=${encodeURIComponent(connector.id)}`
    : `/connectors/${encodeURIComponent(connector.id)}`;
}

/** Message keys in the `setupStatus` namespace, by status. */
const KEYS: Record<Exclude<ConnectorSetupStatus, 'ready'>, 'needsInput' | 'needsAuthorization'> = {
  needs_input: 'needsInput',
  needs_authorization: 'needsAuthorization',
};

/** Shown next to "Active" when the connector cannot serve calls yet. */
export function SetupStatusPill({ status }: { status?: ConnectorSetupStatus | null }) {
  const t = useTranslations('setupStatus');
  if (!status || status === 'ready') return null;
  return (
    <StatusPill tone="warn" dot="var(--warn)">
      {t(`${KEYS[status]}.pill`)}
    </StatusPill>
  );
}

/** On the connector page: what is missing and the way to finish it. */
export function SetupStatusBanner({
  connector,
}: {
  connector: { id: string; setupStatus?: ConnectorSetupStatus | null; missingVariables?: string[]; config?: { adapterSlug?: string } | null };
}) {
  const t = useTranslations('setupStatus');
  const status = connector.setupStatus;
  if (!status || status === 'ready') return null;
  const missing = connector.missingVariables ?? [];
  const catalog = !!connector.config?.adapterSlug;
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 rounded-[10px] border border-[var(--border)] bg-[var(--t-warn-bg)] p-3 text-sm text-[var(--t-warn-fg)]">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t(`${KEYS[status]}.banner`)}</p>
        {missing.length > 0 && <p className="mt-0.5 text-xs">{t('stillEmpty', { names: missing.join(', ') })}</p>}
      </div>
      {catalog && (
        <Link href={finishSetupHref(connector)} className={cn(buttonVariants({ size: 'sm' }))}>
          {t('finishSetup')}
        </Link>
      )}
    </div>
  );
}
