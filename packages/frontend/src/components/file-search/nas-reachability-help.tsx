'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Cloud only: why AnythingMCP Cloud cannot open a NAS inside the user's
 * network, and the ways to make it reachable. Shown in the File Search
 * wizard when the address is private (192.168.x.x, nas.local), a Synology
 * QuickConnect link, or when the connection test could not reach the server.
 *
 * Most File Search sign-ups from the ChatGPT plugin pick the Synology preset
 * and enter the NAS's LAN address; without this they stop at a one-line
 * error (2026-11-19: 11 of 11 never saved a folder).
 */
export type NasReachabilityReason = 'private' | 'quickconnect' | 'unreachable';

export function NasReachabilityHelp({
  reason,
  ips,
  onUseWebdav,
  className,
}: {
  reason: NasReachabilityReason;
  /** The addresses Cloud connects from (EGRESS_IPS), for the NAS firewall. */
  ips: string[];
  /** Offered when the form is not on WebDAV yet: the way that works with a tunnel too. */
  onUseWebdav?: () => void;
  className?: string;
}) {
  const t = useTranslations('fileSearch.reach');
  return (
    <div
      role="note"
      data-testid="nas-reachability-help"
      className={cn('rounded-[12px] border border-[var(--warning-border)] bg-[var(--warning-bg)] p-4 text-[13px] leading-[1.55] text-[var(--text)]', className)}
    >
      <div className="text-[13.5px] font-semibold">{t(`title.${reason}`)}</div>
      <p className="mt-1 text-[var(--text-2)]">{t(`intro.${reason}`)}</p>
      <ol className="mt-3 list-decimal space-y-2.5 pl-5">
        <li>
          <span className="font-medium">{t('synology.title')}</span>
          <span className="block text-[var(--text-2)]">{t('synology.steps')}</span>
        </li>
        <li>
          <span className="font-medium">{t('tunnel.title')}</span>
          <span className="block text-[var(--text-2)]">{t('tunnel.steps')}</span>
        </li>
        <li>
          <span className="font-medium">{t('other.title')}</span>
          <span className="block text-[var(--text-2)]">{t('other.steps')}</span>
        </li>
      </ol>
      {ips.length > 0 && (
        <p className="mt-3 text-[var(--text-2)]">
          {t('firewall', { count: ips.length })}{' '}
          <code className="break-all rounded-[6px] bg-[var(--surface)] px-1.5 py-0.5 font-mono text-[12px] text-[var(--text)]">{ips.join(', ')}</code>
        </p>
      )}
      <p className="mt-2 text-[var(--text-3)]">{t('selfHosted')}</p>
      {onUseWebdav && (
        <Button variant="secondary" className="mt-3 w-full sm:w-auto" onClick={onUseWebdav}>
          {t('useWebdav')}
        </Button>
      )}
    </div>
  );
}
