'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslations } from 'next-intl';
import { useAuth } from '@/lib/auth-context';
import {
  adapters,
  connectors,
  planLimitOf,
  productEvents,
  type AdapterSetupInfo,
  type PlanLimitError,
  type EnvVarDescriptor,
  type SetupGuideStep,
  type VerifyResult,
} from '@/lib/api';
import { AppShell } from '@/components/app-shell';
import { Card } from '@/components/ui/card';
import { Button, buttonVariants } from '@/components/ui/button';
import { ConnectorLogo } from '@/components/connector-logo';
import { isTrialLimitMessage, TrialLimitNotice } from '@/lib/trial-limit';
import { PlanLimitNotice } from '@/components/plan-swap-dialog';
import { cn } from '@/lib/utils';
import { fileSearchSetupPath } from '@/lib/file-search-catalog';
import { copyText } from '@/lib/clipboard';
import { returnAssistant } from '@/lib/return-assistant';
import { addressFix, isPlainAddressField, switchSetupHref, withMissingScheme, type AddressFix } from '@/lib/address-fix';
import { GuideIntro, GuideStepper, GuideStepView, GuideWaitPanel, StuckLink } from '@/components/connector-setup/setup-guide';
import { SetupSuccess } from '@/components/connector-setup/setup-success';
import { NetworkNote } from '@/components/connector-setup/network-note';

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
 *   source=<slug>   where the setup was opened from, kept on the setup events
 *                   (odoo_module: the AnythingMCP module in Odoo's Settings)
 *   replaces=<id>   opened from "Switch to …" on another connector's setup
 *                   (an Odoo below 19 on the JSON-2 connector): once this one
 *                   is saved, that connector is deleted if it is still not
 *                   ready and comes from another catalog adapter, so the
 *                   workspace keeps no dead draft.
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

/** Field groups, in order; titles are `connectorSetup.groups.<kind>`. */
const GROUPS: Array<EnvVarDescriptor['kind']> = ['address', 'credential', 'setting'];

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
  const t = useTranslations('connectorSetup');
  const existingId = params.get('connector');
  const replaces = params.get('replaces');
  const back = returnAssistant(params.get('from'));
  const backFromProvider = params.get('step') === 'done';
  // Where the setup was opened from, for the setup events only (`source=odoo_module`:
  // the AnythingMCP module in Odoo's Settings). A short slug, or nothing.
  const sourceParam = params.get('source') ?? '';
  const source = /^[a-z0-9_]{1,32}$/.test(sourceParam) ? sourceParam : undefined;
  const fromSource = useMemo((): Record<string, string> => (source ? { source } : {}), [source]);
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
  // The install refused at the plan's limit (Cloud): "Pause one or upgrade".
  const [planLimit, setPlanLimit] = useState<PlanLimitError | null>(null);
  const [verifyFailed, setVerifyFailed] = useState<VerifyResult | null>(null);
  const [result, setResult] = useState<{ connectorId: string; sample?: string; verified: boolean; note?: string } | null>(null);
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
  // TikTok Shop: whether this server has its own app (then the seller's App
  // key, App secret and Service ID stay empty), and whether the user chose
  // their own app anyway. Unknown until asked: the fields show meanwhile.
  const isTikTokShop = slug === 'tiktok-shop';
  const [tiktokPlatform, setTiktokPlatform] = useState<{ available: boolean; redirectUrl: string } | null>(null);
  const [ownTikTokApp, setOwnTikTokApp] = useState(false);
  const serverTikTokApp = isTikTokShop && tiktokPlatform?.available === true && !ownTikTokApp;
  // Instagram: sign in with Facebook (adapter `instagram`) or Instagram
  // (`instagram-login`), which fills in the token and account id, or paste a
  // token. Signing in needs a Meta app: the server's when it has one,
  // otherwise the user's own (its id and secret are then required).
  const metaFlavour: 'facebook' | 'instagram' | null =
    slug === 'instagram' ? 'facebook' : slug === 'instagram-login' ? 'instagram' : null;
  const [metaPlatform, setMetaPlatform] = useState<{
    facebook: boolean;
    unified?: boolean;
    instagram: boolean;
    redirectUrl: string;
  } | null>(null);
  const [metaMode, setMetaMode] = useState<'signin' | 'paste'>('signin');
  const [ownMetaApp, setOwnMetaApp] = useState(false);
  const metaSignIn = metaFlavour !== null && metaMode === 'signin';
  const serverMetaApp = metaSignIn && metaPlatform?.[metaFlavour!] === true && !ownMetaApp;
  const metaAppVars = metaFlavour === 'facebook' ? META_FACEBOOK_APP_VARS : META_INSTAGRAM_APP_VARS;
  // The `instagram` connector signs in with Instagram or Facebook (Unified
  // Login) or, with an older app, Facebook only; `instagram-login` with Instagram.
  const metaProvider = metaFlavour === 'instagram' ? 'Instagram' : 'Instagram / Facebook';

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
          productEvents.track('setup_started', token, { adapterSlug: slug, kind: d.setupKind, ...fromSource });
        }
      })
      .catch((e: Error) => setLoadError(e.message || t('notAvailable')));
    if (existingId) {
      // Pre-fill what is stored and not secret (secrets come back empty).
      connectors
        .get(existingId, token)
        .then((c) => {
          const env = (c?.envVars ?? {}) as Record<string, string>;
          setValues((v) => ({ ...Object.fromEntries(Object.entries(env).filter(([, x]) => x)), ...v }));
          // A TikTok Shop connector that has an App key of its own keeps its app.
          if (env.TIKTOK_SHOP_APP_KEY) setOwnTikTokApp(true);
          // An Instagram connector with an app of its own keeps its app.
          if (env.META_APP_ID || env.INSTAGRAM_APP_ID) setOwnMetaApp(true);
          setStoredSecrets(Array.isArray(c?.maskedEnvVars) ? c.maskedEnvVars : []);
        })
        .catch(() => {});
    }
  }, [token, slug, existingId, progressKey, backFromProvider, t, handed, router, withConnector, fromSource]);

  useEffect(() => {
    if (!token || !isTikTokShop) return;
    connectors
      .tiktokShopPlatform(token)
      .then(setTiktokPlatform)
      .catch(() => setTiktokPlatform({ available: false, redirectUrl: '' }));
  }, [token, isTikTokShop]);

  useEffect(() => {
    if (!token || !metaFlavour) return;
    connectors
      .metaPlatform(token)
      .then(setMetaPlatform)
      .catch(() => setMetaPlatform({ facebook: false, instagram: false, redirectUrl: '' }));
  }, [token, metaFlavour]);

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
            productEvents.track('setup_verify_failed', token, { adapterSlug: slug, kind: 'after_authorization', ...fromSource });
            setVerifyFailed({ ok: false, kind: 'auth_failed', message: test.message } as VerifyResult);
            setError('');
            setPhase('form');
            return;
          }
          setResult({ connectorId: existingId, verified: test?.ok === true });
          setPhase('done');
          productEvents.track('setup_completed', token, { adapterSlug: slug, kind: 'oauth_browser', verified: test?.ok === true, ...fromSource });
        } else {
          setError(t('authIncomplete'));
          setPhase('form');
        }
      })
      .catch((e: Error) => {
        setError(e.message);
        setPhase('form');
      });
  }, [backFromProvider, existingId, token, slug, t, fromSource]);

  // TikTok Shop's app variables are optional in the catalog (empty means the
  // server's app). Without a server app, or with the user's own app chosen,
  // they are required here; with the server's app they are hidden and sent
  // empty.
  // Signing in to Instagram fills in the token and account id, so those are
  // hidden then, and the app id and secret are required unless the server
  // has its own app (then they are hidden too).
  const fields = useMemo(
    () =>
      (info?.envVars ?? []).map((f) =>
        (isTikTokShop && TIKTOK_SHOP_APP_VARS.includes(f.name) && !serverTikTokApp) ||
        (metaSignIn && !serverMetaApp && metaAppVars.includes(f.name) && f.name !== 'META_CONFIG_ID')
          ? { ...f, required: true }
          : f,
      ),
    [info, isTikTokShop, serverTikTokApp, metaSignIn, serverMetaApp, metaAppVars],
  );
  const hiddenField = (name: string) =>
    (serverTikTokApp && TIKTOK_SHOP_APP_VARS.includes(name)) ||
    (metaSignIn && META_SIGN_IN_VARS.includes(name)) ||
    (serverMetaApp && metaAppVars.includes(name));
  const visibleFields = fields.filter((f) => !f.advanced && !hiddenField(f.name));
  const advancedFields = fields.filter((f) => f.advanced && !hiddenField(f.name));

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
        // An address typed without https:// gets it when the pattern wants it.
        // A hidden TikTok Shop app field goes empty: the server's app is used.
        // The token and account id a sign-in fills in are not sent at all: an
        // empty value must not touch what a sign-in stored.
        .filter((f) => !(metaSignIn && META_SIGN_IN_VARS.includes(f.name)))
        .map((f) => [f.name, hiddenField(f.name) ? '' : withMissingScheme(f, (values[f.name] ?? '').trim())] as const)
        .filter(([name, v]) => connectorId || v !== '' || !fields.find((f) => f.name === name)?.required),
    ) as Record<string, string>;

  /** Show the https:// an address gets as soon as the user leaves the field. */
  const completeAddress = (f: EnvVarDescriptor) => {
    const v = values[f.name] ?? '';
    const fixed = withMissingScheme(f, v);
    if (fixed === v) return;
    setValues((all) => ({ ...all, [f.name]: fixed }));
    setFieldErrors((errs) => {
      const next = { ...errs };
      delete next[f.name];
      return next;
    });
  };

  /** What to change in a refused address, when the pattern says it ("Add https:// in front: …"). */
  const fixMessage = (fix: AddressFix): string => {
    const phrases = fix.changes.map((c) => t(`field.fix.${c}`, { removed: fix.removed ?? '' }));
    const joined =
      phrases.length > 1 ? `${phrases.slice(0, -1).join(', ')} ${t('field.fix.and')} ${phrases[phrases.length - 1]}` : phrases[0];
    return t('field.fix.sentence', { changes: `${joined.charAt(0).toUpperCase()}${joined.slice(1)}`, value: fix.value });
  };

  /** Client-side checks: required fields and patterns (of `only`, in a guide step). */
  const validate = (only?: string[]): boolean => {
    const errs: Record<string, string> = {};
    for (const f of only ? fields.filter((x) => only.includes(x.name)) : fields) {
      if (hiddenField(f.name)) continue;
      const v = withMissingScheme(f, (values[f.name] ?? '').trim());
      if (f.required && !f.advanced && !v && !storedSecrets.includes(f.name)) errs[f.name] = t('field.required');
      else if (v && f.pattern) {
        try {
          if (!new RegExp(f.pattern).test(v)) {
            // Say what to change when the pattern tells it; the adapter's own words otherwise.
            const fix = isPlainAddressField(f) ? addressFix(f.pattern, v) : undefined;
            errs[f.name] = fix
              ? fixMessage(fix)
              : (f.patternMessage ?? (f.example ? t('field.looksWrongExample', { example: f.example }) : t('field.looksWrong')));
          }
        } catch {
          /* a broken pattern never blocks the form */
        }
      }
    }
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) showStepOf(Object.keys(errs));
    return Object.keys(errs).length === 0;
  };

  /**
   * Opened from "Switch to …" on another connector's setup (?replaces=): the
   * connector left behind there is deleted once this one is saved, if it is
   * still not ready and comes from another catalog adapter. A connector that
   * works, or one of this adapter, is never touched; a failure keeps it.
   */
  const retireReplaced = async (newId: string) => {
    if (!replaces || replaces === newId || !token) return;
    try {
      const old = await connectors.get(replaces, token);
      const oldSlug = (old?.config as { adapterSlug?: unknown } | null | undefined)?.adapterSlug;
      // Only the draft the switch was offered on: an `odoo` connector replaced
      // by `odoo-jsonrpc`. A hand-made ?replaces= link must never delete
      // another connector of this user.
      if (old?.id !== replaces || old.setupStatus === 'ready' || typeof oldSlug !== 'string') return;
      if (REPLACEABLE_DRAFTS[oldSlug] !== slug) return;
      await connectors.delete(replaces, token);
    } catch {
      // Kept: it stays visible under Connectors, where it can be deleted.
    }
  };

  /**
   * Create the connector, or store the values on the existing one. Returns its id.
   * `fix`: values the check corrected (an Odoo database name), saved over what was typed.
   */
  const save = async (fix?: Record<string, string>): Promise<string> => {
    const creds = { ...credentials(), ...(fix ?? {}) };
    if (connectorId) {
      await connectors.updateEnvVars(connectorId, creds, token!);
      return connectorId;
    }
    const out = await adapters.import(slug, token!, creds);
    setSavedId(out.connectorId);
    await retireReplaced(out.connectorId);
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
      const check = await adapters.verify(slug, token, credentials(), id, source);
      if (check.ok === false && check.kind !== 'auth_failed') {
        if (check.missing?.length) {
          setFieldErrors(Object.fromEntries(check.missing.map((m) => [m, t('field.required')])));
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
      const check = await adapters.verify(slug, token, {}, connectorId, source);
      setProviderReady(check.ok !== false);
      // Not a refusal of the keys (a value missing, the provider down): say so.
      setProviderCheck({ checking: false, at: new Date(), error: check.ok === false && check.kind !== 'auth_failed' ? check.message : '' });
    } catch (e: any) {
      setProviderCheck((c) => ({ checking: false, at: c.at, error: e?.message || t('genericError') }));
    }
  }, [token, connectorId, slug, t, source]);

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
    setPlanLimit(planLimitOf(e));
    setError(e?.message || t('genericError'));
  };

  const verifyAndSave = async () => {
    if (!token || !info || !validate()) return;
    setError('');
    setVerifyFailed(null);
    setPhase('working');
    try {
      // Instagram: save, then sign in with Facebook or Instagram; the sign-in
      // stores the token and the account id, and Meta checks the app.
      if (metaSignIn) {
        const id = await save();
        const returnTo = `/connectors/setup/${slug}?connector=${id}&step=done${back ? `&from=${back.id}` : ''}`;
        const auth = await connectors.metaAuthorize(id, token, returnTo);
        if (!auth.authorizationUrl) throw new Error(auth.error || t('authStartFailed'));
        productEvents.track('oauth_started', token, { adapterSlug: slug });
        window.location.href = auth.authorizationUrl;
        return;
      }
      // Checked before anything else, the browser sign-in included: an app
      // the provider does not accept yet (Etsy: still Pending, or the wrong
      // shared secret) used to send the user to an error page at the
      // provider that they never came back from.
      const check =
        info.setupKind === 'none' ? null : await adapters.verify(slug, token, credentials(), connectorId ?? undefined, source);
      // The check found the right value itself (an Odoo database name the
      // address names): it goes into the field and is saved with the rest.
      const fix = check && check.ok !== null ? check.corrected : undefined;
      if (fix) setValues((v) => ({ ...v, ...fix }));
      // Keys refused at the end of a guide with a wait step (a connector
      // finished from the chat, a step skipped): keep them and wait there.
      if (check && check.ok === false && check.kind === 'auth_failed' && waitStepAt >= 0) {
        const id = await save(fix);
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
          setFieldErrors(Object.fromEntries(check.missing.map((m) => [m, t('field.required')])));
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
            productEvents.track('setup_saved_draft', token, { adapterSlug: slug, kind: 'app_pending', ...fromSource });
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
        const id = await save(fix);
        const returnTo = `/connectors/setup/${slug}?connector=${id}&step=done${back ? `&from=${back.id}` : ''}`;
        const auth = await connectors.shopeeAuthorize(id, token, returnTo);
        if (!auth.authorizationUrl) throw new Error(auth.error || t('authStartFailed'));
        productEvents.track('oauth_started', token, { adapterSlug: slug });
        window.location.href = auth.authorizationUrl;
        return;
      }
      // A TikTok shop likewise, through TikTok Shop's seller authorization link.
      if (slug === 'tiktok-shop') {
        const id = await save(fix);
        const returnTo = `/connectors/setup/${slug}?connector=${id}&step=done${back ? `&from=${back.id}` : ''}`;
        const auth = await connectors.tiktokShopAuthorize(id, token, returnTo);
        if (!auth.authorizationUrl) throw new Error(auth.error || t('authStartFailed'));
        productEvents.track('oauth_started', token, { adapterSlug: slug });
        window.location.href = auth.authorizationUrl;
        return;
      }
      if (info.setupKind === 'oauth_browser') {
        const id = await save(fix);
        const returnTo = `/connectors/setup/${slug}?connector=${id}&step=done${back ? `&from=${back.id}` : ''}`;
        const auth = await connectors.oauthAuthorize(id, token, returnTo);
        if (!auth.authorizationUrl) throw new Error(auth.error || t('authStartFailed'));
        productEvents.track('oauth_started', token, { adapterSlug: slug });
        window.location.href = auth.authorizationUrl;
        return;
      }
      const id = await save(fix);
      setResult({
        connectorId: id,
        sample: check && check.ok ? check.sample : undefined,
        verified: check?.ok === true,
        note: check && check.ok ? check.note : undefined,
      });
      setPhase('done');
      productEvents.track('setup_completed', token, {
        adapterSlug: slug,
        kind: info.setupKind,
        verified: check?.ok === true,
        ...(fix ? { corrected: Object.keys(fix).join(',') } : {}),
        ...fromSource,
      });
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
      productEvents.track(draft ? 'setup_saved_draft' : 'setup_saved_unverified', token, { adapterSlug: slug, ...fromSource });
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
          {t('backToMarketplace')}
        </Link>
      </Card>
    );
  }
  if (!info) return <p className="text-sm text-[var(--text-2)]">{t('loading')}</p>;

  if (phase === 'done' && result) {
    return (
      <Card className="p-6">
        {info.setupGuide && mode === 'guide' && (
          <div className="mb-6">
            <GuideStepper steps={info.setupGuide.steps} current={info.setupGuide.steps.length + 1} />
          </div>
        )}
        {result.note && (
          <p role="status" className="mb-4 rounded-[9px] bg-[var(--t-info-bg)] px-3 py-2 text-sm text-[var(--t-info-fg)]">
            {result.note}
          </p>
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
  const primaryLabel = metaSignIn
    ? t('metaLogin.signIn', { provider: metaProvider })
    : info.setupKind === 'none'
      ? t('actions.install', { name: info.name })
      : isOAuth
        ? t('actions.saveAndSignIn', { name: info.name.split(' ')[0] })
        : existingId
          ? t('actions.checkAndSave')
          : t('actions.checkAndInstall');

  /** What the check or the save said, under the fields. */
  const checkOutcome = (
    <>
      {verifyFailed && verifyFailed.ok === false && verifyFailed.appPending && connectorId && (
        <div role="status" className="rounded-[9px] bg-[var(--t-info-bg)] px-3 py-2 text-sm text-[var(--t-info-fg)]">
          <p className="font-medium">{t('verify.appPendingTitle', { name: info.name })}</p>
          <p className="mt-1">{t('verify.appPendingBody', { name: info.name })}</p>
          <p className="mt-1 break-words text-xs">{verifyFailed.message}</p>
          <Link href={`/connectors/${encodeURIComponent(connectorId)}`} className="mt-2 inline-block text-xs font-medium underline">
            {t('verify.appPendingOpen')}
          </Link>
        </div>
      )}
      {verifyFailed && verifyFailed.ok === false && !(verifyFailed.appPending && connectorId) && (
        <div role="alert" className="rounded-[9px] bg-[var(--t-danger-bg)] px-3 py-2 text-sm text-[var(--t-danger-fg)]">
          <p className="font-medium">
            {verifyFailed.kind === 'auth_failed'
              ? t('verify.authFailed', { name: info.name })
              : verifyFailed.kind === 'invalid_input'
                ? t('verify.invalidInput')
                : t('verify.providerError', { name: info.name })}
          </p>
          <p className="mt-1 break-words text-xs">{verifyFailed.message}</p>
          {verifyFailed.switchTo && (
            // The other connector's setup, started with the address and
            // settings typed here (never a key), the way back to the chat, and
            // this connector to delete once that one is saved.
            <Link
              href={switchSetupHref(verifyFailed.switchTo.slug, verifyFailed.switchTo.prefill ?? {}, {
                from: back?.id,
                replaces: connectorId,
              })}
              className={cn(buttonVariants({ size: 'sm' }), 'mt-3')}
            >
              {t('verify.switchTo', { name: verifyFailed.switchTo.name })}
            </Link>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            {verifyFailed.suggest && !verifyFailed.switchTo && (
              <Link
                href={`/connectors/setup/${encodeURIComponent(verifyFailed.suggest)}`}
                className="text-xs font-medium underline"
              >
                {verifyFailed.suggestName
                  ? t('verify.suggest', { name: verifyFailed.suggestName })
                  : t('verify.suggestOther')}
              </Link>
            )}
            {verifyFailed.kind !== 'invalid_input' && (
              <button type="button" onClick={() => saveAnyway(false)} className="text-xs underline">
                {t('verify.saveAnyway')}
              </button>
            )}
          </div>
        </div>
      )}
      {error && (
        planLimit && planLimit.message === error ? (
          <PlanLimitNotice limit={planLimit} />
        ) : isTrialLimitMessage(error) ? (
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
          {!f.required && <span className="ml-1 font-normal text-[var(--text-3)]">{t('field.optional')}</span>}
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
            placeholder={storedSecrets.includes(f.name) ? t('field.stored') : (f.example ?? '')}
            onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
            onBlur={() => completeAddress(f)}
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
              {show ? t('field.hide') : t('field.show')}
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
                  {t('field.open')}
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
        ? t('actions.install', { name: info.name })
        : isOAuth
          ? t('actions.checkAndSignIn', { name: short })
          : existingId
            ? t('actions.checkAndSave')
            : t('actions.checkAndConnect');

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
              <summary className="cursor-pointer text-sm text-[var(--text-2)]">{t('advanced')}</summary>
              <div className="mt-3 space-y-3">{extraAdvanced.map(renderField)}</div>
            </details>
          )}
          {waiting && (
            <GuideWaitPanel
              name={short}
              status={providerCheck.checking ? 'checking' : providerReady === true ? 'ready' : connectorId ? 'waiting' : 'checking'}
              checkedAt={providerCheck.at}
              error={connectorId ? providerCheck.error : t('guide.keysFirst')}
              onCheck={() => void recheck()}
              onReenterKeys={() => goTo(at - 1)}
            />
          )}
          {isLast && isOAuth && (
            <p className="text-xs text-[var(--text-3)]">
              {t('guide.oauthNext', { name: short })}
            </p>
          )}
          {checkOutcome}
        </GuideStepView>

        <div className="space-y-2 border-t border-[var(--border)] pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={() => goTo(previous)} disabled={working}>
              {t('guide.back')}
            </Button>
            <Button onClick={next} disabled={working || needsTick || waitBlocks}>
              {working
                ? t('guide.checking')
                : isLast
                  ? finishLabel
                  : step.saveAndCheck
                    ? t('guide.saveAndCheck', { name: short })
                    : t('guide.continue')}
            </Button>
            <span className="ml-auto">
              <StuckLink name={info.name} />
            </span>
          </div>
          {needsTick && <p className="text-xs text-[var(--text-3)]">{t('guide.tickHint')}</p>}
          {waitBlocks && <p className="text-xs text-[var(--text-3)]">{t('guide.waitHint', { name: short })}</p>}
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
              {existingId ? t('title.finish', { name: info.name }) : t('title.setUp', { name: info.name })}
            </h1>
            <p className="text-sm text-[var(--text-2)]">{info.description}</p>
            {info.setupGuide && (
              <button type="button" onClick={() => setMode('guide')} className="mt-1 text-xs text-[var(--text-3)] underline hover:text-[var(--text)]">
                {t('useGuide')}
              </button>
            )}
          </div>
        </div>

        {info.prerequisites && (
          <div className="rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm text-[var(--text-2)]">
            <p className="mb-1 font-medium text-[var(--text)]">{t('beforeStart')}</p>
            <div className="prose prose-sm max-w-none text-[13px] leading-relaxed dark:prose-invert [&_p]:my-1">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{info.prerequisites}</ReactMarkdown>
            </div>
          </div>
        )}

        {info.requiresIpAllowlist && <NetworkNote ips={info.egressIps ?? []} name={info.name} required />}

        {isOAuth && selfRegisteringBridge && (
          <div className="rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm text-[var(--text-2)]">
            <p>{t('oauth.selfRegistering', { name: info.name.split(' ')[0] })}</p>
          </div>
        )}

        {isOAuth && !selfRegisteringBridge && (
          <div className="rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm text-[var(--text-2)]">
            <p>{t('oauth.ownApp', { name: info.name.split(' ')[0] })}</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded bg-[var(--surface)] px-2 py-1 font-mono text-xs text-[var(--text)]">{redirectUri ?? '…'}</code>
              {redirectUri && (
                <Button size="sm" variant="secondary" onClick={() => void copyText(redirectUri)}>
                  {t('copy')}
                </Button>
              )}
            </div>
          </div>
        )}

        {info.setupKind === 'none' && (
          <p className="text-sm text-[var(--text-2)]">{t('noInput')}</p>
        )}

        {metaFlavour && (
          <div className="rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm text-[var(--text-2)]">
            <div className="flex flex-col gap-1">
              {(['signin', 'paste'] as const).map((mode) => (
                <label key={mode} className="flex items-center gap-2 text-[var(--text)]">
                  <input
                    type="radio"
                    name="meta-mode"
                    checked={metaMode === mode}
                    onChange={() => {
                      setMetaMode(mode);
                      setFieldErrors({});
                    }}
                  />
                  {mode === 'signin'
                    ? t('metaLogin.modeSignIn', { provider: metaProvider })
                    : t('metaLogin.modePaste')}
                </label>
              ))}
            </div>
            {metaSignIn && metaPlatform?.[metaFlavour] && (
              <>
                <p className="mt-2">{t('metaLogin.serverApp')}</p>
                <label className="mt-2 flex items-center gap-2 text-[var(--text)]">
                  <input
                    type="checkbox"
                    checked={ownMetaApp}
                    onChange={(e) => {
                      setOwnMetaApp(e.target.checked);
                      setFieldErrors({});
                    }}
                  />
                  {t('metaLogin.useOwn')}
                </label>
              </>
            )}
            {metaSignIn && !serverMetaApp && metaPlatform?.redirectUrl && (
              <>
                <p className="mt-2 text-xs">{t('metaLogin.ownHint')}</p>
                <div className="mt-1 flex items-center gap-2">
                  <code className="flex-1 overflow-x-auto rounded bg-[var(--surface)] px-2 py-1 font-mono text-xs text-[var(--text)]">
                    {metaPlatform.redirectUrl}
                  </code>
                  <Button size="sm" variant="secondary" onClick={() => void copyText(metaPlatform.redirectUrl)}>
                    {t('copy')}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {isTikTokShop && tiktokPlatform?.available && (
          <div className="rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm text-[var(--text-2)]">
            <p>{t('tiktokShopApp.serverApp')}</p>
            <label className="mt-2 flex items-center gap-2 text-[var(--text)]">
              <input
                type="checkbox"
                checked={ownTikTokApp}
                onChange={(e) => {
                  setOwnTikTokApp(e.target.checked);
                  setFieldErrors({});
                }}
              />
              {t('tiktokShopApp.useOwn')}
            </label>
            {ownTikTokApp && tiktokPlatform.redirectUrl && (
              <>
                <p className="mt-2 text-xs">{t('tiktokShopApp.ownHint')}</p>
                <div className="mt-1 flex items-center gap-2">
                  <code className="flex-1 overflow-x-auto rounded bg-[var(--surface)] px-2 py-1 font-mono text-xs text-[var(--text)]">
                    {tiktokPlatform.redirectUrl}
                  </code>
                  <Button size="sm" variant="secondary" onClick={() => void copyText(tiktokPlatform.redirectUrl)}>
                    {t('copy')}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {GROUPS.map((kind) => {
          const group = visibleFields.filter((f) => f.kind === kind);
          if (group.length === 0) return null;
          return (
            <fieldset key={kind} className="space-y-3">
              <legend className="mb-1 text-xs font-semibold uppercase tracking-[0.06em] text-[var(--text-3)]">{t(`groups.${kind}`)}</legend>
              {group.map(renderField)}
            </fieldset>
          );
        })}

        {advancedFields.length > 0 && (
          <details className="rounded-[9px] border border-[var(--border)] p-3">
            <summary className="cursor-pointer text-sm text-[var(--text-2)]">{t('advanced')}</summary>
            <div className="mt-3 space-y-3">{advancedFields.map(renderField)}</div>
          </details>
        )}

        {checkOutcome}

        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={verifyAndSave} disabled={working}>
            {working ? t('working') : primaryLabel}
          </Button>
          {info.setupKind !== 'none' && !existingId && (
            <button type="button" onClick={() => saveAnyway(true)} disabled={working} className="text-sm text-[var(--text-3)] underline hover:text-[var(--text)]">
              {t('saveDraft')}
            </button>
          )}
        </div>
        {info.setupKind !== 'none' && !existingId && (
          <p className="text-xs text-[var(--text-3)]">
            {t('draftHint')}
          </p>
        )}

        {!info.requiresIpAllowlist && <NetworkNote ips={info.egressIps ?? []} name={info.name} />}
      </Card>

      {info.instructions && (
        <Card className="p-6">
          <details>
            <summary className="cursor-pointer text-sm font-medium text-[var(--text)]">{t('stepByStep')}</summary>
            <div className="prose prose-sm mt-3 max-w-none text-[13px] leading-relaxed dark:prose-invert [&_pre]:whitespace-pre-wrap [&_pre]:break-words">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{info.instructions}</ReactMarkdown>
            </div>
          </details>
        </Card>
      )}
    </div>
  );
}

/** The seller's own TikTok Shop app, as the catalog adapter names its variables. */
const TIKTOK_SHOP_APP_VARS: readonly string[] = ['TIKTOK_SHOP_APP_KEY', 'TIKTOK_SHOP_APP_SECRET', 'TIKTOK_SHOP_SERVICE_ID'];

/** What an Instagram sign-in fills in; hidden on the form while signing in. */
const META_SIGN_IN_VARS: readonly string[] = ['INSTAGRAM_ACCESS_TOKEN', 'INSTAGRAM_ACCOUNT_ID'];
/** The app of your own for each Instagram sign-in, as the catalog adapters name it. */
const META_FACEBOOK_APP_VARS: readonly string[] = ['META_APP_ID', 'META_APP_SECRET', 'META_CONFIG_ID'];
const META_INSTAGRAM_APP_VARS: readonly string[] = ['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET'];

/** A setup page's draft that the "Switch to …" button may replace: old adapter → new adapter. */
const REPLACEABLE_DRAFTS: Readonly<Record<string, string>> = { odoo: 'odoo-jsonrpc' };

export default function ConnectorSetupPage() {
  const t = useTranslations('connectorSetup');
  return (
    <AppShell>
      <div className="mx-auto w-full max-w-2xl p-4 sm:p-6">
        <Suspense fallback={<p className="text-sm text-[var(--text-2)]">{t('loading')}</p>}>
          <SetupContent />
        </Suspense>
      </div>
    </AppShell>
  );
}
