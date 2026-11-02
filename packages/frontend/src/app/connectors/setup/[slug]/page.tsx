'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  type SetupGuideStep,
  type VerifyResult,
} from '@/lib/api';
import { AppShell } from '@/components/app-shell';
import { Card } from '@/components/ui/card';
import { Button, buttonVariants } from '@/components/ui/button';
import { ConnectorLogo } from '@/components/connector-logo';
import { isTrialLimitMessage, TrialLimitNotice } from '@/lib/trial-limit';
import { cn } from '@/lib/utils';
import { fileSearchSetupPath } from '@/lib/file-search-catalog';
import { copyText } from '@/lib/clipboard';
import { returnAssistant } from '@/lib/return-assistant';
import { GuideIntro, GuideStepper, GuideStepView, GuideWaitPanel, StuckLink } from '@/components/connector-setup/setup-guide';
import { SetupSuccess } from '@/components/connector-setup/setup-success';

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
 *   from=<client>   set up from a chat: at the end, the way back to that
 *                   assistant (see lib/return-assistant.ts for the list)
 *   prefill.<NAME>=<value>
 *                   start a field with this value, e.g. the Odoo address and
 *                   database from the AnythingMCP module in Odoo. Addresses and
 *                   settings only: a credential is never read from a link.
 *
 * An adapter with a `setupGuide` is set up one step at a time instead (an
 * intro, the steps, then the success screen); "Enter everything on one page"
 * switches to the form. The step reached is kept in localStorage so a setup
 * interrupted at the provider (an Etsy app still Pending) reopens there;
 * values never are. A `saveAndCheck` step saves the keys on the connector
 * (and its id in the address and the saved progress), so a user who waits
 * days for the provider's approval never types them again; the
 * `waitForProvider` step after it checks again whenever they come back.
 */

type Phase = 'form' | 'working' | 'done';

const GROUPS: Array<{ kind: EnvVarDescriptor['kind']; title: string }> = [
  { kind: 'address', title: 'Where it is' },
  { kind: 'credential', title: 'Credentials' },
  { kind: 'setting', title: 'Settings' },
];

