'use client';

import { useEffect, useState } from 'react';
import { recoveryCodes as api, type RecoveryCodeStatus } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/toast';

/**
 * Break-glass credentials for the signed-in admin.
 *
 * Lives beside the SSO settings rather than under Profile because it exists
 * for one reason: `enforceSso` cannot be switched on without it, and an admin
 * reading about enforcement should find the prerequisite in the same place.
 */
export function RecoveryCodesCard({
  token,
  onChanged,
}: {
  token: string;
  onChanged?: () => void;
}) {
  const toast = useToast();
  const [status, setStatus] = useState<RecoveryCodeStatus | null>(null);
  const [issued, setIssued] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    try {
      setStatus(await api.status(token));
    } catch {
      // Non-fatal: the card degrades to "generate" rather than blocking the
      // whole SSO page on a count.
      setStatus(null);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const handleGenerate = async () => {
    setBusy(true);
    try {
      const { codes } = await api.generate(token);
      setIssued(codes);
      setCopied(false);
      await load();
      onChanged?.();
    } catch (err: any) {
      toast.show({ tone: 'error', title: 'Could not generate codes', description: err.message });
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async () => {
    if (!issued) return;
    await navigator.clipboard.writeText(issued.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    if (!issued) return;
    const body = [
      'AnythingMCP recovery codes',
      `Generated ${new Date().toISOString()}`,
      '',
      'Each code works once. Keep them somewhere you can reach WITHOUT',
      'single sign-on — that is the situation they exist for.',
      '',
      ...issued,
      '',
    ].join('\n');
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'anythingmcp-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(url);
  };

  const none = !status || status.unused === 0;

  return (
    <div className="mt-5 pt-4 border-t border-[var(--border)]">
      <h4 className="text-[13px] font-semibold text-[var(--text)]">Recovery codes</h4>
      <p className="text-[11.5px] text-[var(--text-3)] mt-1 max-w-2xl">
        Single-use codes that sign you in when the identity provider cannot be reached — an
        expired client secret, a tenant migration, a claim that stopped arriving. Requiring
        single sign-on is only possible once you hold some.
      </p>

      {issued ? (
        <div className="mt-3 p-3 rounded-[9px] bg-[var(--surface-2)] space-y-3">
          {/*
            Shown once and never again: the server stores bcrypt hashes, so
            there is nothing to display on a later visit. Saying so here is the
            difference between an admin saving them and an admin closing the
            page.
          */}
          <p className="text-[12px] text-[var(--text)] font-medium">
            Save these now — they cannot be shown again.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-1.5">
            {issued.map((c) => (
              <code
                key={c}
                className="text-[12px] tracking-wide text-[var(--text)] bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-center"
              >
                {c}
              </code>
            ))}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={handleCopy}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button size="sm" variant="secondary" onClick={handleDownload}>
              Download
            </Button>
            <Button size="sm" onClick={() => setIssued(null)}>
              I have saved them
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-3 flex-wrap">
          <Button size="sm" variant={none ? undefined : 'secondary'} onClick={handleGenerate} disabled={busy}>
            {busy ? 'Generating...' : none ? 'Generate recovery codes' : 'Regenerate'}
          </Button>
          <span className="text-[12px] text-[var(--text-3)]">
            {status === null
              ? ''
              : status.total === 0
                ? 'None yet.'
                : `${status.unused} of ${status.total} unused.`}
            {status && status.total > 0 && ' Regenerating invalidates the current set.'}
          </span>
        </div>
      )}
    </div>
  );
}
