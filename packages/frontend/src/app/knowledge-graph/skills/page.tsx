'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import {
  knowledgeGraph,
  mcpServers as mcpServersApi,
  connectors as connectorsApi,
  tools as toolsApi,
  type KgSkill,
  type KgSkillVersion,
  type KnowledgeFolder,
} from '@/lib/api';
import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge, type Tone } from '@/components/ui/badge';
import { ActionMenu } from '@/components/ui/action-menu';
import {
  KnowledgeFolderTree,
  folderOptions,
  useKnowledgeFolders,
  type FolderSelection,
} from '@/components/knowledge-folders';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 25;

const TABS: Array<{ key: string; label: string; countKey: 'pending' | 'applied' | 'dismissed' | null }> = [
  { key: '', label: 'All', countKey: null },
  { key: 'pending', label: 'Suggested', countKey: 'pending' },
  { key: 'applied', label: 'Active', countKey: 'applied' },
  { key: 'dismissed', label: 'Dismissed', countKey: 'dismissed' },
];

const inputCls =
  'w-full h-[38px] px-3 rounded-[9px] text-[13px] bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] placeholder:text-[var(--text-3)] outline-none focus:border-[var(--border-strong)]';
const textareaCls =
  'w-full px-3 py-2.5 rounded-[9px] text-[13px] bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] placeholder:text-[var(--text-3)] outline-none focus:border-[var(--border-strong)] leading-relaxed';

