'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/lib/auth-context';
import {
  ApiError,
  fileSearch,
  license,
  mcpServers,
  productEvents,
  type FileSearchBudget,
  type FileSearchCapabilities,
  type FileSearchProtocol,
  type FileSearchScan,
  type FileSourceTestResult,
  type McpServer,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { FILE_SEARCH_ENTRY_POINTS, fileCountBucket, isFileSearchSlug } from '@/lib/file-search-catalog';
import {
  BudgetBar,
  FolderTree,
  LockedCard,
  TestChecklist,
  formatBytes,
  formatNumber,
  hintClass,
  inputClass,
  intervalLabel,
  labelClass,
} from '@/components/file-search/shared';

/**
 * File Search setup wizard (#1385): Source → Test → Scan → Describe →
 * Activate. Nothing is saved before the connection test passes; the scan
 * shows what is in the folder and whether it fits the plan before anything
 * is indexed. The URL keeps the draft and the step (?id=…&step=3), so a
 * reload or the Back button lands where the admin was.
 */

type Step = 1 | 2 | 3 | 4 | 5;

interface Preset {
  id: string;
  protocol: FileSearchProtocol;
  port?: number;
  url?: string;
  rootPath?: string;
}

const PRESETS: Preset[] = [
  { id: 'nextcloud', protocol: 'webdav', url: 'https://cloud.example.com/remote.php/dav/files/USER/' },
  { id: 'owncloud', protocol: 'webdav', url: 'https://owncloud.example.com/remote.php/dav/files/USER/' },
  { id: 'synology', protocol: 'sftp', port: 22 },
  { id: 'qnap', protocol: 'sftp', port: 22 },
  { id: 'fritzbox', protocol: 'ftps', port: 21 },
  { id: 'hetzner', protocol: 'sftp', port: 23 },
];

const PROTOCOL_CARDS: Array<{ id: FileSearchProtocol; group: 'sftp' | 'ftp' | 'webdav' | 'local' | 's3' }> = [
  { id: 'sftp', group: 'sftp' },
  { id: 'ftps', group: 'ftp' },
  { id: 'webdav', group: 'webdav' },
  { id: 'local', group: 'local' },
  { id: 's3', group: 's3' },
];

interface Form {
  name: string;
  protocol: FileSearchProtocol;
  host: string;
  port: string;
  url: string;
  username: string;
  password: string;
  privateKey: string;
  passphrase: string;
  rootPath: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  allowPlainFtp: boolean;
  hostKeySha256: string;
  tlsFingerprintSha256: string;
  authMode: 'password' | 'key';
}

const EMPTY: Form = {
  name: '',
  protocol: 'sftp',
  host: '',
  port: '',
  url: '',
  username: '',
  password: '',
  privateKey: '',
  passphrase: '',
  rootPath: '/',
  bucket: '',
  region: '',
  accessKeyId: '',
  secretAccessKey: '',
  allowPlainFtp: false,
  hostKeySha256: '',
  tlsFingerprintSha256: '',
  authMode: 'password',
};

function configOf(f: Form): Record<string, unknown> {
  const c: Record<string, unknown> = { protocol: f.protocol, rootPath: f.rootPath || '/' };
  if (f.protocol === 'webdav' || f.protocol === 's3') c.url = f.url.trim();
  if (f.protocol === 's3') {
    c.bucket = f.bucket.trim();
    if (f.region.trim()) c.region = f.region.trim();
  }
  if (f.protocol !== 'local' && f.protocol !== 's3') c.username = f.username.trim();
  if (['sftp', 'ftp', 'ftps', 'ftps-implicit'].includes(f.protocol)) {
    c.host = f.host.trim();
    if (f.port.trim()) c.port = Number(f.port);
  }
  if (f.protocol === 'ftp') c.allowPlainFtp = f.allowPlainFtp;
  if (f.hostKeySha256) c.hostKeySha256 = f.hostKeySha256;
  if (f.tlsFingerprintSha256) c.tlsFingerprintSha256 = f.tlsFingerprintSha256;
  return c;
}

function secretsOf(f: Form): Record<string, string> {
  const s: Record<string, string> = {};
  if (f.protocol === 's3') {
    if (f.accessKeyId) s.accessKeyId = f.accessKeyId;
    if (f.secretAccessKey) s.secretAccessKey = f.secretAccessKey;
    return s;
  }
  if (f.authMode === 'key' && f.protocol === 'sftp') {
    if (f.privateKey) s.privateKey = f.privateKey;
    if (f.passphrase) s.passphrase = f.passphrase;
  } else if (f.password) s.password = f.password;
  return s;
}

function errMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

// Keep in sync with TEXT_EXTENSIONS in packages/backend/src/file-search/file-search.types.ts.
const TYPE_FILTERS: Array<{ id: string; exts: string[] }> = [
  { id: 'pdf', exts: ['.pdf', '.xps', '.oxps'] },
  { id: 'excel', exts: ['.xlsx', '.xlsm', '.xltx', '.xltm', '.xlsb', '.xls', '.ods', '.ots', '.numbers', '.csv', '.tsv'] },
  { id: 'word', exts: ['.docx', '.docm', '.dotx', '.dotm', '.doc', '.odt', '.ott', '.rtf', '.pages', '.epub'] },
  { id: 'powerpoint', exts: ['.pptx', '.pptm', '.ppsx', '.ppsm', '.potx', '.potm', '.ppt', '.odp', '.otp', '.key'] },
  { id: 'email', exts: ['.msg', '.eml', '.mbox'] },
  { id: 'text', exts: ['.txt', '.md', '.json', '.xml', '.log', '.html', '.htm'] },
  { id: 'drawing', exts: ['.svg', '.dxf'] },
  {
    id: 'code',
    exts: [
      '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties', '.sql', '.tex', '.bib',
      '.srt', '.vtt', '.ics', '.vcf', '.kml', '.gpx',
      '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.java', '.kt', '.kts', '.c', '.h',
      '.cpp', '.hpp', '.cc', '.cs', '.go', '.rb', '.php', '.sh', '.bash', '.ps1', '.bat', '.cmd',
      '.swift', '.rs', '.r', '.scala', '.vb', '.vbs', '.pl', '.lua', '.css', '.scss', '.less',
      '.sass', '.gradle', '.groovy', '.dart', '.m', '.asm',
    ],
  },
];

export default function FileSearchWizardPage() {
  return (
    <Suspense fallback={null}>
      <Wizard />
    </Suspense>
  );
}

function Wizard() {
  const t = useTranslations('fileSearch');
  const locale = useLocale();
  const router = useRouter();
  const params = useSearchParams();
  const { token, user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';

  const [caps, setCaps] = useState<FileSearchCapabilities | null>(null);
  const [capsError, setCapsError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>(() => (Number(params.get('step')) as Step) || 1);
  const [draftId, setDraftId] = useState<string | null>(params.get('id'));
  const [form, setForm] = useState<Form>(() => {
    // A catalog entry for a product (Nextcloud, Synology…) opens with its preset.
    const preset = PRESETS.find((p) => p.id === params.get('preset'));
    if (preset) return { ...EMPTY, protocol: preset.protocol, port: preset.port ? String(preset.port) : '', url: preset.url ?? '' };
    return { ...EMPTY, protocol: (params.get('protocol') as FileSearchProtocol) || 'sftp' };
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<FileSourceTestResult | null>(null);
  const [fpChecked, setFpChecked] = useState(false);
  const [scanId, setScanId] = useState<string | null>(null);
  const [scan, setScan] = useState<FileSearchScan | null>(null);
  const [useAi, setUseAi] = useState(true);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [typeFilter, setTypeFilter] = useState<Set<string>>(new Set());
  const [maxAge, setMaxAge] = useState<number>(0);
  const [budget, setBudget] = useState<FileSearchBudget | null>(null);
  const [summary, setSummary] = useState('');
  const [instructions, setInstructions] = useState('');
  const [toolPrefix, setToolPrefix] = useState('');
  const [interval, setIntervalMin] = useState(1440);
  const [ocr, setOcr] = useState(false);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [serverIds, setServerIds] = useState<Set<string>>(new Set());
  const headingRef = useRef<HTMLHeadingElement>(null);

  // ── Product events (file_search_* in product-event.service.ts) ──────────
  // Where the wizard was opened from, read once: the URL is rewritten to
  // ?step=…&protocol=… right after the first render.
  const origin = useRef({
    preset: PRESETS.some((p) => p.id === params.get('preset')) ? params.get('preset')! : undefined,
    adapterSlug: isFileSearchSlug(params.get('adapter') ?? '') ? params.get('adapter')! : undefined,
    via: (FILE_SEARCH_ENTRY_POINTS as readonly string[]).includes(params.get('from') ?? '') ? params.get('from')! : undefined,
    resumed: !!params.get('id'),
  });
  const reported = useRef(new Set<string>());
  /** Scans started on this page: a resumed draft's old scan is not reported again. */
  const startedScans = useRef(new Set<string>());
  // Protocol, preset and catalog entry only: never a host, path or file name.
  const track = useCallback(
    (event: string, extra: Record<string, string> = {}) => {
      if (!token) return;
      const { preset, adapterSlug } = origin.current;
      productEvents.track(event, token, {
        protocol: form.protocol,
        ...(preset ? { preset } : {}),
        ...(adapterSlug ? { adapterSlug } : {}),
        ...extra,
      });
    },
    [token, form.protocol],
  );
  /** The same event once per page load (`key` tells kinds apart). */
  const trackOnce = useCallback(
    (key: string, event: string, extra?: Record<string, string>) => {
      if (reported.current.has(key)) return;
      reported.current.add(key);
      track(event, extra);
    },
    [track],
  );

  const loadCaps = useCallback(async () => {
    if (!token) return;
    try {
      const c = await fileSearch.capabilities(token);
      setCaps(c);
      if (c.ai.available && c.ai.allowedByPolicy) setUseAi(true);
      else setUseAi(false);
      if (c.access.allowed) setIntervalMin(Math.max(1440, c.access.quota.minIntervalMinutes));
      // A protocol this server does not offer (a network folder on the Cloud) falls back to SFTP.
      setForm((f) => (c.protocols.includes(f.protocol) ? f : { ...f, protocol: 'sftp' }));
    } catch (e) {
      setCapsError(errMessage(e));
    }
  }, [token]);

  useEffect(() => {
    void loadCaps();
  }, [loadCaps]);

  useEffect(() => {
    if (!token) return;
    mcpServers
      .list(token)
      .then((list) => {
        setServers(list);
        if (list.length === 1) setServerIds(new Set([list[0].id]));
      })
      .catch(() => undefined);
  }, [token]);

  // Keep the step and draft in the URL.
  useEffect(() => {
    const q = new URLSearchParams();
    if (draftId) q.set('id', draftId);
    q.set('step', String(step));
    if (!draftId) q.set('protocol', form.protocol);
    router.replace(`/connectors/new/file-search?${q.toString()}`, { scroll: false });
    headingRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, draftId]);

  // Resume a draft: load its settings and last scan.
  useEffect(() => {
    if (!token || !draftId) return;
    fileSearch
      .overview(draftId, token)
      .then((o) => {
        const c = o.config;
        setForm((f) => ({
          ...f,
          name: o.connector.name,
          protocol: c.protocol,
          host: c.host ?? '',
          port: c.port ? String(c.port) : '',
          url: c.url ?? '',
          username: c.username ?? '',
          rootPath: c.rootPath ?? '/',
          bucket: c.bucket ?? '',
          region: c.region ?? '',
          allowPlainFtp: !!c.allowPlainFtp,
          hostKeySha256: c.hostKeySha256 ?? '',
          tlsFingerprintSha256: c.tlsFingerprintSha256 ?? '',
        }));
        setToolPrefix(c.toolPrefix);
        if (o.lastScan) setScanId(o.lastScan.id);
      })
      .catch((e) => setError(errMessage(e)));
  }, [token, draftId]);

  // Poll the scan while it runs.
  useEffect(() => {
    if (!token || !draftId || !scanId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const s = await fileSearch.scan(draftId, scanId, token);
        if (stop) return;
        setScan(s);
        if (s.budget) setBudget(s.budget);
        if (s.status === 'done') {
          setExcluded(new Set(s.selection.excludeFolders));
          setMaxAge(s.selection.maxAgeYears ?? 0);
          if (s.selection.extensions?.length) {
            setTypeFilter(new Set(TYPE_FILTERS.filter((g) => g.exts.some((e) => s.selection.extensions!.includes(e))).map((g) => g.id)));
          }
          if (s.description) {
            setSummary((v) => v || s.description!.summary);
            setInstructions((v) => v || s.description!.instructions);
          }
          if (s.suggestions?.toolPrefix) setToolPrefix((v) => v || s.suggestions!.toolPrefix);
          return;
        }
        if (s.status === 'failed' || s.status === 'cancelled') return;
        timer = setTimeout(tick, 1500);
      } catch (e) {
        setError(errMessage(e));
      }
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [token, draftId, scanId]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (k !== 'name') setTestResult(null);
  };

  const applyPreset = (p: Preset) => {
    setForm((f) => ({ ...f, protocol: p.protocol, port: p.port ? String(p.port) : '', url: p.url ?? f.url, hostKeySha256: '', tlsFingerprintSha256: '' }));
    setTestResult(null);
  };

  const runTest = async (override?: Partial<Form>) => {
    if (!token) return;
    const f = { ...form, ...override };
    setBusy(true);
    setError(null);
    try {
      const r = await fileSearch.test({ config: configOf(f), secrets: secretsOf(f), ...(draftId ? { connectorId: draftId } : {}) }, token);
      setTestResult(r);
      setFpChecked(false);
      // A first test that only asks to confirm the fingerprint is neither.
      if (r.errorKind !== 'fingerprint_unconfirmed') {
        if (r.ok) trackOnce('test_passed', 'file_search_test_passed');
        else track('file_search_test_failed', { kind: r.errorKind ?? 'unknown' });
      }
    } catch (e) {
      setError(errMessage(e));
      track('file_search_test_failed', { kind: 'request_failed' });
    } finally {
      setBusy(false);
    }
  };

  const confirmFingerprint = async () => {
    if (!testResult?.fingerprint) return;
    const patch: Partial<Form> =
      testResult.fingerprint.kind === 'ssh-host-key' ? { hostKeySha256: testResult.fingerprint.sha256 } : { tlsFingerprintSha256: testResult.fingerprint.sha256 };
    setForm((f) => ({ ...f, ...patch }));
    await runTest(patch);
  };

  const needsFingerprint = !!testResult?.fingerprint && testResult.errorKind === 'fingerprint_unconfirmed';
  const testPassed = !!testResult?.ok && !needsFingerprint;

  const saveDraft = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const name = form.name.trim() || t('defaultName');
      if (draftId) {
        await fileSearch.updateSource(draftId, { name, config: configOf(form), secrets: secretsOf(form) }, token);
      } else {
        const d = await fileSearch.createDraft({ name, config: configOf(form), secrets: secretsOf(form) }, token);
        setDraftId(d.id);
        setToolPrefix(String((d.config as { toolPrefix?: string }).toolPrefix ?? ''));
      }
      setStep(3);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const startScan = async () => {
    if (!token || !draftId) return;
    setBusy(true);
    setError(null);
    setScan(null);
    setBudget(null);
    setSummary('');
    setInstructions('');
    try {
      const s = await fileSearch.startScan(draftId, useAi, token);
      startedScans.current.add(s.id);
      setScanId(s.id);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // Selection → budget (debounced).
  const selectionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pushSelection = useCallback(
    (ex: Set<string>, types: Set<string>, age: number) => {
      if (!token || !draftId) return;
      if (selectionTimer.current) clearTimeout(selectionTimer.current);
      selectionTimer.current = setTimeout(async () => {
        try {
          const extensions = TYPE_FILTERS.filter((g) => types.has(g.id)).flatMap((g) => g.exts);
          const r = await fileSearch.setSelection(draftId, { excludeFolders: [...ex], extensions, maxAgeYears: age || undefined, scanId: scanId ?? undefined }, token);
          if (r.budget) setBudget(r.budget);
        } catch (e) {
          setError(errMessage(e));
        }
      }, 350);
    },
    [token, draftId, scanId],
  );

  const toggleFolder = (path: string, include: boolean) => {
    const next = new Set(excluded);
    if (include) {
      next.delete(path);
      for (const p of [...next]) if (p.startsWith(path + '/')) next.delete(p);
    } else next.add(path);
    setExcluded(next);
    pushSelection(next, typeFilter, maxAge);
  };

  const toggleType = (id: string) => {
    const next = new Set(typeFilter);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setTypeFilter(next);
    pushSelection(excluded, next, maxAge);
  };

  const regenerate = async () => {
    if (!token || !draftId || !scanId) return;
    setBusy(true);
    try {
      await fileSearch.redescribe(draftId, scanId, useAi, token);
      setSummary('');
      setInstructions('');
      setScan((s) => (s ? { ...s, status: 'describing' } : s));
      // Restart polling.
      setScanId(null);
      setTimeout(() => setScanId(scanId), 50);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const activate = async () => {
    if (!token || !draftId) return;
    setBusy(true);
    setError(null);
    try {
      if (ocr) await fileSearch.updateSource(draftId, { config: { ocr: true } }, token);
      await fileSearch.activate(
        draftId,
        { instructions, summary, toolPrefix: toolPrefix || undefined, syncIntervalMinutes: interval, mcpServerIds: [...serverIds] },
        token,
      );
      trackOnce('activated', 'file_search_activated', { files: fileCountBucket(budget?.files ?? scan?.totals?.files ?? 0) });
      router.push(`/connectors/${draftId}?tab=files`);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const startTrial = async () => {
    if (!token) return;
    setBusy(true);
    try {
      await license.startBusinessTrial(token);
      await loadCaps();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const upgradeHref = (source: string) => `/settings/license?source=${source}`;

  const protocolOk = useMemo(() => {
    const f = form;
    if (f.protocol === 'local') return !!f.rootPath && f.rootPath !== '/';
    if (f.protocol === 'webdav') return /^https?:\/\//.test(f.url) && !!f.username;
    if (f.protocol === 's3') return /^https?:\/\//.test(f.url) && !!f.bucket && !!f.accessKeyId && !!f.secretAccessKey;
    const auth = f.authMode === 'key' && f.protocol === 'sftp' ? !!f.privateKey : !!f.password || !!draftId;
    return !!f.host && !!f.username && auth && (f.protocol !== 'ftp' || f.allowPlainFtp);
  }, [form, draftId]);

  const steps: Array<{ n: Step; label: string }> = [
    { n: 1, label: t('steps.source') },
    { n: 2, label: t('steps.test') },
    { n: 3, label: t('steps.scan') },
    { n: 4, label: t('steps.describe') },
    { n: 5, label: t('steps.activate') },
  ];

  const atConnectorLimit =
    !draftId && !!caps && caps.access.allowed && caps.access.quota.maxConnectors != null && caps.usage.connectors >= caps.access.quota.maxConnectors;

  useEffect(() => {
    // A resumed draft (?id=…) is not a new setup.
    if (!token || origin.current.resumed) return;
    const { via } = origin.current;
    trackOnce('opened', 'file_search_wizard_opened', via ? { via } : {});
  }, [token, trackOnce]);

  useEffect(() => {
    if (!caps) return;
    if (!caps.access.allowed) {
      trackOnce(`locked:${caps.access.reason}`, 'file_search_locked_shown', { kind: caps.access.reason });
    } else if (isAdmin && atConnectorLimit) {
      trackOnce('locked:connector_limit', 'file_search_locked_shown', { kind: 'connector_limit' });
    }
  }, [caps, isAdmin, atConnectorLimit, trackOnce]);

  useEffect(() => {
    if (!scan || !startedScans.current.has(scan.id)) return;
    if (scan.status === 'done') {
      trackOnce(`scan:${scan.id}`, 'file_search_scan_finished', {
        kind: scan.budget ? (scan.budget.fits ? 'fits' : 'over_plan') : 'done',
        files: fileCountBucket(scan.totals?.files ?? 0),
      });
    } else if (scan.status === 'failed') {
      trackOnce(`scan:${scan.id}`, 'file_search_scan_finished', { kind: 'failed' });
    }
  }, [scan, trackOnce]);

  const scanning = scan && ['queued', 'running', 'describing', 'describing_running'].includes(scan.status);
  const describing = scan && ['describing', 'describing_running'].includes(scan.status);

  return (
    <AppShell backTo={{ label: t('back'), href: '/connectors/new' }} title={t('title')} subtitle={t('subtitle')} maxWidth={920}>
      <div className="mx-auto w-full max-w-[920px] space-y-5">
        {!caps && !capsError && <p className="text-[13px] text-[var(--text-3)]">{t('loading')}</p>}
        {capsError && <p className="text-[13px] text-[var(--danger)]">{capsError}</p>}

        {caps && !caps.access.allowed && <LockedCard access={caps.access} onStartTrial={isAdmin ? startTrial : undefined} busy={busy} />}

        {caps && caps.access.allowed && !caps.worker.ok && (
          <Card className="border-[var(--danger)] p-4 text-[13px] text-[var(--text)]">
            <strong>{t('worker.down')}</strong> {t('worker.downHint')}
          </Card>
        )}

        {caps && caps.access.allowed && !isAdmin && <Card className="p-4 text-[13px]">{t('adminOnly')}</Card>}

        {/* The connector limit is known up front: say so before the admin fills in anything. */}
        {caps && caps.access.allowed && isAdmin && atConnectorLimit && (
          <Card className="space-y-3 p-5">
            <h2 className="text-[15px] font-semibold text-[var(--text)]">{t('limit.title')}</h2>
            <p className="text-[13px] leading-[1.55] text-[var(--text-2)]">
              {t('limit.text', { max: caps.access.quota.maxConnectors ?? 0, plan: caps.access.plan })}
              {caps.access.next ? ` ${t('limit.next', { plan: caps.access.next.plan, max: caps.access.next.quota.maxConnectors ?? '∞' })}` : ''}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Link href={upgradeHref('file_quota_setup')} className="inline-flex h-9 items-center justify-center rounded-[9px] bg-[var(--brand)] px-3.5 text-[13px] font-semibold text-[var(--primary-foreground)]">{t('upgrade')}</Link>
              <Link href="/connectors" className="inline-flex h-9 items-center justify-center rounded-[9px] border border-[var(--border)] px-3.5 text-[13px] font-semibold text-[var(--text-2)]">{t('limit.manage')}</Link>
            </div>
          </Card>
        )}

        {caps && caps.access.allowed && isAdmin && !atConnectorLimit && (
          <>
            {/* Stepper */}
            <nav aria-label={t('steps.label')} className="scrollbar-none -mx-1 overflow-x-auto px-1">
              <ol className="flex min-w-max items-center gap-1.5 sm:gap-2">
                {steps.map((s, i) => (
                  <li key={s.n} className="flex items-center gap-1.5 sm:gap-2">
                    <span
                      aria-current={s.n === step ? 'step' : undefined}
                      className={cn(
                        'flex items-center gap-2 rounded-full border px-2.5 py-1 text-[12.5px]',
                        s.n === step
                          ? 'border-[var(--brand)] bg-[var(--brand-tint)] font-semibold text-[var(--brand)]'
                          : s.n < step
                            ? 'border-[var(--border)] text-[var(--text-2)]'
                            : 'border-[var(--border)] text-[var(--text-3)]',
                      )}
                    >
                      <span className="tabular-nums">{s.n < step ? '✓' : s.n}</span>
                      {/* On phones only the current step is named; the others are numbers. */}
                      <span className={s.n === step ? '' : 'sr-only sm:not-sr-only'}>{s.label}</span>
                    </span>
                    {i < steps.length - 1 && <span aria-hidden className="h-px w-3 bg-[var(--border)] sm:w-5" />}
                  </li>
                ))}
              </ol>
            </nav>

            <h2 ref={headingRef} tabIndex={-1} className="text-[16px] font-semibold text-[var(--text)] outline-none">
              {steps[step - 1].label}
            </h2>

            {error && (
              <div role="alert" className="rounded-[10px] border border-[var(--danger)] bg-[var(--t-danger-bg)] px-3.5 py-2.5 text-[13px] text-[var(--text)]">
                {error}
              </div>
            )}

            {/* ── Step 1: Source ─────────────────────────────────────── */}
            {step === 1 && (
              <Card className="space-y-5 p-4 sm:p-6">
                <div>
                  <span className={labelClass}>{t('source.protocol')}</span>
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                    {PROTOCOL_CARDS.filter((p) => caps.protocols.includes(p.id)).map((p) => {
                      const active =
                        form.protocol === p.id ||
                        (p.id === 'ftps' && ['ftp', 'ftps', 'ftps-implicit'].includes(form.protocol));
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => set('protocol', p.id)}
                          aria-pressed={active}
                          className={cn(
                            'rounded-[12px] border p-3.5 text-left transition-colors',
                            active ? 'border-[var(--brand)] bg-[var(--brand-tint)]' : 'border-[var(--border)] hover:border-[var(--border-strong)]',
                          )}
                        >
                          <div className="text-[13.5px] font-semibold text-[var(--text)]">{t(`protocols.${p.group}.title`)}</div>
                          <div className="mt-1 text-[12px] leading-[1.45] text-[var(--text-3)]">{t(`protocols.${p.group}.description`)}</div>
                        </button>
                      );
                    })}
                  </div>
                  {caps.cloud && <p className={hintClass}>{t('source.cloudNote')}</p>}
                </div>

                {form.protocol !== 'local' && form.protocol !== 's3' && (
                  <div>
                    <span className={labelClass}>{t('source.presets')}</span>
                    <div className="flex flex-wrap gap-2">
                      {PRESETS.map((p) => (
                        <button key={p.id} type="button" onClick={() => applyPreset(p)} className="rounded-full border border-[var(--border)] px-3 py-1 text-[12.5px] text-[var(--text-2)] hover:border-[var(--brand)] hover:text-[var(--brand)]">
                          {t(`presets.${p.id}`)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <label className={labelClass} htmlFor="fs-name">{t('source.name')}</label>
                    <input id="fs-name" className={inputClass} value={form.name} placeholder={t('source.namePlaceholder')} onChange={(e) => set('name', e.target.value)} />
                    <p className={hintClass}>{t('source.nameHint')}</p>
                  </div>

                  {['ftp', 'ftps', 'ftps-implicit'].includes(form.protocol) && (
                    <div className="sm:col-span-2">
                      <span className={labelClass}>{t('source.ftpMode')}</span>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        {(['ftps', 'ftps-implicit', 'ftp'] as const).map((m) => (
                          <label key={m} className="flex min-h-[36px] items-center gap-2 rounded-[9px] border border-[var(--border)] px-3 text-[13px]">
                            <input type="radio" name="ftp-mode" checked={form.protocol === m} onChange={() => set('protocol', m)} className="accent-[var(--brand)]" />
                            {t(`ftpModes.${m}`)}
                          </label>
                        ))}
                      </div>
                    </div>
                  )}

                  {['sftp', 'ftp', 'ftps', 'ftps-implicit'].includes(form.protocol) && (
                    <>
                      <div>
                        <label className={labelClass} htmlFor="fs-host">{t('source.host')}</label>
                        <input id="fs-host" className={inputClass} value={form.host} placeholder="files.example.com" autoComplete="off" onChange={(e) => set('host', e.target.value)} />
                      </div>
                      <div>
                        <label className={labelClass} htmlFor="fs-port">{t('source.port')}</label>
                        <input
                          id="fs-port"
                          className={inputClass}
                          inputMode="numeric"
                          value={form.port}
                          placeholder={form.protocol === 'sftp' ? '22' : form.protocol === 'ftps-implicit' ? '990' : '21'}
                          onChange={(e) => set('port', e.target.value.replace(/\D/g, ''))}
                        />
                      </div>
                    </>
                  )}

                  {(form.protocol === 'webdav' || form.protocol === 's3') && (
                    <div className="sm:col-span-2">
                      <label className={labelClass} htmlFor="fs-url">{form.protocol === 'webdav' ? t('source.webdavUrl') : t('source.s3Endpoint')}</label>
                      <input
                        id="fs-url"
                        className={inputClass}
                        value={form.url}
                        placeholder={form.protocol === 'webdav' ? 'https://cloud.example.com/remote.php/dav/files/USER/' : 'https://fra1.digitaloceanspaces.com'}
                        onChange={(e) => set('url', e.target.value)}
                      />
                      {form.protocol === 'webdav' && <p className={hintClass}>{t('source.webdavHint')}</p>}
                    </div>
                  )}

                  {form.protocol === 's3' && (
                    <>
                      <div>
                        <label className={labelClass} htmlFor="fs-bucket">{t('source.bucket')}</label>
                        <input id="fs-bucket" className={inputClass} value={form.bucket} onChange={(e) => set('bucket', e.target.value)} />
                      </div>
                      <div>
                        <label className={labelClass} htmlFor="fs-region">{t('source.region')}</label>
                        <input id="fs-region" className={inputClass} value={form.region} placeholder="eu-central-1" onChange={(e) => set('region', e.target.value)} />
                      </div>
                      <div>
                        <label className={labelClass} htmlFor="fs-ak">{t('source.accessKey')}</label>
                        <input id="fs-ak" className={inputClass} value={form.accessKeyId} autoComplete="off" onChange={(e) => set('accessKeyId', e.target.value)} />
                      </div>
                      <div>
                        <label className={labelClass} htmlFor="fs-sk">{t('source.secretKey')}</label>
                        <input id="fs-sk" type="password" className={inputClass} value={form.secretAccessKey} autoComplete="new-password" onChange={(e) => set('secretAccessKey', e.target.value)} />
                      </div>
                    </>
                  )}

                  {form.protocol !== 'local' && form.protocol !== 's3' && (
                    <>
                      <div>
                        <label className={labelClass} htmlFor="fs-user">{t('source.username')}</label>
                        <input id="fs-user" className={inputClass} value={form.username} autoComplete="off" onChange={(e) => set('username', e.target.value)} />
                      </div>
                      {form.protocol === 'sftp' && (
                        <div>
                          <span className={labelClass}>{t('source.authMode')}</span>
                          <div className="flex gap-2">
                            {(['password', 'key'] as const).map((m) => (
                              <label key={m} className="flex h-9 flex-1 items-center gap-2 rounded-[9px] border border-[var(--border)] px-3 text-[13px]">
                                <input type="radio" name="auth-mode" checked={form.authMode === m} onChange={() => set('authMode', m)} className="accent-[var(--brand)]" />
                                {t(`authModes.${m}`)}
                              </label>
                            ))}
                          </div>
                        </div>
                      )}
                      {form.authMode === 'key' && form.protocol === 'sftp' ? (
                        <>
                          <div className="sm:col-span-2">
                            <label className={labelClass} htmlFor="fs-key">{t('source.privateKey')}</label>
                            <textarea id="fs-key" className={cn(inputClass, 'h-28 py-2 font-mono text-[12px]')} value={form.privateKey} onChange={(e) => set('privateKey', e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
                          </div>
                          <div>
                            <label className={labelClass} htmlFor="fs-pass">{t('source.passphrase')}</label>
                            <input id="fs-pass" type="password" className={inputClass} value={form.passphrase} autoComplete="new-password" onChange={(e) => set('passphrase', e.target.value)} />
                          </div>
                        </>
                      ) : (
                        <div className={form.protocol === 'sftp' ? 'sm:col-span-2' : ''}>
                          <label className={labelClass} htmlFor="fs-pw">{t('source.password')}</label>
                          <input
                            id="fs-pw"
                            type="password"
                            className={inputClass}
                            value={form.password}
                            autoComplete="new-password"
                            placeholder={draftId ? t('source.passwordKeep') : ''}
                            onChange={(e) => set('password', e.target.value)}
                          />
                          {form.protocol === 'webdav' && <p className={hintClass}>{t('source.appPasswordHint')}</p>}
                        </div>
                      )}
                    </>
                  )}

                  <div className="sm:col-span-2">
                    <label className={labelClass} htmlFor="fs-root">{form.protocol === 'local' ? t('source.localFolder') : t('source.folder')}</label>
                    {form.protocol === 'local' ? (
                      <>
                        <input id="fs-root" className={inputClass} list="fs-roots" value={form.rootPath} onChange={(e) => set('rootPath', e.target.value)} placeholder={caps.localRoots[0] ?? '/mnt/share'} />
                        <datalist id="fs-roots">{caps.localRoots.map((r) => <option key={r} value={r} />)}</datalist>
                        <p className={hintClass}>
                          {caps.localRoots.length ? t('source.localRoots', { roots: caps.localRoots.join(', ') }) : t('source.noLocalRoots')}
                        </p>
                      </>
                    ) : (
                      <>
                        <input id="fs-root" className={inputClass} value={form.rootPath} placeholder="/Pricelists" onChange={(e) => set('rootPath', e.target.value)} />
                        <p className={hintClass}>{t('source.folderHint')}</p>
                      </>
                    )}
                  </div>

                  {form.protocol === 'ftp' && (
                    <label className="flex items-start gap-2.5 rounded-[10px] border border-[var(--t-warn-fg)] bg-[var(--t-warn-bg)] p-3 text-[13px] text-[var(--text)] sm:col-span-2">
                      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--brand)]" checked={form.allowPlainFtp} onChange={(e) => set('allowPlainFtp', e.target.checked)} />
                      <span>{t('source.plainFtpWarning')}</span>
                    </label>
                  )}
                </div>

                <div className="flex flex-col-reverse gap-2 border-t border-[var(--border)] pt-4 sm:flex-row sm:justify-end">
                  <Link href="/connectors/new" className="inline-flex h-9 items-center justify-center rounded-[9px] px-3.5 text-[13px] text-[var(--text-2)] hover:text-[var(--text)]">
                    {t('cancel')}
                  </Link>
                  <Button disabled={!protocolOk} onClick={() => { setStep(2); void runTest(); }}>
                    {t('source.next')}
                  </Button>
                </div>
              </Card>
            )}

            {/* ── Step 2: Test ───────────────────────────────────────── */}
            {step === 2 && (
              <Card className="space-y-5 p-4 sm:p-6">
                <p className="text-[13px] text-[var(--text-2)]">{t('test.intro')}</p>
                {busy && !testResult && <p className="text-[13px] text-[var(--text-3)]" role="status">{t('test.running')}</p>}
                {testResult && (
                  <div className="space-y-4">
                    <TestChecklist result={testResult} />
                    {testResult.ok && !needsFingerprint && (
                      <div className="rounded-[10px] bg-[var(--t-success-bg)] p-3 text-[13px] text-[var(--text)]">
                        <strong>{t('test.ok', { n: testResult.rootEntries ?? 0 })}</strong>
                        {!!testResult.sample?.length && (
                          <div className="mt-1.5 break-words font-mono text-[12px] text-[var(--text-2)]">{testResult.sample.join(' · ')}</div>
                        )}
                      </div>
                    )}
                    {/* The failing step already carries the message; show it separately only when no step does. */}
                    {!testResult.ok && testResult.errorKind !== 'fingerprint_unconfirmed' && !testResult.steps.some((st) => !st.ok && st.detail) && (
                      <div role="alert" className="rounded-[10px] bg-[var(--t-danger-bg)] p-3 text-[13px] text-[var(--text)]">{testResult.message}</div>
                    )}
                    {needsFingerprint && testResult.fingerprint && (
                      <div className="rounded-[12px] border border-[var(--brand)] p-4">
                        <div className="text-[13.5px] font-semibold text-[var(--text)]">{t('fingerprint.title')}</div>
                        <p className="mt-1 text-[13px] leading-[1.55] text-[var(--text-2)]">
                          {testResult.fingerprint.kind === 'ssh-host-key' ? t('fingerprint.ssh') : t('fingerprint.tls')}
                        </p>
                        <code className="mt-3 block break-all rounded-[8px] bg-[var(--surface-2)] p-2.5 font-mono text-[12.5px] text-[var(--text)]">{testResult.fingerprint.sha256}</code>
                        <label className="mt-3 flex items-start gap-2.5 text-[13px]">
                          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--brand)]" checked={fpChecked} onChange={(e) => setFpChecked(e.target.checked)} />
                          <span>{t('fingerprint.confirmLabel')}</span>
                        </label>
                        <Button className="mt-3 w-full sm:w-auto" disabled={!fpChecked || busy} onClick={confirmFingerprint}>
                          {t('fingerprint.confirm')}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
                <div className="flex flex-col-reverse gap-2 border-t border-[var(--border)] pt-4 sm:flex-row sm:justify-between">
                  <Button variant="ghost" onClick={() => setStep(1)}>{t('backStep')}</Button>
                  <div className="flex flex-col-reverse gap-2 sm:flex-row">
                    <Button variant="secondary" disabled={busy} onClick={() => runTest()}>{t('test.again')}</Button>
                    <Button disabled={!testPassed || busy} onClick={saveDraft}>{t('test.next')}</Button>
                  </div>
                </div>
              </Card>
            )}

            {/* ── Step 3: Scan ───────────────────────────────────────── */}
            {step === 3 && (
              <Card className="space-y-5 p-4 sm:p-6">
                {!scan && !scanId && (
                  <div className="space-y-4">
                    <p className="text-[13px] leading-[1.55] text-[var(--text-2)]">{t('scan.intro')}</p>
                    {caps.ai.available && caps.ai.allowedByPolicy ? (
                      <label className="flex items-start gap-2.5 rounded-[10px] border border-[var(--border)] p-3 text-[13px]">
                        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--brand)]" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} />
                        <span>
                          <span className="font-medium text-[var(--text)]">{t('scan.useAi')}</span>
                          <span className="mt-0.5 block text-[12.5px] text-[var(--text-3)]">
                            {t('scan.aiConsent', { provider: `${caps.ai.provider ?? ''}${caps.ai.model ? ` / ${caps.ai.model}` : ''}` })}
                          </span>
                        </span>
                      </label>
                    ) : (
                      <p className={hintClass}>{caps.ai.available ? t('scan.aiPolicyOff') : t('scan.aiUnavailable')}</p>
                    )}
                    <Button onClick={startScan} disabled={busy} className="w-full sm:w-auto">{t('scan.start')}</Button>
                  </div>
                )}

                {scanning && !describing && (
                  <div role="status" aria-live="polite" className="space-y-2">
                    <div className="text-[13.5px] font-medium text-[var(--text)]">{t(`scan.phase.${scan?.progress?.phase ?? 'connecting'}`)}</div>
                    <div className="text-[13px] text-[var(--text-2)]">
                      {t('scan.progress', { files: formatNumber(scan?.progress?.files ?? 0, locale), dirs: formatNumber(scan?.progress?.dirs ?? 0, locale) })}
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--border)]"><div className="h-full w-1/3 animate-pulse rounded-full bg-[var(--brand)]" /></div>
                    <Button variant="ghost" size="sm" onClick={() => draftId && scanId && token && fileSearch.cancelScan(draftId, scanId, token).then(() => { setScanId(null); setScan(null); })}>
                      {t('scan.cancel')}
                    </Button>
                  </div>
                )}

                {scan?.status === 'failed' && (
                  <div className="space-y-3">
                    <div role="alert" className="rounded-[10px] bg-[var(--t-danger-bg)] p-3 text-[13px]">{scan.error}</div>
                    <Button onClick={startScan}>{t('scan.retry')}</Button>
                  </div>
                )}

                {scan && (scan.status === 'done' || describing) && scan.tree && scan.totals && (
                  <div className="space-y-5">
                    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      {[
                        [t('scan.stats.files'), formatNumber(scan.totals.files, locale)],
                        [t('scan.stats.folders'), formatNumber(scan.totals.dirs, locale)],
                        [t('scan.stats.size'), formatBytes(scan.totals.bytes)],
                        [t('scan.stats.years'), scan.totals.oldest && scan.totals.newest ? `${scan.totals.oldest.slice(0, 4)}–${scan.totals.newest.slice(0, 4)}` : '—'],
                      ].map(([k, v]) => (
                        <div key={k} className="rounded-[10px] bg-[var(--surface-2)] p-3">
                          <dt className="text-[11.5px] uppercase tracking-[0.04em] text-[var(--text-3)]">{k}</dt>
                          <dd className="mt-0.5 text-[16px] font-semibold tabular-nums text-[var(--text)]">{v}</dd>
                        </div>
                      ))}
                    </dl>
                    {scan.truncated && <p className="text-[12.5px] text-[var(--t-warn-fg)]">{t('scan.truncated')}</p>}
                    {budget && <BudgetBar budget={budget} onUpgrade={() => router.push(upgradeHref('file_quota_setup'))} />}
                    <div>
                      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-[13px] font-semibold text-[var(--text)]">{t('scan.folders')}</span>
                        {!!scan.suggestions?.excludeFolders.length && (
                          <span className="text-[12px] text-[var(--text-3)]">{t('scan.archivesUnticked', { n: scan.suggestions.excludeFolders.length })}</span>
                        )}
                      </div>
                      <FolderTree root={scan.tree} excluded={excluded} onToggle={toggleFolder} />
                    </div>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_200px]">
                      <div>
                        <span className={labelClass}>{t('scan.types')}</span>
                        <div className="flex flex-wrap gap-2">
                          {TYPE_FILTERS.map((g) => {
                            const n = Object.entries(scan.types ?? {}).filter(([e]) => g.exts.includes(e)).reduce((a, [, v]) => a + v.files, 0);
                            if (!n) return null;
                            const on = typeFilter.size === 0 || typeFilter.has(g.id);
                            return (
                              <button
                                key={g.id}
                                type="button"
                                aria-pressed={typeFilter.has(g.id)}
                                onClick={() => toggleType(g.id)}
                                className={cn('rounded-full border px-3 py-1 text-[12.5px]', on && typeFilter.size ? 'border-[var(--brand)] bg-[var(--brand-tint)] text-[var(--brand)]' : 'border-[var(--border)] text-[var(--text-2)]')}
                              >
                                {t(`typeGroups.${g.id}`)} · {formatNumber(n, locale)}
                              </button>
                            );
                          })}
                        </div>
                        <p className={hintClass}>{t('scan.typesHint')}</p>
                      </div>
                      <div>
                        <label className={labelClass} htmlFor="fs-age">{t('scan.age')}</label>
                        <select id="fs-age" className={inputClass} value={maxAge} onChange={(e) => { const v = Number(e.target.value); setMaxAge(v); pushSelection(excluded, typeFilter, v); }}>
                          <option value={0}>{t('scan.ageAll')}</option>
                          {[1, 2, 3, 5, 10].map((y) => <option key={y} value={y}>{t('scan.ageYears', { n: y })}</option>)}
                        </select>
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex flex-col-reverse gap-2 border-t border-[var(--border)] pt-4 sm:flex-row sm:justify-between">
                  <Button variant="ghost" onClick={() => setStep(2)}>{t('backStep')}</Button>
                  <div className="flex flex-col-reverse gap-2 sm:flex-row">
                    {scan?.status === 'done' && <Button variant="secondary" onClick={startScan} disabled={busy}>{t('scan.again')}</Button>}
                    <Button disabled={!scan || scan.status !== 'done' || !budget?.fits} onClick={() => setStep(4)}>{t('scan.next')}</Button>
                  </div>
                </div>
              </Card>
            )}

            {/* ── Step 4: Describe ───────────────────────────────────── */}
            {step === 4 && (
              <Card className="space-y-5 p-4 sm:p-6">
                <p className="text-[13px] leading-[1.55] text-[var(--text-2)]">{t('describe.intro')}</p>
                {describing && <p role="status" className="text-[13px] text-[var(--text-3)]">{t('describe.writing')}</p>}
                {scan?.description && !describing && (
                  <p className="text-[12px] text-[var(--text-3)]">
                    {scan.description.source === 'ai' ? t('describe.byAi', { model: scan.description.model ?? '' }) : t('describe.byRules')}
                  </p>
                )}
                <div>
                  <label className={labelClass} htmlFor="fs-summary">{t('describe.summary')}</label>
                  <input id="fs-summary" className={inputClass} maxLength={160} value={summary} onChange={(e) => setSummary(e.target.value)} />
                  <p className={hintClass}>{t('describe.summaryHint', { n: 160 - summary.length })}</p>
                </div>
                <div>
                  <label className={labelClass} htmlFor="fs-instr">{t('describe.instructions')}</label>
                  <textarea id="fs-instr" className={cn(inputClass, 'h-64 py-2 leading-[1.5]')} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
                  <p className={hintClass}>{t('describe.instructionsHint')}</p>
                </div>
                {!!scan?.description?.terms.length && (
                  <div>
                    <span className={labelClass}>{t('describe.terms')}</span>
                    <div className="flex flex-wrap gap-1.5">
                      {scan.description.terms.map((w) => (
                        <button key={w} type="button" onClick={() => setSummary((s) => (s.includes(w) ? s : `${s}${s ? ', ' : ''}${w}`).slice(0, 160))} className="rounded-full bg-[var(--surface-2)] px-2.5 py-0.5 text-[12px] text-[var(--text-2)] hover:text-[var(--brand)]">
                          + {w}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="rounded-[10px] bg-[var(--surface-2)] p-3">
                  <div className="text-[11.5px] uppercase tracking-[0.04em] text-[var(--text-3)]">{t('describe.preview')}</div>
                  <div className="mt-1 break-words font-mono text-[12px] text-[var(--text)]">
                    {(toolPrefix || 'files')}_search — {t('describe.previewText', { name: form.name || t('defaultName'), summary: summary || '…' })}
                  </div>
                </div>
                {!!scan?.description?.examplePrompts.length && (
                  <div>
                    <span className={labelClass}>{t('describe.prompts')}</span>
                    <ul className="space-y-1 text-[13px] text-[var(--text-2)]">{scan.description.examplePrompts.map((p) => <li key={p}>“{p}”</li>)}</ul>
                  </div>
                )}
                <div className="flex flex-col-reverse gap-2 border-t border-[var(--border)] pt-4 sm:flex-row sm:justify-between">
                  <Button variant="ghost" onClick={() => setStep(3)}>{t('backStep')}</Button>
                  <div className="flex flex-col-reverse gap-2 sm:flex-row">
                    {caps.ai.available && caps.ai.allowedByPolicy && (
                      <label className="flex h-9 items-center gap-2 text-[12.5px] text-[var(--text-2)]">
                        <input type="checkbox" className="accent-[var(--brand)]" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} /> {t('describe.withAi')}
                      </label>
                    )}
                    <Button variant="secondary" onClick={regenerate} disabled={busy || !!describing}>{t('describe.regenerate')}</Button>
                    <Button disabled={!instructions.trim() || !!describing} onClick={() => setStep(5)}>{t('describe.next')}</Button>
                  </div>
                </div>
              </Card>
            )}

            {/* ── Step 5: Activate ───────────────────────────────────── */}
            {step === 5 && (
              <Card className="space-y-5 p-4 sm:p-6">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className={labelClass} htmlFor="fs-prefix">{t('activate.prefix')}</label>
                    <input id="fs-prefix" className={cn(inputClass, 'font-mono')} value={toolPrefix} onChange={(e) => setToolPrefix(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 30))} />
                    <p className={hintClass}>{t('activate.prefixHint', { example: `${toolPrefix || 'files'}_search` })}</p>
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="fs-interval">{t('activate.interval')}</label>
                    <select id="fs-interval" className={inputClass} value={interval} onChange={(e) => setIntervalMin(Number(e.target.value))}>
                      {caps.intervals.map((m) => {
                        const allowed = caps.access.allowed && m >= caps.access.quota.minIntervalMinutes;
                        return (
                          <option key={m} value={m} disabled={!allowed}>
                            {intervalLabel(m, t)}{allowed ? '' : ` — ${t('activate.higherPlan')}`}
                          </option>
                        );
                      })}
                    </select>
                    <p className={hintClass}>{t('activate.intervalHint')}</p>
                  </div>
                </div>
                {caps.access.allowed && caps.access.quota.ocr && caps.worker.ocr && (
                  <label className="flex items-start gap-2.5 rounded-[10px] border border-[var(--border)] p-3 text-[13px]">
                    <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--brand)]" checked={ocr} onChange={(e) => setOcr(e.target.checked)} />
                    <span>
                      <span className="font-medium text-[var(--text)]">{t('activate.ocr')}</span>
                      <span className="mt-0.5 block text-[12.5px] text-[var(--text-3)]">{t('activate.ocrHint')}</span>
                    </span>
                  </label>
                )}
                <fieldset>
                  <legend className={labelClass}>{t('activate.servers')}</legend>
                  {servers.length ? (
                    <div className="space-y-1.5">
                      {servers.map((s) => (
                        <label key={s.id} className="flex min-h-[36px] items-center gap-2.5 rounded-[9px] border border-[var(--border)] px-3 text-[13px]">
                          <input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" checked={serverIds.has(s.id)} onChange={(e) => setServerIds((x) => { const n = new Set(x); if (e.target.checked) n.add(s.id); else n.delete(s.id); return n; })} />
                          {s.name}
                        </label>
                      ))}
                    </div>
                  ) : (
                    <p className={hintClass}>{t('activate.noServers')}</p>
                  )}
                  <p className={hintClass}>{t('activate.serversHint')}</p>
                </fieldset>
                {budget && (
                  <p className="text-[13px] text-[var(--text-2)]">
                    {t('activate.summary', { files: formatNumber(budget.files, locale), size: formatBytes(budget.bytes), interval: intervalLabel(interval, t) })}
                  </p>
                )}
                <div className="flex flex-col-reverse gap-2 border-t border-[var(--border)] pt-4 sm:flex-row sm:justify-between">
                  <Button variant="ghost" onClick={() => setStep(4)}>{t('backStep')}</Button>
                  <Button onClick={activate} disabled={busy || !toolPrefix}>{busy ? t('activate.activating') : t('activate.cta')}</Button>
                </div>
              </Card>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
