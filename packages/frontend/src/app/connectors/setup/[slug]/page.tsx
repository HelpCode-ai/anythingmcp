'use client';

import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAuth } from '@/lib/auth-context';
import {
  adapters,
  connectors,
  productEvents,
  type AdapterSetupInfo,
  type EnvVarDescriptor,
  type VerifyResult,
} from '@/lib/api';
import { AppShell } from '@/components/app-shell';
import { Card } from '@/components/ui/card';
import { Button, buttonVariants } from '@/components/ui/button';
import { ConnectorLogo } from '@/components/connector-logo';
import { isTrialLimitMessage, TrialLimitNotice } from '@/lib/trial-limit';
import { cn } from '@/lib/utils';

/**
 * Guided setup of a catalog connector, in one place: what to enter (grouped,
 * with where to find each value), a check against the API before anything is
 * saved, the sign-in at the provider for OAuth connectors, and a real result
 * at the end. Replaces the install dialog whose "Skip for now" produced
 * connectors that failed every call.
 *
 * Query:
 *   connector=<id>  finish a connector that already exists (a draft, or one
 *                   installed from a chat), instead of installing a new one
 *   step=done       back from the provider's sign-in
 *   from=claude     show "Back to Claude" at the end
 */

type Phase = 'form' | 'working' | 'done';

const GROUPS: Array<{ kind: EnvVarDescriptor['kind']; title: string }> = [
  { kind: 'address', title: 'Where it is' },
  { kind: 'credential', title: 'Credentials' },
  { kind: 'setting', title: 'Settings' },
];