export default function SkillsPage() {
  const { token, user } = useAuth();
  const [items, setItems] = useState<KgSkill[]>([]);
  const [counts, setCounts] = useState({ pending: 0, applied: 0, dismissed: 0 });
  const [total, setTotal] = useState(0);
  const [servers, setServers] = useState<Array<{ id: string; name: string }>>([]);
  const [connectorList, setConnectorList] = useState<Array<{ id: string; name: string }>>([]);
  const [target, setTarget] = useState<string>(''); // '' = connectors, else mcpServerId
  const [statusFilter, setStatusFilter] = useState<string>(''); // tab
  const [folderSel, setFolderSel] = useState<FolderSelection>('');
  const { folders, restrictionsAvailable, reload: reloadFolders } = useKnowledgeFolders(token);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [consolidating, setConsolidating] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [status, setStatus] = useState('');
  const isAdmin = user?.role === 'ADMIN';
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    if (!token) return;
    setLoading(true);
    knowledgeGraph.skills
      .list(token, {
        status: statusFilter || undefined,
        q: debouncedQuery || undefined,
        take: PAGE_SIZE,
        skip: page * PAGE_SIZE,
        folderId: folderSel || undefined,
      })
      .then((r) => {
        setItems(r.items);
        setCounts(r.counts);
        setTotal(r.total);
      })
      .catch((e) => setStatus(e.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, [token, statusFilter, debouncedQuery, page, folderSel]);

  useEffect(() => load(), [load]);
  useEffect(() => {
    if (!token) return;
    mcpServersApi.list(token).then((s: any[]) => setServers(s.map((x) => ({ id: x.id, name: x.name })))).catch(() => {});
    connectorsApi.list(token).then((c: any[]) => setConnectorList(c.map((x) => ({ id: x.id, name: x.name })))).catch(() => {});
  }, [token]);

  // Debounce the search box → commit to debouncedQuery (which load depends on)
  const onSearch = (v: string) => {
    setQuery(v);
    setPage(0);
  };
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setDebouncedQuery(query), 250);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query]);

  const generate = async () => {
    if (!token) return;
    setGenerating(true);
    setStatus(target ? 'Analyzing the server context…' : 'Analyzing captured intents…');
    try {
      const r = await knowledgeGraph.skills.generate(token, target || undefined);
      setStatus(r.created > 0 ? `Generated ${r.created} suggestion(s).` : 'No new patterns found yet.');
      setPage(0);
      load();
    } catch (e: any) {
      setStatus(e.message || 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  const consolidate = async () => {
    if (!token) return;
    setConsolidating(true);
    setStatus('Consolidating active skills with AI…');
    try {
      const r = await knowledgeGraph.skills.consolidate(token, target || undefined);
      setStatus(
        r.proposed
          ? `Proposed ${r.proposed} merged skill(s) replacing ${r.replaced} active ones. Review them under Suggested: applying one deactivates the skills it replaces.`
          : `Nothing to merge (${r.before} active skill(s)).`,
      );
      load();
    } catch (e: any) {
      setStatus(e.message || 'Consolidation failed');
    } finally {
      setConsolidating(false);
    }
  };

  const [learning, setLearning] = useState(false);
  const learnFromErrors = async () => {
    if (!token) return;
    setLearning(true);
    setStatus('Looking for calls that failed and were fixed…');
    try {
      const r = await knowledgeGraph.skills.proposeFromErrors(token);
      setStatus(
        r.created
          ? `Proposed ${r.created} skill(s) from fixed errors. Review them under Suggested.`
          : 'No recurring fixed errors yet. Only calls of users who contribute to skill learning are used.',
      );
      setStatusFilter('pending');
      setPage(0);
      load();
    } catch (e: any) {
      setStatus(e.message || 'Could not look at the errors');
    } finally {
      setLearning(false);
    }
  };

  const onChanged = () => load();
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);
  const everEmpty = counts.pending + counts.applied + counts.dismissed === 0;
  const scopeLabel = target
    ? (servers.find((x) => x.id === target)?.name ?? 'this server')
    : 'connectors';

  return (
    <AppShell
      backTo={{ label: 'Knowledge Graph', href: '/knowledge-graph' }}
      title="AI Skills"
      maxWidth={1120}
      actions={
        isAdmin && (
          <div className="flex flex-wrap items-center gap-2">
            {/* Scope for the two AI actions beside it. It sizes to its own
                content instead of claiming a whole row on a phone. */}
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="h-9 min-w-0 max-w-[48vw] truncate px-2.5 rounded-[9px] text-[12.5px] bg-[var(--surface)] border border-[var(--border)] text-[var(--text-2)] hover:border-[var(--border-strong)] outline-none md:max-w-none"
              title="Scope for Generate / Consolidate"
              aria-label="Scope for Generate and Consolidate"
            >
              <option value="">From connectors</option>
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  For server: {s.name}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              size="sm"
              onClick={consolidate}
              disabled={consolidating || generating}
              title="Merge the active skills in this scope into fewer, non-redundant ones"
              className="max-md:hidden"
            >
              <ConsolidateIcon />
              {consolidating ? 'Consolidating…' : 'Consolidate'}
            </Button>
            <Button variant="secondary" size="sm" onClick={generate} disabled={generating || consolidating} className="max-md:hidden">
              <GenerateIcon />
              {generating ? 'Generating…' : 'Generate with AI'}
            </Button>
            {/* On a phone the two AI actions fold into a menu, and the label
                repeats the scope the select beside it is set to, so the menu
                entry states what it will act on. */}
            <ActionMenu
              className="md:hidden"
              label="Skill actions"
              items={[
                {
                  label: generating ? 'Generating…' : `Generate with AI · ${scopeLabel}`,
                  icon: <GenerateIcon />,
                  onSelect: generate,
                  disabled: generating || consolidating,
                },
                {
                  label: consolidating ? 'Consolidating…' : `Consolidate · ${scopeLabel}`,
                  icon: <ConsolidateIcon />,
                  onSelect: consolidate,
                  disabled: consolidating || generating,
                },
                {
                  label: learning ? 'Looking…' : 'Learn from fixed errors',
                  icon: <GenerateIcon />,
                  onSelect: learnFromErrors,
                  disabled: learning,
                },
              ]}
            />
            <Button variant="primary" size="sm" onClick={() => setShowNew((v) => !v)}>
              {showNew ? (
                'Close'
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  New skill
                </>
              )}
            </Button>
          </div>
        )
      }
    >
      {/* The header already carries the way back to the graph, so this stays
          a description and nothing else. */}
      <p className="text-[13px] leading-relaxed text-[var(--text-2)] mb-4">
        Rules and procedures for recurring tasks, scoped to one connector or to a whole MCP
        server. <span className="text-[var(--text)]">Active</span> skills reach that server&apos;s AI
        clients on connect, as full text or as a list they open with{' '}
        <code className="font-mono text-[12px]">skill_get</code> (set per server). Long procedures
        are always opened on demand.
      </p>
      {isAdmin && (
        <div className="mb-3 flex flex-wrap items-center gap-2.5 max-md:hidden">
          <Button variant="secondary" size="sm" onClick={learnFromErrors} disabled={learning}>
            {learning ? 'Looking…' : 'Learn from fixed errors'}
          </Button>
          <span className="text-[12px] text-[var(--text-3)]">
            Proposes a rule when calls failed and worked after an argument changed format. No AI model needed.
          </span>
        </div>
      )}
      {status && <p className="text-[12px] text-[var(--text-3)] mb-3">{status}</p>}

      <div className="grid gap-4 md:grid-cols-[230px_minmax(0,1fr)]">
      <aside className="md:sticky md:top-4 md:self-start">
        <KnowledgeFolderTree
          token={token!}
          kind="skill"
          folders={folders}
          restrictionsAvailable={restrictionsAvailable}
          selected={folderSel}
          onSelect={(f) => {
            setFolderSel(f);
            setPage(0);
          }}
          canEdit={isAdmin || user?.role === 'EDITOR'}
          isAdmin={isAdmin}
          onChanged={() => {
            reloadFolders();
            load();
          }}
        />
      </aside>
      <div className="min-w-0">
      {isAdmin && showNew && (
        <NewSkillForm
          token={token!}
          servers={servers}
          connectors={connectorList}
          folders={folders}
          defaultFolderId={folderSel && folderSel !== 'none' ? folderSel : ''}
          onCreated={() => {
            setShowNew(false);
            setStatus('Skill created (live for MCP).');
            setPage(0);
            load();
            reloadFolders();
          }}
        />
      )}

      {everEmpty && !loading ? (
        <Card className="p-6 text-center">
          <p className="text-[13px] font-medium text-[var(--text-2)]">No skills yet</p>
          <p className="mx-auto mt-1.5 max-w-[46ch] text-[13px] leading-relaxed text-[var(--text-3)]">
            {isAdmin ? (
              <>
                Skills are generated from captured intents. Turn on{' '}
                <Link href="/settings/organization" className="text-[var(--brand)] hover:underline">
                  Capture user intent and AI enrichment
                </Link>
                , let some tool calls run, then use Generate with AI.
              </>
            ) : (
              'They are generated from captured tool-call intents. Ask an admin to generate them.'
            )}
          </p>
        </Card>
      ) : (
        <>
          {/* Status tabs with counts + search */}
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="inline-flex p-[3px] rounded-[10px] border border-[var(--border)] gap-0.5">
              {TABS.map((t) => {
                const n = t.countKey ? counts[t.countKey] : counts.pending + counts.applied + counts.dismissed;
                const activeTab = statusFilter === t.key;
                return (
                  <button
                    key={t.key}
                    onClick={() => {
                      setStatusFilter(t.key);
                      setPage(0);
                    }}
                    className={cn(
                      'px-3 py-1.5 rounded-[7px] text-[12.5px] font-medium transition-colors',
                      activeTab
                        ? 'bg-[var(--brand)] text-[var(--primary-foreground)]'
                        : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]',
                    )}
                  >
                    {t.label}
                    <span className={cn('ml-1.5 text-[11px]', activeTab ? 'opacity-90' : 'opacity-70')}>{n}</span>
                  </button>
                );
              })}
            </div>
            <input
              value={query}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="Search skills…"
              className={cn(inputCls, 'w-full sm:w-56')}
            />
          </div>

          {loading ? (
            <p className="text-[13px] text-[var(--text-3)]">Loading…</p>
          ) : items.length === 0 ? (
            <Card className="p-6 text-center text-[13px] text-[var(--text-3)]">
              No skills match this filter.
            </Card>
          ) : (
            <div className="flex flex-col gap-2.5">
              {items.map((s) => (
                <SkillCard
                  key={s.id}
                  s={s}
                  isAdmin={isAdmin}
                  token={token!}
                  folders={folders}
                  onChanged={() => {
                    onChanged();
                    reloadFolders();
                  }}
                />
              ))}
            </div>
          )}

          {/* Pagination */}
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-between mt-4 text-[13px]">
              <span className="text-[var(--text-3)]">
                {from}–{to} of {total}
              </span>
              <div className="flex items-center gap-2.5">
                <Button
                  variant="secondary"
                  size="md"
                  disabled={page === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  ← Prev
                </Button>
                <span className="text-[var(--text-3)]">
                  Page {page + 1} / {totalPages}
                </span>
                <Button
                  variant="secondary"
                  size="md"
                  disabled={page + 1 >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next →
                </Button>
              </div>
            </div>
          )}
        </>
      )}
      </div>
      </div>
    </AppShell>
  );
}

