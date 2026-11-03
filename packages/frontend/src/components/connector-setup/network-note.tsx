'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/utils';

/**
 * The address(es) this instance calls APIs from (the backend's EGRESS_IPS),
 * for servers and providers that only accept approved IP addresses.
 *
 * `required`: the provider refuses every call from an address it does not
 * know (eMAG, Shopee, Korea Law), so registering it is a setup step. Without
 * configured addresses that step names "the public IP address of the server
 * AnythingMCP runs on". Otherwise a short note, shown only when the addresses
 * are known: most APIs do not care, but a self-hosted ERP behind a firewall
 * answers 403 to everything until it is told.
 */
export function NetworkNote({
  ips,
  name,
  required = false,
  mentionProxy = false,
  className,
}: {
  ips: string[];
  name: string;
  required?: boolean;
  /** The per-tool "Use proxy" option exists here: say it bypasses these addresses. */
  mentionProxy?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!required && ips.length === 0) return null;
  const list = ips.join(', ');
  const one = ips.length === 1;
  const copy = async () => {
    if (await copyText(ips.join('\n'))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <div
      className={cn(
        'rounded-[9px] border p-3 text-sm text-[var(--text-2)]',
        required ? 'border-[var(--border-strong)] bg-[var(--surface-2)]' : 'border-[var(--border)]',
        className,
      )}
    >
      <p className="mb-1 font-medium text-[var(--text)]">{required ? 'Register the IP address' : 'Server only accepts approved IP addresses?'}</p>
      <p className="text-[13px] leading-relaxed">
        {ips.length === 0
          ? `${name} only accepts calls from IP addresses registered with it. Register the public IP address of the server AnythingMCP runs on (your network admin knows it) before you start, or every call is refused.`
          : required
            ? `${name} only accepts calls from IP addresses registered with it. Register ${one ? 'this address' : 'these addresses'} in your ${name} account before you start, or every call is refused.`
            : `AnythingMCP calls the API from ${one ? 'this address' : 'these addresses'}. If the server or account only accepts approved IPs (a firewall, an IP allowlist), add ${one ? 'it' : 'them'} there; otherwise there is nothing to do.`}
      </p>
      {ips.length > 0 && (
        <div className="mt-2 flex items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded bg-[var(--surface)] px-2 py-1 font-mono text-xs text-[var(--text)]">
            {list}
          </code>
          <Button size="sm" variant="secondary" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      )}
      {ips.length > 0 && mentionProxy && <p className="mt-2 text-xs text-[var(--text-3)]">Leave the &quot;Proxy&quot; option off on the tools of a server with an allowlist: proxied calls leave from changing addresses.</p>}
    </div>
  );
}