function SetupContent() {
  const { slug } = useParams<{ slug: string }>();
  // File Search entries have their own guided setup (test, scan, describe).
  const fileSearchPath = fileSearchSetupPath(slug);
  const params = useSearchParams();
  const router = useRouter();
  useEffect(() => {
    if (fileSearchPath) router.replace(fileSearchPath);
  }, [fileSearchPath, router]);
  const { token } = useAuth();
  const existingId = params.get('connector');
  const back = returnAssistant(params.get('from'));
  const backFromProvider = params.get('step') === 'done';
  // Values handed over in the link (prefill.<NAME>), applied once the fields are known.
  const handed = useMemo(
    () =>
      Object.fromEntries(
        [...params.entries()]
          .filter(([k, v]) => k.startsWith('prefill.') && v.trim())
          .map(([k, v]) => [k.slice('prefill.'.length), v.trim()]),
      ),
    [params],
  );

  const [info, setInfo] = useState<AdapterSetupInfo | null>(null);
  const [loadError, setLoadError] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<Phase>(backFromProvider ? 'working' : 'form');
  const [error, setError] = useState('');
  const [verifyFailed, setVerifyFailed] = useState<VerifyResult | null>(null);
  const [result, setResult] = useState<{ connectorId: string; sample?: string; verified: boolean } | null>(null);
  const [redirectUri, setRedirectUri] = useState<string | null>(null);
  /** Secrets the existing connector already holds: shown as set, may stay empty. */
  const [storedSecrets, setStoredSecrets] = useState<string[]>([]);
  const started = useRef(false);
  /** Guide mode: -1 is the intro, then the index of the step shown. */
  const [mode, setMode] = useState<'guide' | 'form'>('guide');
  const [stepIndex, setStepIndex] = useState(-1);
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const [resume, setResume] = useState<{ index: number; title: string } | null>(null);
  const viewedSteps = useRef(new Set<number>());
  const progressKey = `amcp:setup_guide:${slug}`;
  /** The connector a `saveAndCheck` step created; also put in the address as ?connector=. */
  const [savedId, setSavedId] = useState<string | null>(null);
  const connectorId = existingId ?? savedId;
  /** Whether the provider accepts the saved keys (an Etsy app approved): null until asked. */
  const [providerReady, setProviderReady] = useState<boolean | null>(null);
  const [providerCheck, setProviderCheck] = useState<{ checking: boolean; at: Date | null; error: string }>({
    checking: false,
    at: null,
    error: '',
  });
  const lastProviderCheck = useRef(0);

  /** This setup's address for a saved connector, keeping the other parameters (from=…). */
  const withConnector = useCallback(
    (id: string) => {
      const q = new URLSearchParams(params.toString());
      q.set('connector', id);
      q.delete('step');
      return `/connectors/setup/${encodeURIComponent(slug)}?${q.toString()}`;
    },
    [params, slug],
  );

  /** In a guide, a refused value may belong to an earlier step: go there. */
  const showStepOf = (names: string[]) => {
    if (mode !== 'guide' || stepIndex < 0 || !info?.setupGuide) return;
    const steps = info.setupGuide.steps;
    if (steps[stepIndex]?.fields?.some((f) => names.includes(f))) return;
    const at = steps.findIndex((st) => st.fields?.some((f) => names.includes(f)));
    if (at >= 0) setStepIndex(at);
  };

  useEffect(() => {
    if (!token || !slug) return;
    // A setup left halfway reopens at its step; one back from the provider
    // with a refusal opens at the last step, where the keys are.
    const restoreProgress = (steps: SetupGuideStep[]) => {
      let saved: { step?: string; confirmed?: string[]; connectorId?: string } | null = null;
      try {
        saved = JSON.parse(localStorage.getItem(progressKey) ?? 'null');
      } catch {}
      if (Array.isArray(saved?.confirmed)) setConfirmed(Object.fromEntries(saved.confirmed.map((id) => [id, true])));
      // Keys saved on an earlier visit: carry on with that connector, if it
      // still exists, instead of creating a second one.
      const keep = !existingId && typeof saved?.connectorId === 'string' ? saved.connectorId : null;
      if (keep) {
        connectors
          .get(keep, token)
          .then((c) => {
            if (c?.id === keep) router.replace(withConnector(keep));
          })
          .catch(() => {});
      }
      if (backFromProvider) {
        setStepIndex(steps.length - 1);
        return;
      }
      const at = saved?.step ? steps.findIndex((st) => st.id === saved.step) : -1;
      if (at > 0) setResume({ index: at, title: steps[at].title });
    };
    adapters
      .describe(slug, token)
      .then((d) => {
        setInfo(d);
        // Addresses and settings only: a credential is never read from a link.
        // Typed or stored values win.
        const allowed = (d.envVars ?? []).filter((f) => f.kind !== 'credential' && !f.secret && handed[f.name]);
        if (allowed.length > 0) setValues((v) => ({ ...Object.fromEntries(allowed.map((f) => [f.name, handed[f.name]])), ...v }));
        if (d.setupGuide) restoreProgress(d.setupGuide.steps);
        // Once per tab session: a reload or a return from the provider is the
        // same setup, and counting each visit inflated "started".
        const onceKey = `amcp:setup_started:${slug}`;
        let seen = false;
        try {
          seen = !!sessionStorage.getItem(onceKey);
          sessionStorage.setItem(onceKey, '1');
        } catch {}
        if (!started.current && !seen) {
          started.current = true;
          productEvents.track('setup_started', token, { adapterSlug: slug, kind: d.setupKind });
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
  }, [token, slug, existingId, progressKey, backFromProvider, handed, router, withConnector]);

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
          // The sign-in can succeed with wrong app keys (Etsy's token exchange
          // does not check the shared secret), so only a call to the API tells.
          // A refusal sends the user back to the keys, not to "is ready".
          if (test && test.ok === false && test.kind === 'auth_failed') {
            productEvents.track('setup_verify_failed', token, { adapterSlug: slug, kind: 'after_authorization' });
            setVerifyFailed({ ok: false, kind: 'auth_failed', message: test.message } as VerifyResult);
            setError('');
            setPhase('form');
            return;
          }
          setResult({ connectorId: existingId, verified: test?.ok === true });
          setPhase('done');
          productEvents.track('setup_completed', token, { adapterSlug: slug, kind: 'oauth_browser', verified: test?.ok === true });
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

  const guide = mode === 'guide' ? info?.setupGuide : undefined;
  const guideSteps = useMemo(() => info?.setupGuide?.steps ?? [], [info]);

  useEffect(() => {
    if (!guide || stepIndex < 0 || !token) return;
    const step = guide.steps[stepIndex];
    if (!step) return;
    try {
      localStorage.setItem(
        progressKey,
        JSON.stringify({
          step: step.id,
          confirmed: Object.keys(confirmed).filter((k) => confirmed[k]),
          ...(connectorId ? { connectorId } : {}),
        }),
      );
    } catch {}
    if (!viewedSteps.current.has(stepIndex)) {
      viewedSteps.current.add(stepIndex);
      productEvents.track('setup_step_viewed', token, { adapterSlug: slug, step: step.id, index: stepIndex + 1 });
    }
  }, [guide, stepIndex, confirmed, token, slug, progressKey, connectorId]);

  useEffect(() => {
    if (phase !== 'done') return;
    try {
      localStorage.removeItem(progressKey);
    } catch {}
  }, [phase, progressKey]);

  /** Fields no step asks for (a token the sign-in fills in): on the last step. */
  const unguidedFields = useMemo(
    () => fields.filter((f) => !guideSteps.some((st) => st.fields?.includes(f.name))),
    [fields, guideSteps],
  );

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
        .filter(([name, v]) => connectorId || v !== '' || !fields.find((f) => f.name === name)?.required),
    ) as Record<string, string>;

  /** Client-side checks: required fields and patterns (of `only`, in a guide step). */
  const validate = (only?: string[]): boolean => {
    const errs: Record<string, string> = {};
    for (const f of only ? fields.filter((x) => only.includes(x.name)) : fields) {
      const v = (values[f.name] ?? '').trim();
      if (f.required && !f.advanced && !v && !storedSecrets.includes(f.name)) errs[f.name] = 'Required';
      else if (v && f.pattern) {
        try {
          if (!new RegExp(f.pattern).test(v)) errs[f.name] = f.patternMessage ?? (f.example ? `Looks wrong. Example: ${f.example}` : 'Looks wrong');
        } catch {
          /* a broken pattern never blocks the form */
        }
      }
    }
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) showStepOf(Object.keys(errs));
    return Object.keys(errs).length === 0;
  };

  /** Create the connector, or store the values on the existing one. Returns its id. */
  const save = async (): Promise<string> => {
    const creds = credentials();
    if (connectorId) {
      await connectors.updateEnvVars(connectorId, creds, token!);
      return connectorId;
    }
    const out = await adapters.import(slug, token!, creds);
    setSavedId(out.connectorId);
    return out.connectorId;
  };

  /** The guide's waitForProvider step, if it has one. */
  const waitStepAt = mode === 'guide' ? (info?.setupGuide?.steps.findIndex((st) => st.waitForProvider) ?? -1) : -1;

  /** A guide step shown from code: the refusal of one step does not follow to another. */
  const showStep = (i: number) => {
    setError('');
    setVerifyFailed(null);
    setStepIndex(i);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  /**
   * A `saveAndCheck` step: keep the keys on the connector, then ask the
   * provider about them. Accepted: on past the wait step. Refused (an Etsy
   * app still awaiting approval, or a wrong shared secret): the wait step,
   * which explains both. A value wrong in itself stays on this step.
   */
  const saveAndCheck = async (at: number) => {
    if (!token || !info?.setupGuide) return;
    setError('');
    setVerifyFailed(null);
    setPhase('working');
    try {
      const id = await save();
      if (!existingId) router.replace(withConnector(id));
      const check = await adapters.verify(slug, token, credentials(), id);
      if (check.ok === false && check.kind !== 'auth_failed') {
        if (check.missing?.length) {
          setFieldErrors(Object.fromEntries(check.missing.map((m) => [m, 'Required'])));
          showStepOf(check.missing);
        }
        setVerifyFailed(check);
        setPhase('form');
        return;
      }
      const ready = check.ok !== false;
      lastProviderCheck.current = Date.now();
      setProviderReady(ready);
      setProviderCheck({ checking: false, at: new Date(), error: '' });
      setPhase('form');
      const steps = info.setupGuide.steps;
      showStep(ready && steps[at + 1]?.waitForProvider ? at + 2 : at + 1);
    } catch (e) {
      fail(e);
    }
  };

  /** The wait step's check: does the provider accept the saved keys now? */
  const recheck = useCallback(async () => {
    if (!token || !connectorId) return;
    lastProviderCheck.current = Date.now();
    setProviderCheck((c) => ({ ...c, checking: true, error: '' }));
    try {
      const check = await adapters.verify(slug, token, {}, connectorId);
      setProviderReady(check.ok !== false);
      // Not a refusal of the keys (a value missing, the provider down): say so.
      setProviderCheck({ checking: false, at: new Date(), error: check.ok === false && check.kind !== 'auth_failed' ? check.message : '' });
    } catch (e: any) {
      setProviderCheck((c) => ({ checking: false, at: c.at, error: e?.message || 'Something went wrong.' }));
    }
  }, [token, connectorId, slug]);

  // On the wait step: check when it opens and whenever the user comes back
  // to the tab (from Etsy's page, or the next day), at most once a minute.
  // No timer: an approval takes hours, and each check is a call to the provider.
  const onWaitStep = mode === 'guide' && stepIndex >= 0 && stepIndex === waitStepAt;
  useEffect(() => {
    if (!onWaitStep || providerReady === true || !connectorId) return;
    const maybe = () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastProviderCheck.current < 60_000) return;
      void recheck();
    };
    maybe();
    document.addEventListener('visibilitychange', maybe);
    window.addEventListener('focus', maybe);
    return () => {
      document.removeEventListener('visibilitychange', maybe);
      window.removeEventListener('focus', maybe);
    };
  }, [onWaitStep, providerReady, connectorId, recheck]);

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
      // Checked before anything else, the browser sign-in included: an app
      // the provider does not accept yet (Etsy: still Pending, or the wrong
      // shared secret) used to send the user to an error page at the
      // provider that they never came back from.
      const check =
        info.setupKind === 'none' ? null : await adapters.verify(slug, token, credentials(), connectorId ?? undefined);
      // Keys refused at the end of a guide with a wait step (a connector
      // finished from the chat, a step skipped): keep them and wait there.
      if (check && check.ok === false && check.kind === 'auth_failed' && waitStepAt >= 0) {
        const id = await save();
        if (!existingId) router.replace(withConnector(id));
        lastProviderCheck.current = Date.now();
        setProviderReady(false);
        setProviderCheck({ checking: false, at: new Date(), error: '' });
        setPhase('form');
        showStep(waitStepAt);
        return;
      }
      if (check && check.ok === false) {
        // setup_verify_failed is recorded by the server, with the provider's message.
        if (check.missing?.length) {
          setFieldErrors(Object.fromEntries(check.missing.map((m) => [m, 'Required'])));
          showStepOf(check.missing);
        } else if (check.fields && Object.keys(check.fields).length > 0) {
          // A value the server refused (an example left in the field, a key
          // pasted twice): the message goes under that field.
          setFieldErrors(check.fields);
          showStepOf(Object.keys(check.fields));
        }
        // The app waits for the provider's approval: keep the keys on a draft
        // connector (hidden from MCP until signed in), so the backend can check
        // them again and email the owner once they are accepted. When it cannot
        // be saved (plan limit), the page shows the provider's answer as before.
        if (check.appPending) {
          // save() remembers the new connector (savedId), so a retry stores
          // the new values on it instead of installing a second one.
          try {
            await save();
            productEvents.track('setup_saved_draft', token, { adapterSlug: slug, kind: 'app_pending' });
          } catch {
            // Not saved (plan limit): the provider's answer is shown as before.
          }
        }
        setVerifyFailed(check);
        setPhase('form');
        return;
      }
      // A Shopee shop is authorized right after the keys are saved, through
      // Shopee's own signed link.
      if (slug === 'shopee') {
        const id = await save();
        const returnTo = `/connectors/setup/${slug}?connector=${id}&step=done${back ? `&from=${back.id}` : ''}`;
        const auth = await connectors.shopeeAuthorize(id, token, returnTo);
        if (!auth.authorizationUrl) throw new Error(auth.error || 'Could not start the authorization.');
        productEvents.track('oauth_started', token, { adapterSlug: slug });
        window.location.href = auth.authorizationUrl;
        return;
      }
      if (info.setupKind === 'oauth_browser') {
        const id = await save();
        const returnTo = `/connectors/setup/${slug}?connector=${id}&step=done${back ? `&from=${back.id}` : ''}`;
        const auth = await connectors.oauthAuthorize(id, token, returnTo);
        if (!auth.authorizationUrl) throw new Error(auth.error || 'Could not start the authorization.');
        productEvents.track('oauth_started', token, { adapterSlug: slug });
        window.location.href = auth.authorizationUrl;
        return;
      }
      const id = await save();
      setResult({ connectorId: id, sample: check && check.ok ? check.sample : undefined, verified: check?.ok === true });
      setPhase('done');
      productEvents.track('setup_completed', token, { adapterSlug: slug, kind: info.setupKind, verified: check?.ok === true });
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
      <Card className="p-6">
        {info.setupGuide && mode === 'guide' && (
          <div className="mb-6">
            <GuideStepper steps={info.setupGuide.steps} current={info.setupGuide.steps.length + 1} />
          </div>
        )}
        <SetupSuccess
          name={info.name}
          icon={info.icon}
          connectorId={result.connectorId}
          verified={result.verified}
          sample={result.sample}
          examples={info.setupGuide?.examples ?? []}
          back={back}
        />
      </Card>
    );
  }

  const working = phase === 'working';
  const isOAuth = info.setupKind === 'oauth_browser';
  // A bridge to a vendor's MCP server that registers its own client: the
  // sign-in is all there is (Notion, Helium 10). One that needs an app of
  // the user's asks for its client ID like any other OAuth connector.
  const selfRegisteringBridge = info.connector.type === 'MCP' && info.envVars.every((v) => !v.required);
  const primaryLabel =
    info.setupKind === 'none'
      ? `Install ${info.name}`
      : isOAuth
        ? `Save and sign in to ${info.name.split(' ')[0]}`
        : existingId
          ? 'Check and save'
          : 'Check and install';

  /** What the check or the save said, under the fields. */
  const checkOutcome = (
    <>
      {verifyFailed && verifyFailed.ok === false && verifyFailed.appPending && connectorId && (
        <div role="status" className="rounded-[9px] bg-[var(--t-info-bg)] px-3 py-2 text-sm text-[var(--t-info-fg)]">
          <p className="font-medium">{info.name} has not approved your app yet.</p>
          <p className="mt-1">{info.name} reviews new apps, usually within a few days. We&apos;ll e-mail you when it&apos;s approved; nothing else to do. Your keys are saved.</p>
          <p className="mt-1 break-words text-xs">{verifyFailed.message}</p>
          <Link href={`/connectors/${encodeURIComponent(connectorId)}`} className="mt-2 inline-block text-xs font-medium underline">
            Open the connector
          </Link>
        </div>
      )}
      {verifyFailed && verifyFailed.ok === false && !(verifyFailed.appPending && connectorId) && (
        <div role="alert" className="rounded-[9px] bg-[var(--t-danger-bg)] px-3 py-2 text-sm text-[var(--t-danger-fg)]">
          <p className="font-medium">
            {verifyFailed.kind === 'auth_failed'
              ? `${info.name} did not accept these credentials.`
              : verifyFailed.kind === 'invalid_input'
                ? 'Some values are missing or not valid.'
                : `${info.name} answered with an error.`}
          </p>
          <p className="mt-1 break-words text-xs">{verifyFailed.message}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            {verifyFailed.suggest && (
              <Link
                href={`/connectors/setup/${encodeURIComponent(verifyFailed.suggest)}`}
                className="text-xs font-medium underline"
              >
                Set up {verifyFailed.suggestName ?? 'the other connector'} instead
              </Link>
            )}
            {verifyFailed.kind !== 'invalid_input' && (
              <button type="button" onClick={() => saveAnyway(false)} className="text-xs underline">
                Save anyway
              </button>
            )}
          </div>
        </div>
      )}
      {error && (
        isTrialLimitMessage(error) ? (
          <TrialLimitNotice message={error} />
        ) : (
          <p role="alert" className="rounded-[9px] bg-[var(--t-danger-bg)] px-3 py-2 text-sm text-[var(--t-danger-fg)]">{error}</p>
        )
      )}
    </>
  );

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

  if (guide) {
    if (stepIndex < 0) {
      return (
        <Card className="p-6">
          <GuideIntro
            info={info}
            guide={guide}
            resume={resume}
            onStart={() => setStepIndex(resume?.index ?? 0)}
            onRestart={() => {
              try {
                localStorage.removeItem(progressKey);
              } catch {}
              setConfirmed({});
              setResume(null);
              setStepIndex(0);
            }}
            onShowForm={() => setMode('form')}
            skipTo={
              // Finishing a connector that exists (re-entering keys): the
              // steps at the provider may well be done already.
              existingId && !resume && guide.steps.length > 1
                ? { index: guide.steps.length - 1, title: guide.steps[guide.steps.length - 1].title }
                : null
            }
            onSkip={() => setStepIndex(guide.steps.length - 1)}
          />
        </Card>
      );
    }
    const step = guide.steps[Math.min(stepIndex, guide.steps.length - 1)];
    const at = guide.steps.indexOf(step);
    const isLast = at === guide.steps.length - 1;
    const stepFields = (step.fields ?? [])
      .map((name) => fields.find((f) => f.name === name))
      .filter((f): f is EnvVarDescriptor => !!f);
    const extraFields = isLast ? unguidedFields.filter((f) => !f.advanced) : [];
    const extraAdvanced = isLast ? unguidedFields.filter((f) => f.advanced) : [];
    const needsTick = !!step.confirm && !confirmed[step.id];
    const waiting = !!step.waitForProvider;
    const waitBlocks = waiting && providerReady !== true;
    // A link into the user's own instance starts with a value from an earlier
    // step (the WooCommerce shop address); until it is a usable https address
    // there is nothing to open.
    const actionUrl = step.action
      ? step.action.url.replace(/^\{\{([A-Z0-9_]+)\}\}/, (_, name: string) => (values[name] ?? '').trim().replace(/\/+$/, ''))
      : null;
    // A refusal belongs to the step that ran the check.
    const goTo = showStep;
    // Back past a wait step the provider has already cleared.
    const previous = at > 0 && guide.steps[at - 1]?.waitForProvider && providerReady === true ? at - 2 : at - 1;
    const next = () => {
      if (!validate(step.fields ?? [])) return;
      if (waitBlocks) return;
      if (token) productEvents.track('setup_step_completed', token, { adapterSlug: slug, step: step.id, index: at + 1 });
      if (isLast) {
        void verifyAndSave();
        return;
      }
      if (step.saveAndCheck) {
        void saveAndCheck(at);
        return;
      }
      setVerifyFailed(null);
      goTo(at + 1);
    };
    const short = info.name.split(' ')[0];
    const finishLabel =
      info.setupKind === 'none'
        ? `Install ${info.name}`
        : isOAuth
          ? `Check and sign in to ${short}`
          : existingId
            ? 'Check and save'
            : 'Check and connect';

    return (
      <Card className="space-y-6 p-6">
        <GuideStepper steps={guide.steps} current={at} />
        <GuideStepView
          step={step}
          index={at}
          total={guide.steps.length}
          redirectUri={redirectUri}
          actionUrl={actionUrl && /^https:\/\/[^/\s]+/.test(actionUrl) ? actionUrl : null}
          confirmed={!!confirmed[step.id]}
          onConfirm={(v) => setConfirmed((c) => ({ ...c, [step.id]: v }))}
        >
          {(stepFields.length > 0 || extraFields.length > 0) && (
            <div className="space-y-3">{[...stepFields, ...extraFields].map(renderField)}</div>
          )}
          {extraAdvanced.length > 0 && (
            <details className="rounded-[9px] border border-[var(--border)] p-3">
              <summary className="cursor-pointer text-sm text-[var(--text-2)]">Advanced</summary>
              <div className="mt-3 space-y-3">{extraAdvanced.map(renderField)}</div>
            </details>
          )}
          {waiting && (
            <GuideWaitPanel
              name={short}
              status={providerCheck.checking ? 'checking' : providerReady === true ? 'ready' : connectorId ? 'waiting' : 'checking'}
              checkedAt={providerCheck.at}
              error={connectorId ? providerCheck.error : 'Enter your keys in the step before first.'}
              onCheck={() => void recheck()}
              onReenterKeys={() => goTo(at - 1)}
            />
          )}
          {isLast && isOAuth && (
            <p className="text-xs text-[var(--text-3)]">
              Next, {short} asks you to approve access. You come back here on your own.
            </p>
          )}
          {checkOutcome}
        </GuideStepView>

        <div className="space-y-2 border-t border-[var(--border)] pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={() => goTo(previous)} disabled={working}>
              Back
            </Button>
            <Button onClick={next} disabled={working || needsTick || waitBlocks}>
              {working
                ? 'Checking…'
                : isLast
                  ? finishLabel
                  : step.saveAndCheck
                    ? `Save and check with ${short}`
                    : 'Continue'}
            </Button>
            <span className="ml-auto">
              <StuckLink name={info.name} />
            </span>
          </div>
          {needsTick && <p className="text-xs text-[var(--text-3)]">Tick the box above once it is done.</p>}
          {waitBlocks && <p className="text-xs text-[var(--text-3)]">Continue opens once {short} has approved your app.</p>}
        </div>
      </Card>
    );
  }

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
            {info.setupGuide && (
              <button type="button" onClick={() => setMode('guide')} className="mt-1 text-xs text-[var(--text-3)] underline hover:text-[var(--text)]">
                Prefer step by step? Use the guided setup
              </button>
            )}
          </div>
        </div>

        {info.prerequisites && (
          <div className="rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm text-[var(--text-2)]">
            <p className="mb-1 font-medium text-[var(--text)]">Before you start</p>
            <div className="prose prose-sm max-w-none text-[13px] leading-relaxed dark:prose-invert [&_p]:my-1">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{info.prerequisites}</ReactMarkdown>
            </div>
          </div>
        )}

        {isOAuth && selfRegisteringBridge && (
          <div className="rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm text-[var(--text-2)]">
            <p>
              After saving you sign in at {info.name.split(' ')[0]} once. AnythingMCP registers itself with {info.name.split(' ')[0]}&apos;s
              MCP server, so there is no app to create and no key to copy.
            </p>
          </div>
        )}

        {isOAuth && !selfRegisteringBridge && (
          <div className="rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm text-[var(--text-2)]">
            <p>
              You need an app of your own at {info.name.split(' ')[0]}, then you sign in once. In the app&apos;s settings, add this
              callback URL (also called redirect URI) exactly as shown:
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded bg-[var(--surface)] px-2 py-1 font-mono text-xs text-[var(--text)]">{redirectUri ?? '…'}</code>
              {redirectUri && (
                <Button size="sm" variant="secondary" onClick={() => void copyText(redirectUri)}>
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

        {checkOutcome}

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
