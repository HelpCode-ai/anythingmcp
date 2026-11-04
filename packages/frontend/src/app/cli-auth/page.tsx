'use client';

import { Suspense, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { mcpKeys, type McpApiKeyScope } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { LanguageSwitcher } from '@/components/language-switcher';

/**
 * CLI authorization consent (`amcp login --browser`). The CLI opens this page
 * with a loopback `callback`, a `state`, a verification `code` and the
 * requested `scope`. Under the user's existing dashboard session this page
 * mints a management key with the ordinary POST /api/mcp-keys and hands it back
 * to the CLI by POSTing a form to the loopback callback — so the key is never
 * placed in a URL. It changes no existing auth: if the user is not signed in,
 * the global AuthProvider sends them through the normal /login flow and back.
 */
const SCOPES: McpApiKeyScope[] = ['MANAGEMENT_READ', 'MANAGEMENT_ADMIN'];

/** Only ever hand the key to a loopback address on the user's own machine. */
function isLoopbackCallback(raw: string | null): raw is string {
  if (!raw) return false;
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== 'http:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return (host === '127.0.0.1' || host === 'localhost' || host === '::1') && !!url.port;
}

function CliAuthInner() {
  const t = useTranslations('cliAuth');
  const { token, user } = useAuth();
  const params = useSearchParams();

  const callback = params.get('callback');
  const state = params.get('state');
  const code = params.get('code') ?? '';
  const label = params.get('label') ?? 'amcp CLI';
  const scope = (params.get('scope') ?? 'MANAGEMENT_READ') as McpApiKeyScope;

  const [status, setStatus] = useState<'idle' | 'working' | 'done'>('idle');
  const [error, setError] = useState('');

  const problem = useMemo(() => {
    if (!isLoopbackCallback(callback) || !state) return t('invalid');
    if (!SCOPES.includes(scope)) return t('invalid');
    if (scope === 'MANAGEMENT_ADMIN' && user?.role !== 'ADMIN') return t('needAdmin');
    return '';
  }, [callback, state, scope, user?.role, t]);

  // Deliver a field map to the loopback callback as a cross-origin form POST so
  // nothing sensitive rides in a URL. This navigates to the CLI's own page.
  const postToCallback = (fields: Record<string, string>) => {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = callback as string;
    for (const [name, value] of Object.entries(fields)) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
  };

  const authorize = async () => {
    if (!token || problem) return;
    setStatus('working');
    setError('');
    try {
      const result = await mcpKeys.generate(label, token, undefined, scope);
      setStatus('done');
      postToCallback({ state: state as string, key: result.key });
    } catch (err: any) {
      setStatus('idle');
      setError(err?.message || t('error'));
    }
  };

  const cancel = () => {
    if (!callback || !state) return;
    postToCallback({ state, error: 'access_denied' });
  };

  const scopeLabel = scope === 'MANAGEMENT_ADMIN' ? t('scopeAdmin') : t('scopeRead');

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4 py-10">
      <div className="flex justify-end"><LanguageSwitcher /></div>
      <Card className="p-6 space-y-5">
        <div className="space-y-1">
          <h1 className="text-base font-semibold text-[var(--text)]">{t('title')}</h1>
          <p className="text-sm text-[var(--text-2)]">{t('intro', { label })}</p>
        </div>

        {!token ? (
          <p className="text-sm text-[var(--text-3)]">{t('signInFirst')}</p>
        ) : problem ? (
          <p className="text-sm text-[var(--danger)]">{problem}</p>
        ) : (
          <>
            <dl className="space-y-3 rounded-[10px] border border-[var(--border)] bg-[var(--surface-2)] p-4 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-[var(--text-3)]">{t('scope')}</dt>
                <dd className="font-medium text-[var(--text)]">{scopeLabel}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-[var(--text-3)]">{t('code')}</dt>
                <dd className="font-mono text-base tracking-widest text-[var(--text)]">{code || '—'}</dd>
              </div>
            </dl>
            <p className="text-xs text-[var(--text-3)]">{t('verifyHint')}</p>
            {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
            <div className="flex gap-2">
              <Button onClick={authorize} disabled={status !== 'idle'}>
                {status === 'idle' ? t('authorize') : t('working')}
              </Button>
              <Button variant="secondary" onClick={cancel} disabled={status === 'working'}>
                {t('cancel')}
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

export default function CliAuthPage() {
  return (
    <main className="min-h-dvh bg-[var(--bg)]">
      <Suspense>
        <CliAuthInner />
      </Suspense>
    </main>
  );
}
