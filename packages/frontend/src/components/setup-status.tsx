'use client';

import Link from 'next/link';
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

const COPY: Record<Exclude<ConnectorSetupStatus, 'ready'>, { pill: string; banner: string }> = {
  needs_input: {
    pill: 'Needs setup',
    banner: 'A credential or setting is still empty, so your AI client does not see this connector yet.',
  },
  needs_authorization: {
    pill: 'Needs sign-in',
    banner: 'It has to be authorized with the provider before your AI client can use it.',
  },
};

/** Shown next to "Active" when the connector cannot serve calls yet. */
export function SetupStatusPill({ status }: { status?: ConnectorSetupStatus | null }) {
  if (!status || status === 'ready') return null;
  return (
    <StatusPill tone="warn" dot="var(--warn)">
      {COPY[status].pill}
    </StatusPill>
  );
}

/** On the connector page: what is missing and the way to finish it. */
export function SetupStatusBanner({
  connector,
}: {
  connector: { id: string; setupStatus?: ConnectorSetupStatus | null; missingVariables?: string[]; config?: { adapterSlug?: string } | null };
}) {
  const status = connector.setupStatus;
  if (!status || status === 'ready') return null;
  const missing = connector.missingVariables ?? [];
  const catalog = !!connector.config?.adapterSlug;
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 rounded-[10px] border border-[var(--border)] bg-[var(--t-warn-bg)] p-3 text-sm text-[var(--t-warn-fg)]">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{COPY[status].banner}</p>
        {missing.length > 0 && <p className="mt-0.5 text-xs">Still empty: {missing.join(', ')}</p>}
      </div>
      {catalog && (
        <Link href={finishSetupHref(connector)} className={cn(buttonVariants({ size: 'sm' }))}>
          Finish setup
        </Link>
      )}
    </div>
  );
}