function SetupContent() {
  const { slug } = useParams<{ slug: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const { token } = useAuth();
  const existingId = params.get('connector');
  const fromClaude = params.get('from') === 'claude';
  const backFromProvider = params.get('step') === 'done';

  const [info, setInfo] = useState<AdapterSetupInfo | null>(null);
  const [loadError, setLoadError] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<Phase>(backFromProvider ? 'working' : 'form');
  const [error, setError] = useState('');
  const [verifyFailed, setVerifyFailed] = useState<VerifyResult | null>(null);
  const [result, setResult] = useState<{ connectorId: string; sample?: string; status?: string } | null>(null);
  const [redirectUri, setRedirectUri] = useState<string | null>(null);
  /** Secrets the existing connector already holds: shown as set, may stay empty. */
  const [storedSecrets, setStoredSecrets] = useState<string[]>([]);
  const started = useRef(false);

  useEffect(() => {
    if (!token || !slug) return;
    adapters
      .describe(slug, token)
      .then((d) => {
        setInfo(d);
        if (!started.current) {
          started.current = true;
          productEvents.track('setup_started', token, { adapterSlug: slug, kind: d.setupKind, existing: !!existingId });
        }
      })
      .catch((e: Error) => setLoadError(e.message || 'This connector is not available.'));
    if (existingId) {
      // Pre-fill what is stored and not secret (secrets come back empty).
      connectors
        .get(existingId, token)
        .then((c) => {
          const env = (c?.envVars ?? {}) as Record<string, string>;
          setValues((v) => ({ ...Object.fromEntries(Object.entries(env).filter(([, x]) => x)), ...v }));
          setStoredSecrets(Array.isArray(c?.maskedEnvVars) ? c.maskedEnvVars : []);
        })
        .catch(() => {});
    }
  }, [token, slug, existingId]);

  useEffect(() => {
    if (!token || info?.setupKind !== 'oauth_browser') return;
    connectors.oauthRedirectUri(token).then((r) => setRedirectUri(r.redirectUri)).catch(() => {});
  }, [token, info?.setupKind]);

  // Back from the provider: the authorization is stored; show the outcome.
  useEffect(() => {
    if (!backFromProvider || !existingId || !token) return;
    connectors
      .get(existingId, token)
      .then(async (c) => {
        if (c?.setupStatus === 'ready') {
          const test = await connectors.test(existingId, token).catch(() => null);
          setResult({ connectorId: existingId, status: (test as any)?.message });
          setPhase('done');
          productEvents.track('setup_completed', token, { adapterSlug: slug, kind: 'oauth_browser' });
        } else {
          setError('The authorization did not complete. Try again.');
          setPhase('form');
        }
      })
      .catch((e: Error) => {
        setError(e.message);
        setPhase('form');
      });
  }, [backFromProvider, existingId, token, slug]);

  const fields = useMemo(() => info?.envVars ?? [], [info]);
  const visibleFields = fields.filter((f) => !f.advanced);
  const advancedFields = fields.filter((f) => f.advanced);

  /**
   * What to send. A new install leaves out required fields that are empty (an
   * optional one goes as '' so its placeholder resolves). An existing
   * connector gets every field: one left empty keeps its stored value, and a
   * name left out would delete it.
   */
  const credentials = () =>
    Object.fromEntries(
      fields
        .map((f) => [f.name, (values[f.name] ?? '').trim()] as const)
        .filter(([name, v]) => existingId || v !== '' || !fields.find((f) => f.name === name)?.required),
    ) as Record<string, string>;

  /** Client-side checks: required fields and patterns. */
  const validate = (): boolean => {
    const errs: Record<string, string> = {};
    for (const f of fields) {
      const v = (values[f.name] ?? '').trim();
      if (f.required && !f.advanced && !v && !storedSecrets.includes(f.name)) errs[f.name] = 'Required';
      else if (v && f.pattern) {
        try {
          if (!new RegExp(f.pattern).test(v)) errs[f.name] = f.example ? `Looks wrong. Example: ${f.example}` : 'Looks wrong';
        } catch {
          /* a broken pattern never blocks the form */
        }
      }
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  };

  /** Create the connector, or store the values on the existing one. Returns its id. */
  const save = async (): Promise<string> => {
    const creds = credentials();
    if (existingId) {
      await connectors.updateEnvVars(existingId, creds, token!);
      return existingId;
    }
    const out = await adapters.import(slug, token!, creds);
    return out.connectorId;
  };

  const fail = (e: any) => {
    setPhase('form');
    setError(e?.message || 'Something went wrong.');
  };

  const verifyAndSave = async () => {
    if (!token || !info || !validate()) return;
    setError('');
    setVerifyFailed(null);
    setPhase('working');
    try {
      if (info.setupKind === 'oauth_browser') {
        const id = await save();
        const returnTo = `/connectors/setup/${slug}?connector=${id}&step=done${fromClaude ? '&from=claude' : ''}`;
        const auth = await connectors.oauthAuthorize(id, token, returnTo);
        if (!auth.authorizationUrl) throw new Error(auth.error || 'Could not start the authorization.');
        productEvents.track('oauth_started', token, { adapterSlug: slug });
        window.location.href = auth.authorizationUrl;
        return;
      }
      const check =
        info.setupKind === 'none' ? null : await adapters.verify(slug, token, credentials(), existingId ?? undefined);
      if (check && check.ok === false) {
        productEvents.track('setup_verify_failed', token, { adapterSlug: slug, kind: check.kind });
        if (check.missing?.length) {
          setFieldErrors(Object.fromEntries(check.missing.map((m) => [m, 'Required'])));
        }
        setVerifyFailed(check);
        setPhase('form');
        return;
      }
      const id = await save();
      setResult({ connectorId: id, sample: check && check.ok ? check.sample : undefined });
      setPhase('done');
      productEvents.track('setup_completed', token, { adapterSlug: slug, kind: info.setupKind });
    } catch (e) {
      fail(e);
    }
  };

  /** Keep what was entered without checking it; the connector stays hidden from MCP until complete. */
  const saveAnyway = async (draft: boolean) => {
    if (!token) return;
    setError('');
    setPhase('working');
    try {
      const id = await save();
      productEvents.track(draft ? 'setup_saved_draft' : 'setup_saved_unverified', token, { adapterSlug: slug });
      router.push(`/connectors/${id}`);
    } catch (e) {
      fail(e);
    }
  };

  if (loadError) {
    return (
      <Card className="p-6">
        <p role="alert" className="text-sm text-[var(--text-2)]">{loadError}</p>
        <Link href="/connectors/store" className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'mt-4')}>
          Back to the marketplace
        </Link>
      </Card>
    );
  }
  if (!info) return <p className="text-sm text-[var(--text-2)]">Loading…</p>;

  if (phase === 'done' && result) {
    return (
      <Card className="space-y-4 p-6">
        <div className="flex items-center gap-3">
          <ConnectorLogo icon={info.icon} name={info.name} />
          <div>
            <h1 className="text-lg font-semibold text-[var(--text)]">{info.name} is ready</h1>
            <p className="text-sm text-[var(--text-2)]">Your AI client can use it now. Ask it something about {info.name}.</p>
          </div>
        </div>
        {result.sample && (
          <div>
            <p className="mb-1 text-xs font-medium text-[var(--text-3)]">What the API answered</p>
            <pre className="max-h-48 overflow-auto rounded-[9px] bg-[var(--surface-2)] p-3 text-xs text-[var(--text)]">{result.sample}</pre>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {fromClaude && (
            <a href="https://claude.ai/new" className={cn(buttonVariants({ size: 'sm' }))}>
              Back to Claude
            </a>
          )}
          <Link href={`/connectors/${result.connectorId}`} className={cn(buttonVariants({ variant: fromClaude ? 'secondary' : 'primary', size: 'sm' }))}>
            Open the connector
          </Link>
          <Link href="/connectors/store" className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}>
            Add another
          </Link>
        </div>
      </Card>
    );
  }

  const working = phase === 'working';
  const isOAuth = info.setupKind === 'oauth_browser';
  const primaryLabel =
    info.setupKind === 'none'
      ? `Install ${info.name}`
      : isOAuth
        ? `Save and sign in to ${info.name.split(' ')[0]}`
        : existingId
          ? 'Check and save'
          : 'Check and install';

  const renderField = (f: EnvVarDescriptor) => {
    const id = `field-${f.name}`;
    const show = revealed[f.name] === true;
    return (
      <div key={f.name}>
        <label htmlFor={id} className="mb-1 block text-sm font-medium text-[var(--text)]">
          {f.label}
          {!f.required && <span className="ml-1 font-normal text-[var(--text-3)]">(optional)</span>}
        </label>
        <div className="relative">
          <input
            id={id}
            // API credentials, never the person's own login: a non-login name
            // and the password managers' opt-outs stop a browser from filling
            // the signed-in user's e-mail and password in here.
            name={`amcp-connector-var-${f.name}`}
            type={f.secret && !show ? 'password' : 'text'}
            autoComplete={f.secret ? 'new-password' : 'off'}
            data-1p-ignore
            data-lpignore="true"
            data-bwignore="true"
            data-form-type="other"
            spellCheck={false}
            value={values[f.name] ?? ''}
            placeholder={storedSecrets.includes(f.name) ? 'Stored. Leave empty to keep it' : (f.example ?? '')}
            onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
            aria-invalid={!!fieldErrors[f.name]}
            className={cn(
              'w-full rounded-[9px] border bg-[var(--surface)] px-3 py-2 text-[16px] text-[var(--text)] placeholder:text-[var(--text-3)] focus:outline-none sm:text-sm',
              fieldErrors[f.name] ? 'border-[var(--danger)]' : 'border-[var(--border)] focus:border-[var(--border-strong)]',
              f.secret && 'pr-16',
            )}
          />
          {f.secret && (
            <button
              type="button"
              onClick={() => setRevealed((r) => ({ ...r, [f.name]: !show }))}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-[var(--text-3)] hover:text-[var(--text)]"
            >
              {show ? 'Hide' : 'Show'}
            </button>
          )}
        </div>
        {fieldErrors[f.name] && <p className="mt-1 text-xs text-[var(--danger)]">{fieldErrors[f.name]}</p>}
        {(f.help || f.link) && (
          <p className="mt-1 text-xs text-[var(--text-3)]">
            {f.help}
            {f.link && (
              <>
                {' '}
                <a href={f.link} target="_blank" rel="noopener noreferrer" className="underline hover:text-[var(--text)]">
                  Open
                </a>
              </>
            )}
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-5 p-6">
        <div className="flex items-center gap-3">
          <ConnectorLogo icon={info.icon} name={info.name} />
          <div>
            <h1 className="text-lg font-semibold text-[var(--text)]">
              {existingId ? `Finish setting up ${info.name}` : `Set up ${info.name}`}
            </h1>
            <p className="text-sm text-[var(--text-2)]">{info.description}</p>
          </div>
        </div>

        {isOAuth && (
          <div className="rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm text-[var(--text-2)]">
            <p>
              You need an app of your own at {info.name.split(' ')[0]}, then you sign in once. In the app&apos;s settings, register this
              redirect URI exactly as shown:
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded bg-[var(--surface)] px-2 py-1 font-mono text-xs text-[var(--text)]">{redirectUri ?? '…'}</code>
              {redirectUri && (
                <Button size="sm" variant="secondary" onClick={() => navigator.clipboard?.writeText(redirectUri)}>
                  Copy
                </Button>
              )}
            </div>
          </div>
        )}

        {info.setupKind === 'none' && (
          <p className="text-sm text-[var(--text-2)]">Nothing to enter: it works without an account.</p>
        )}

        {GROUPS.map(({ kind, title }) => {
          const group = visibleFields.filter((f) => f.kind === kind);
          if (group.length === 0) return null;
          return (
            <fieldset key={kind} className="space-y-3">
              <legend className="mb-1 text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-3)]">{title}</legend>
              {group.map(renderField)}
            </fieldset>
          );
        })}

        {advancedFields.length > 0 && (
          <details className="rounded-[9px] border border-[var(--border)] p-3">
            <summary className="cursor-pointer text-sm text-[var(--text-2)]">Advanced</summary>
            <div className="mt-3 space-y-3">{advancedFields.map(renderField)}</div>
          </details>
        )}

        {verifyFailed && verifyFailed.ok === false && (
          <div role="alert" className="rounded-[9px] bg-[var(--t-danger-bg)] px-3 py-2 text-sm text-[var(--t-danger-fg)]">
            <p className="font-medium">
              {verifyFailed.kind === 'auth_failed'
                ? `${info.name} did not accept these credentials.`
                : verifyFailed.kind === 'invalid_input'
                  ? 'Some values are missing or not valid.'
                  : `${info.name} answered with an error.`}
            </p>
            <p className="mt-1 break-words text-xs">{verifyFailed.message}</p>
            {verifyFailed.kind !== 'invalid_input' && (
              <button type="button" onClick={() => saveAnyway(false)} className="mt-2 text-xs underline">
                Save anyway
              </button>
            )}
          </div>
        )}
        {error && (
          isTrialLimitMessage(error) ? (
            <TrialLimitNotice message={error} />
          ) : (
            <p role="alert" className="rounded-[9px] bg-[var(--t-danger-bg)] px-3 py-2 text-sm text-[var(--t-danger-fg)]">{error}</p>
          )
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={verifyAndSave} disabled={working}>
            {working ? 'Working…' : primaryLabel}
          </Button>
          {info.setupKind !== 'none' && !existingId && (
            <button type="button" onClick={() => saveAnyway(true)} disabled={working} className="text-sm text-[var(--text-3)] underline hover:text-[var(--text)]">
              Save as draft
            </button>
          )}
        </div>
        {info.setupKind !== 'none' && !existingId && (
          <p className="text-xs text-[var(--text-3)]">
            A draft is not offered to your AI client until it is complete.
          </p>
        )}
      </Card>

      {info.instructions && (
        <Card className="p-6">
          <details>
            <summary className="cursor-pointer text-sm font-medium text-[var(--text)]">Step-by-step guide</summary>
            <div className="prose prose-sm mt-3 max-w-none text-[13px] leading-relaxed dark:prose-invert [&_pre]:whitespace-pre-wrap [&_pre]:break-words">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{info.instructions}</ReactMarkdown>
            </div>
          </details>
        </Card>
      )}
    </div>
  );
}

export default function ConnectorSetupPage() {
  return (
    <AppShell>
      <div className="mx-auto w-full max-w-2xl p-4 sm:p-6">
        <Suspense fallback={<p className="text-sm text-[var(--text-2)]">Loading…</p>}>
          <SetupContent />
        </Suspense>
      </div>
    </AppShell>
  );
}