function SkillCard({
  s,
  isAdmin,
  token,
  folders,
  onChanged,
}: {
  s: KgSkill;
  isAdmin: boolean;
  token: string;
  folders: KnowledgeFolder[];
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [folderId, setFolderId] = useState(s.folderId ?? '');
  const folderPath = folders.find((f) => f.id === s.folderId)?.path;
  const [title, setTitle] = useState(s.title);
  const [whenToUse, setWhenToUse] = useState(s.whenToUse);
  const [instruction, setInstruction] = useState(s.instruction);
  const [procedure, setProcedure] = useState(s.body ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [history, setHistory] = useState<KgSkillVersion[] | null>(null);
  const [historyError, setHistoryError] = useState('');

  const toggleHistory = async () => {
    if (history) {
      setHistory(null);
      return;
    }
    setHistoryError('');
    try {
      setHistory(await knowledgeGraph.skills.versions(token, s.id));
    } catch (e: any) {
      setHistoryError(e.message || 'Could not load the history');
    }
  };

  const scope = s.mcpServer?.name
    ? `server: ${s.mcpServer.name}`
    : s.connector?.name
      ? `connector: ${s.connector.name}`
      : 'workspace';

  const statusMeta: { label: string; tone: Tone } =
    s.status === 'applied'
      ? { label: 'Active', tone: 'success' }
      : s.status === 'dismissed'
        ? { label: 'Dismissed', tone: 'neutral' }
        : { label: 'Suggested', tone: 'info' };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  // A code-tool proposal from an agent: not a skill. It is inert until an admin
  // creates the tool through the normal tool-creation path (which re-checks the
  // plan cap and, if the admin later elevates it, Enterprise/admin authority).
  if (s.kind === 'code') {
    const p = s.payload;
    const createTool = async () => {
      if (!p) return;
      setBusy(true);
      setErr('');
      try {
        await toolsApi.create(
          p.connectorId,
          {
            name: p.name,
            description: p.description,
            parameters: p.parameters,
            endpointMapping: p.endpointMapping,
          },
          token,
        );
        // Mark the proposal handled so it leaves the pending list. `apply`
        // refuses a code proposal on purpose, so set the status directly.
        await knowledgeGraph.skills.update(token, s.id, { status: 'applied' });
        onChanged();
      } catch (e: any) {
        setErr(e?.message || 'Could not create the tool.');
      } finally {
        setBusy(false);
      }
    };
    return (
      <Card className={cn('px-[18px] py-4', s.status === 'dismissed' && 'opacity-60')}>
        <div className="flex items-start justify-between gap-3 mb-2.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap mb-0.5">
              <span className="text-[14px] font-semibold text-[var(--text)]">{s.title}</span>
              <Badge tone="warn" className="rounded-full px-2 py-[2px]">
                Code tool proposal
              </Badge>
              <Badge tone={statusMeta.tone} className="rounded-full px-2 py-[2px]">
                {s.status === 'applied' ? 'Created' : statusMeta.label}
              </Badge>
            </div>
            <p className="text-[11.5px] text-[var(--text-3)]">
              {scope} · proposed by an agent · read-only, runs with the caller&apos;s permissions
            </p>
          </div>
          {isAdmin && (
            <div className="flex gap-1.5 flex-shrink-0">
              {s.status !== 'applied' && (
                <Button
                  size="sm"
                  disabled={busy || !p}
                  onClick={createTool}
                  className="h-[30px] px-[11px] bg-[var(--ok)] text-[var(--ok-foreground)] hover:opacity-90"
                >
                  Create tool
                </Button>
              )}
              {s.status !== 'dismissed' && s.status !== 'applied' && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => run(() => knowledgeGraph.skills.dismiss(token, s.id))}
                  className="h-[30px] px-[11px]"
                >
                  Dismiss
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                title="Delete"
                aria-label="Delete proposal"
                onClick={() => run(() => knowledgeGraph.skills.remove(token, s.id))}
                className="h-[30px] w-[30px] p-0 text-[var(--danger)]"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                </svg>
              </Button>
            </div>
          )}
        </div>
        {s.instruction && (
          <p className="text-[13px] leading-[1.55] mb-1 text-[var(--text)]">
            <span className="text-[var(--text-3)]">Why:</span> {s.instruction}
          </p>
        )}
        {p && (
          <>
            <p className="text-[13px] leading-[1.55] text-[var(--text)]">
              <span className="text-[var(--text-3)]">Does:</span> {p.description}
            </p>
            <details className="mt-2" open>
              <summary className="cursor-pointer text-[12.5px] text-[var(--text-2)]">
                Program ({p.endpointMapping.code.length.toLocaleString()} characters)
              </summary>
              <pre className="mt-2 overflow-auto rounded-md bg-[var(--surface-2)] p-3 text-[12px] leading-[1.5] text-[var(--text)]">
                {p.endpointMapping.code}
              </pre>
            </details>
            <p className="mt-2 text-[12px] text-[var(--text-3)]">
              Creating it adds a read-only code tool on {s.connector?.name ?? 'the connector'}. To let it write
              data or run with the author&apos;s rights, edit it afterwards on the connector&apos;s tools page.
            </p>
          </>
        )}
        {err && <p className="mt-2 text-[12px] text-[var(--danger)]">{err}</p>}
      </Card>
    );
  }

  if (editing) {
    return (
      <Card className="p-4">
        <div className="flex flex-col gap-2.5">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={cn(inputCls, 'h-9 bg-[var(--surface-2)]')}
            placeholder="Title"
          />
          <input
            value={whenToUse}
            onChange={(e) => setWhenToUse(e.target.value)}
            className={cn(inputCls, 'h-9 bg-[var(--surface-2)]')}
            placeholder="When to use"
          />
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={3}
            className={cn(textareaCls, 'bg-[var(--surface-2)]')}
            placeholder="Instruction"
          />
          <textarea
            value={procedure}
            onChange={(e) => setProcedure(e.target.value)}
            rows={6}
            maxLength={20000}
            className={cn(textareaCls, 'bg-[var(--surface-2)] font-mono text-[12.5px]')}
            placeholder="Full procedure (optional, markdown): steps, field rules, output format. Opened on demand with skill_get."
          />
          {folders.length > 0 && (
            <select
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
              className={cn(inputCls, 'h-9 bg-[var(--surface-2)]')}
              aria-label="Folder"
            >
              {folderOptions(folders).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.value ? `Folder: ${o.label}` : 'No folder'}
                </option>
              ))}
            </select>
          )}
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await knowledgeGraph.skills.update(token, s.id, {
                    title,
                    whenToUse,
                    instruction,
                    body: procedure.trim() ? procedure : null,
                    ...(folders.length > 0 ? { folderId: folderId || null } : {}),
                  });
                  setEditing(false);
                })
              }
            >
              Save
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className={cn('px-[18px] py-4', s.status === 'dismissed' && 'opacity-60')}>
      <div className="flex items-start justify-between gap-3 mb-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-0.5">
            <span className="text-[14px] font-semibold text-[var(--text)]">{s.title}</span>
            <Badge tone={statusMeta.tone} className="rounded-full px-2 py-[2px]">
              {statusMeta.label}
            </Badge>
          </div>
          <p className="text-[11.5px] text-[var(--text-3)]">
            {folderPath ? `${folderPath} · ` : ''}
            {scope} · {sourceLabel(s.source, s.status)} · v{s.version ?? 1}
            {s.source === 'llm' || s.source === 'consolidation' ? ` · confidence ${s.confidence.toFixed(2)}` : ''}
            {s.evidenceCount ? ` · ${s.evidenceCount} example(s)` : ''}
            {' · '}
            {s.useCount
              ? `opened ${s.useCount}×${s.lastUsedAt ? `, last ${new Date(s.lastUsedAt).toLocaleDateString()}` : ''}`
              : 'not opened yet'}
          </p>
        </div>
        {isAdmin && (
          <div className="flex gap-1.5 flex-shrink-0">
            {s.status !== 'applied' && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => run(() => knowledgeGraph.skills.apply(token, s.id))}
                className="h-[30px] px-[11px] bg-[var(--ok)] text-[var(--ok-foreground)] hover:opacity-90"
              >
                {s.status === 'dismissed' ? 'Activate' : 'Apply'}
              </Button>
            )}
            {s.status === 'applied' && (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => run(() => knowledgeGraph.skills.dismiss(token, s.id))}
                className="h-[30px] px-[11px]"
              >
                Deactivate
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => setEditing(true)} className="h-[30px] px-[11px]">
              Edit
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              title="Delete"
              aria-label="Delete skill"
              onClick={() => run(() => knowledgeGraph.skills.remove(token, s.id))}
              className="h-[30px] w-[30px] p-0 text-[var(--danger)]"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              </svg>
            </Button>
          </div>
        )}
      </div>
      <p className="text-[13px] leading-[1.55] mb-1 text-[var(--text)]">
        <span className="text-[var(--text-3)]">When:</span> {s.whenToUse}
      </p>
      <p className="text-[13px] leading-[1.55] text-[var(--text)]">
        <span className="text-[var(--text-3)]">Do:</span> {s.instruction}
      </p>
      {s.status === 'pending' && (s.replaces?.length ?? 0) > 0 && (
        <p className="mt-1 text-[12px] text-[var(--text-3)]">
          Replaces {s.replaces!.length} active skills: applying it deactivates them (they stay, with their history).
        </p>
      )}
      {s.body && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[12.5px] text-[var(--text-2)]">
            Procedure ({s.body.length.toLocaleString()} characters)
          </summary>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] p-3 font-mono text-[12px] leading-relaxed text-[var(--text)]">
            {s.body}
          </pre>
        </details>
      )}
      {(s.version ?? 1) > 1 && (
        <div className="mt-2">
          <button onClick={toggleHistory} className="text-[12px] text-[var(--brand)] hover:underline">
            {history ? 'Hide history' : `History (${(s.version ?? 1) - 1} earlier version${(s.version ?? 1) > 2 ? 's' : ''})`}
          </button>
          {historyError && <p className="text-[12px] text-[var(--danger)]">{historyError}</p>}
          {history && (
            <ol className="mt-2 flex flex-col gap-2">
              {history.map((v) => (
                <li key={v.version} className="rounded-[9px] border border-[var(--border)] p-3 text-[12.5px]">
                  <p className="mb-1 text-[11.5px] text-[var(--text-3)]">
                    v{v.version} · replaced {new Date(v.createdAt).toLocaleString()}
                  </p>
                  <p className="font-medium text-[var(--text)]">{v.title}</p>
                  {v.whenToUse && <p className="text-[var(--text-2)]">When: {v.whenToUse}</p>}
                  <p className="text-[var(--text-2)]">Do: {v.instruction}</p>
                  {v.body && (
                    <p className="text-[var(--text-3)]">Procedure: {v.body.length.toLocaleString()} characters</p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </Card>
  );
}

function sourceLabel(source?: string, status?: string): string {
  if (source === 'llm') return 'AI-generated';
  if (source === 'consolidation') return status === 'pending' ? 'merge proposal' : 'merged by AI';
  if (source === 'errors') return 'learned from fixed errors';
  if (source === 'finder') return 'from Skills Finder';
  return 'written by hand';
}

function NewSkillForm({
  token,
  servers,
  connectors,
  folders,
  defaultFolderId,
  onCreated,
}: {
  token: string;
  servers: Array<{ id: string; name: string }>;
  connectors: Array<{ id: string; name: string }>;
  folders: KnowledgeFolder[];
  defaultFolderId: string;
  onCreated: () => void;
}) {
  const [folderId, setFolderId] = useState(defaultFolderId);
  const [title, setTitle] = useState('');
  const [whenToUse, setWhenToUse] = useState('');
  const [instruction, setInstruction] = useState('');
  const [procedure, setProcedure] = useState('');
  const [scope, setScope] = useState(''); // "srv:<id>" | "con:<id>" | ""
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);

  const valid = title.trim() && instruction.trim() && scope;

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    setErr('');
    const body: any = { title, whenToUse, instruction };
    if (procedure.trim()) body.body = procedure;
    if (folderId) body.folderId = folderId;
    if (scope.startsWith('srv:')) body.mcpServerId = scope.slice(4);
    else if (scope.startsWith('con:')) body.connectorId = scope.slice(4);
    try {
      await knowledgeGraph.skills.create(token, body);
      setTitle('');
      setWhenToUse('');
      setInstruction('');
      setProcedure('');
      setScope('');
      onCreated();
    } catch (e: any) {
      setErr(e.message || 'Create failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-4 mb-3.5 bg-[var(--surface-2)]">
      <p className="text-[13.5px] font-semibold mb-3 text-[var(--text)]">New skill</p>
      <div className="flex flex-col gap-2.5">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title (e.g. Always confirm the delivery address)"
          className={inputCls}
        />
        <input
          value={whenToUse}
          onChange={(e) => setWhenToUse(e.target.value)}
          placeholder="When to use (optional)"
          className={inputCls}
        />
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={3}
          placeholder="Instruction for the agent (imperative guidance)"
          className={textareaCls}
        />
        <textarea
          value={procedure}
          onChange={(e) => setProcedure(e.target.value)}
          rows={5}
          maxLength={20000}
          placeholder="Full procedure (optional, markdown): steps, field rules, output format. The AI opens it with skill_get when the skill applies."
          className={cn(textareaCls, 'font-mono text-[12.5px]')}
        />
        {folders.length > 0 && (
          <select
            value={folderId}
            onChange={(e) => setFolderId(e.target.value)}
            className={cn(inputCls, 'text-[var(--text)]')}
            aria-label="Folder"
          >
            {folderOptions(folders).map((o) => (
              <option key={o.value} value={o.value}>
                {o.value ? `Folder: ${o.label}` : 'No folder (top level)'}
              </option>
            ))}
          </select>
        )}
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          className={cn(inputCls, 'text-[var(--text)]')}
        >
          <option value="">Scope… (where this skill applies)</option>
          {servers.length > 0 && (
            <optgroup label="MCP servers">
              {servers.map((s) => (
                <option key={s.id} value={`srv:${s.id}`}>Server: {s.name}</option>
              ))}
            </optgroup>
          )}
          {connectors.length > 0 && (
            <optgroup label="Connectors">
              {connectors.map((c) => (
                <option key={c.id} value={`con:${c.id}`}>Connector: {c.name}</option>
              ))}
            </optgroup>
          )}
        </select>
        {err && <p className="text-[12px] text-[var(--danger)]">{err}</p>}
        <div className="flex items-center gap-2.5 mt-0.5">
          <Button variant="primary" size="md" onClick={submit} disabled={!valid || saving}>
            {saving ? 'Creating…' : 'Create skill'}
          </Button>
          <span className="text-[11.5px] text-[var(--text-3)]">
            Created as active → immediately available to the MCP server.
          </span>
        </div>
      </div>
    </Card>
  );
}

function ConsolidateIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 8h10M7 12h10M9 16h6" />
      <rect x="3" y="4" width="18" height="16" rx="2" />
    </svg>
  );
}

function GenerateIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3v3M12 18v3M5 12H3M21 12h-2M6 6l1.5 1.5M18 18l-1.5-1.5" />
      <circle cx="12" cy="12" r="3.5" />
    </svg>
  );
}
