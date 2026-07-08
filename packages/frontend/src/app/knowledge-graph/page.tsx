'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { knowledgeGraph, connectors as connectorsApi, type KgNode, type KgEdge } from '@/lib/api';
import { KgGraph } from '@/components/kg-graph';
import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { StatusPill } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const SOURCES = ['STATIC', 'OBSERVED', 'MANUAL', 'LLM'] as const;
const KIND_LABEL: Record<string, string> = {
  references: 'references',
  produces_consumes: 'data flow',
  parent_child: 'parent / child',
  same_identity: 'same identity',
  related: 'related',
};
const KIND_OPTIONS = [
  'references',
  'produces_consumes',
  'same_identity',
  'parent_child',
  'related',
] as const;

const inputClass =
  'w-full rounded-[9px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[13px] text-[var(--text)] placeholder:text-[var(--text-3)] outline-none focus:border-[var(--brand)]';
const labelClass = 'block text-[12.5px] font-medium text-[var(--text-2)]';
const sectionLabelClass =
  'text-[10.5px] font-semibold uppercase tracking-[0.05em] text-[var(--text-3)]';

export default function KnowledgeGraphPage() {
  const { token, user } = useAuth();
  const [nodes, setNodes] = useState<KgNode[]>([]);
  const [edges, setEdges] = useState<KgEdge[]>([]);
  const [lastBuiltAt, setLastBuiltAt] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [llmEnabled, setLlmEnabled] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [connectorList, setConnectorList] = useState<Array<{ id: string; name: string }>>([]);

  // Filters
  const [activeSources, setActiveSources] = useState<Set<string>>(new Set(SOURCES));
  const [showSuggested, setShowSuggested] = useState(true);
  const [minConfidence, setMinConfidence] = useState(0);

  const isAdmin = user?.role === 'ADMIN';

  const load = useCallback(() => {
    if (!token) return;
    setLoading(true);
    knowledgeGraph
      .get(token)
      .then((g) => {
        setNodes(g.nodes);
        setEdges(g.edges);
        setLastBuiltAt(g.lastBuiltAt);
        setEnabled(g.enabled);
      })
      .catch((e) => setStatus(e.message || 'Failed to load graph'))
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!token) return;
    knowledgeGraph.getSettings(token).then((s) => setLlmEnabled(s.llmEnabled)).catch(() => {});
    connectorsApi
      .list(token)
      .then((c: any[]) => setConnectorList(c.map((x) => ({ id: x.id, name: x.name }))))
      .catch(() => {});
  }, [token]);

  const enrich = async () => {
    if (!token) return;
    setEnriching(true);
    setStatus('Asking the model for relationship suggestions…');
    try {
      const r = await knowledgeGraph.enrich(token);
      setStatus(
        r.skipped
          ? 'No changes since the last enrichment.'
          : `AI suggested ${r.suggested} relationship(s)${r.model ? ` (${r.model})` : ''}. Review them in the “suggested” layer.`,
      );
      load();
    } catch (e: any) {
      setStatus(e.message || 'Enrichment failed');
    } finally {
      setEnriching(false);
    }
  };

  const rebuild = async () => {
    if (!token) return;
    setRebuilding(true);
    setStatus('Rebuilding graph…');
    try {
      const r = await knowledgeGraph.rebuild(token);
      setStatus(`Rebuilt: ${r.nodes} entities, ${r.edges} relationships from ${r.connectors} connectors.`);
      load();
    } catch (e: any) {
      setStatus(e.message || 'Rebuild failed');
    } finally {
      setRebuilding(false);
    }
  };

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const visibleEdges = useMemo(
    () =>
      edges.filter((e) => {
        if (!activeSources.has(e.source)) return false;
        if (e.status === 'suggested' && !showSuggested) return false;
        if (e.confidence < minConfidence) return false;
        return true;
      }),
    [edges, activeSources, showSuggested, minConfidence],
  );

  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) : null;
  const selectedEdge = selectedEdgeId ? edges.find((e) => e.id === selectedEdgeId) : null;

  const nodeEdges = useMemo(() => {
    if (!selectedNodeId) return [];
    return visibleEdges.filter(
      (e) => e.sourceNodeId === selectedNodeId || e.targetNodeId === selectedNodeId,
    );
  }, [selectedNodeId, visibleEdges]);

  const toggleSource = (s: string) => {
    setActiveSources((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  const setEdgeStatus = async (id: string, st: 'active' | 'rejected') => {
    if (!token) return;
    await knowledgeGraph.setEdgeStatus(token, id, st);
    load();
    setSelectedEdgeId(null);
  };
  const deleteEdge = async (id: string) => {
    if (!token) return;
    await knowledgeGraph.deleteEdge(token, id);
    load();
    setSelectedEdgeId(null);
  };
  const saveEdge = async (
    id: string,
    body: { kind?: string; note?: string | null; status?: 'active' | 'rejected' | 'suggested' },
  ) => {
    if (!token) return;
    try {
      await knowledgeGraph.updateEdge(token, id, body);
      setStatus('Saved');
      load();
    } catch (e: any) {
      setStatus(e.message || 'Save failed');
    }
  };
  const deleteNode = async (id: string) => {
    if (!token) return;
    try {
      await knowledgeGraph.deleteNode(token, id);
      setStatus('Entity deleted');
      setSelectedNodeId(null);
      load();
    } catch (e: any) {
      setStatus(e.message || 'Delete failed');
    }
  };
  const saveNode = async (id: string, body: { label?: string; description?: string | null }) => {
    if (!token) return;
    try {
      await knowledgeGraph.updateNode(token, id, body);
      setStatus('Saved');
      load();
    } catch (e: any) {
      setStatus(e.message || 'Save failed');
    }
  };
  const createEdge = async (body: {
    sourceNodeId: string;
    targetNodeId: string;
    kind?: string;
    note?: string;
  }) => {
    if (!token) return;
    try {
      await knowledgeGraph.createEdge(token, body);
      setStatus('Connection added');
      load();
    } catch (e: any) {
      setStatus(e.message || 'Create failed');
    }
  };
  const createNode = async (body: {
    connectorId: string;
    label: string;
    description?: string;
  }) => {
    if (!token) return;
    try {
      await knowledgeGraph.createNode(token, body);
      setStatus('Entity added');
      load();
    } catch (e: any) {
      setStatus(e.message || 'Create failed');
    }
  };

  return (
    <AppShell
      title="Knowledge Graph"
      subtitle={`${nodes.length} entities · ${visibleEdges.length} relationships${
        lastBuiltAt ? ` · built ${new Date(lastBuiltAt).toLocaleString()}` : ''
      }`}
      maxWidth="100%"
      hideFooter
      actions={
        isAdmin && enabled ? (
          <div className="flex items-center gap-2">
            {llmEnabled && (
              <Button
                variant="outlineBrand"
                onClick={enrich}
                disabled={enriching || rebuilding}
              >
                {enriching ? 'Enriching…' : 'Enrich with AI'}
              </Button>
            )}
            <Button onClick={rebuild} disabled={rebuilding || enriching}>
              {rebuilding ? 'Rebuilding…' : 'Rebuild graph'}
            </Button>
          </div>
        ) : undefined
      }
    >
      {/* Filters / status bar */}
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px]">
        <div className="flex items-center gap-2">
          <span className={sectionLabelClass}>Layer</span>
          {SOURCES.map((s) => (
            <button
              key={s}
              onClick={() => toggleSource(s)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition-colors',
                activeSources.has(s)
                  ? 'border-[var(--brand)] bg-[var(--brand-tint)] text-[var(--brand)]'
                  : 'border-[var(--border)] text-[var(--text-3)] hover:border-[var(--border-strong)]',
              )}
            >
              {s.toLowerCase()}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-[var(--text-2)]">
          <input type="checkbox" checked={showSuggested} onChange={(e) => setShowSuggested(e.target.checked)} />
          <span>show suggested</span>
        </label>
        <label className="flex items-center gap-2 text-[var(--text-2)]">
          <span className={sectionLabelClass}>min confidence</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={minConfidence}
            onChange={(e) => setMinConfidence(Number(e.target.value))}
          />
          <span className="w-8 font-mono tabular-nums text-[var(--text-2)]">{minConfidence.toFixed(2)}</span>
        </label>
        <div className="ml-auto flex items-center gap-3">
          {status && <span className="text-[12px] text-[var(--text-3)]">{status}</span>}
          <Link
            href="/knowledge-graph/skills"
            className="whitespace-nowrap text-[12.5px] font-medium text-[var(--brand)] hover:underline"
          >
            Skills →
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_340px] items-start">
        {/* Graph canvas */}
        <Card className="h-[72vh] overflow-hidden">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
            <Legend />
            <span className="text-[12px] text-[var(--text-3)]">
              {nodes.length} entities · {visibleEdges.length} relationships
            </span>
          </div>
          <div className="relative h-[calc(72vh-49px)] bg-[radial-gradient(circle_at_center,color-mix(in_srgb,var(--brand)_5%,transparent),transparent_70%)]">
            {loading ? (
              <div className="flex h-full items-center justify-center text-[var(--text-3)]">
                Loading graph…
              </div>
            ) : !enabled ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                <p className="font-medium text-[var(--text)]">The Knowledge Graph is disabled for this workspace.</p>
                <p className="text-[13px] text-[var(--text-3)]">
                  An admin can enable it in Settings → Organization → Features.
                </p>
              </div>
            ) : nodes.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <p className="text-[13px] text-[var(--text-3)]">
                  No graph yet. {isAdmin ? 'Click “Rebuild graph” to generate it from your connectors and usage.' : 'Ask an admin to build the graph.'}
                </p>
              </div>
            ) : (
              <KgGraph
                nodes={nodes}
                edges={visibleEdges}
                selectedNodeId={selectedNodeId}
                selectedEdgeId={selectedEdgeId}
                onSelectNode={(id) => {
                  setSelectedNodeId(id);
                  setSelectedEdgeId(null);
                }}
                onSelectEdge={(id) => {
                  setSelectedEdgeId(id);
                  setSelectedNodeId(null);
                }}
              />
            )}
          </div>
        </Card>

        {/* Side panel */}
        <aside className="h-[72vh] overflow-y-auto">
          {selectedNode ? (
            <NodePanel
              key={selectedNode.id}
              node={selectedNode}
              edges={nodeEdges}
              nodeById={nodeById}
              isAdmin={isAdmin}
              onSave={(body) => saveNode(selectedNode.id, body)}
              onDelete={() => deleteNode(selectedNode.id)}
            />
          ) : selectedEdge ? (
            <EdgePanel
              key={selectedEdge.id}
              edge={selectedEdge}
              nodeById={nodeById}
              isAdmin={isAdmin}
              onConfirm={() => setEdgeStatus(selectedEdge.id, 'active')}
              onReject={() => setEdgeStatus(selectedEdge.id, 'rejected')}
              onDelete={() => deleteEdge(selectedEdge.id)}
              onSave={(body) => saveEdge(selectedEdge.id, body)}
            />
          ) : (
            <Card className="p-[18px]">
              <p className="mb-1 text-[14px] font-semibold text-[var(--text)]">Explore</p>
              <p className="text-[13px] text-[var(--text-2)]">
                Click an entity to see its fields and links, or an edge to inspect (and edit) a relationship.
              </p>
              {isAdmin && connectorList.length > 0 && (
                <AddNodeForm connectors={connectorList} onCreate={createNode} />
              )}
              {isAdmin && nodes.length >= 2 && (
                <AddEdgeForm nodes={nodes} onCreate={createEdge} />
              )}
            </Card>
          )}
        </aside>
      </div>
    </AppShell>
  );
}

function Legend() {
  const items = [
    ['references', '#6366f1'],
    ['data flow', '#16a34a'],
    ['parent / child', '#94a3b8'],
    ['same identity', '#f59e0b'],
    ['related', '#a855f7'],
  ] as const;
  return (
    <div className="flex flex-wrap items-center gap-3">
      {items.map(([label, color]) => (
        <span key={label} className="flex items-center gap-1.5 text-[12px] text-[var(--text-2)]">
          <span className="inline-block h-0.5 w-4 rounded-full" style={{ background: color }} />
          {label}
        </span>
      ))}
    </div>
  );
}

function NodePanel({
  node,
  edges,
  nodeById,
  isAdmin,
  onSave,
  onDelete,
}: {
  node: KgNode;
  edges: KgEdge[];
  nodeById: Map<string, KgNode>;
  isAdmin: boolean;
  onSave: (body: { label?: string; description?: string | null }) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(node.label);
  const [description, setDescription] = useState(node.description ?? '');
  return (
    <div className="flex flex-col gap-3.5">
      <Card className="p-[18px]">
        <p className={cn(sectionLabelClass, 'mb-2')}>
          {node.connectorName ?? 'connector'} · {String(node.source).toLowerCase()}
        </p>

        {editing ? (
          <div className="space-y-2">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className={inputClass}
              placeholder="Label"
            />
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className={inputClass}
              placeholder="Description (shown to AI clients reading the graph)"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => {
                  onSave({ label, description: description.trim() ? description : null });
                  setEditing(false);
                }}
              >
                Save
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setLabel(node.label);
                  setDescription(node.description ?? '');
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-[16px] font-semibold text-[var(--text)]">{node.label}</h2>
              {node.description && (
                <p className="mt-0.5 text-[13px] text-[var(--text-2)]">{node.description}</p>
              )}
            </div>
            {isAdmin && (
              <div className="flex shrink-0 gap-1.5">
                <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={onDelete}
                  className="text-[var(--danger)]"
                  title="Delete this entity and its links"
                >
                  Delete
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>

      <Card className="p-[18px]">
        <p className={cn(sectionLabelClass, 'mb-2')}>Fields ({node.fields.length})</p>
        <div className="flex flex-wrap gap-1.5">
          {node.fields.slice(0, 40).map((f) => (
            <span
              key={f.name}
              className="rounded-[6px] border border-[var(--border)] bg-[var(--surface-2)] px-2 py-[3px] font-mono text-[11.5px] text-[var(--text-2)]"
            >
              {f.name}
            </span>
          ))}
          {node.fields.length === 0 && <span className="text-[13px] text-[var(--text-3)]">—</span>}
        </div>
      </Card>

      <Card className="p-[18px]">
        <p className={cn(sectionLabelClass, 'mb-2.5')}>Connections ({edges.length})</p>
        <ul className="flex flex-col gap-2.5">
          {edges.map((e) => {
            const other = e.sourceNodeId === node.id ? nodeById.get(e.targetNodeId) : nodeById.get(e.sourceNodeId);
            const dir = e.sourceNodeId === node.id ? '→' : '←';
            return (
              <li key={e.id} className="flex items-center gap-2.5">
                <span className="w-3.5 flex-shrink-0 text-center font-mono text-[14px] text-[var(--text-3)]">
                  {dir}
                </span>
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-[var(--text)]">{other?.label ?? '?'}</div>
                  <div className="text-[11.5px] text-[var(--text-3)]">
                    {KIND_LABEL[e.kind] ?? e.kind}
                    {e.matchKey ? ` · ${e.matchKey}` : ''}
                  </div>
                </div>
              </li>
            );
          })}
          {edges.length === 0 && <li className="text-[13px] text-[var(--text-3)]">—</li>}
        </ul>
      </Card>

      {node.toolNames.length > 0 && (
        <Card className="p-[18px]">
          <p className={cn(sectionLabelClass, 'mb-2')}>Tools ({node.toolNames.length})</p>
          <div className="flex flex-wrap gap-1.5">
            {node.toolNames.slice(0, 30).map((t) => (
              <span
                key={t}
                className="rounded-[6px] border border-[var(--border)] bg-[var(--surface-2)] px-2 py-[3px] font-mono text-[10.5px] text-[var(--text-2)]"
              >
                {t}
              </span>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function EdgePanel({
  edge,
  nodeById,
  isAdmin,
  onConfirm,
  onReject,
  onDelete,
  onSave,
}: {
  edge: KgEdge;
  nodeById: Map<string, KgNode>;
  isAdmin: boolean;
  onConfirm: () => void;
  onReject: () => void;
  onDelete: () => void;
  onSave: (body: { kind?: string; note?: string | null }) => void;
}) {
  const src = nodeById.get(edge.sourceNodeId);
  const tgt = nodeById.get(edge.targetNodeId);
  const [kind, setKind] = useState(edge.kind);
  const [note, setNote] = useState(edge.note ?? '');
  const dirty = kind !== edge.kind || (note ?? '') !== (edge.note ?? '');
  return (
    <Card className="p-[18px]">
      <div className="mb-3.5 flex items-center gap-2">
        <span className={sectionLabelClass}>{String(edge.source).toLowerCase()}</span>
        <StatusPill tone={edge.status === 'suggested' ? 'warn' : 'success'}>{edge.status}</StatusPill>
      </div>

      <div className="mb-3.5 flex items-center gap-2.5">
        <div className="min-w-0 flex-1 rounded-[9px] border border-[var(--border)] px-2.5 py-2">
          <div className="truncate text-[13px] font-semibold text-[var(--text)]">{src?.label ?? '?'}</div>
          <div className="truncate text-[11px] text-[var(--text-3)]">{src?.connectorName ?? '—'}</div>
        </div>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0">
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
        <div className="min-w-0 flex-1 rounded-[9px] border border-[var(--border)] px-2.5 py-2">
          <div className="truncate text-[13px] font-semibold text-[var(--text)]">{tgt?.label ?? '?'}</div>
          <div className="truncate text-[11px] text-[var(--text-3)]">{tgt?.connectorName ?? '—'}</div>
        </div>
      </div>

      <dl className="space-y-1.5 text-[13px]">
        <Row k="Kind" v={KIND_LABEL[edge.kind] ?? edge.kind} />
        {edge.matchKey && <Row k="Match key" v={edge.matchKey} />}
        <Row k="Confidence" v={edge.confidence.toFixed(2)} />
        <Row k="Observations" v={String(edge.observations)} />
      </dl>

      {isAdmin ? (
        <div className="mt-3.5 space-y-2.5">
          <label className={labelClass}>
            <span className="mb-1.5 block">Kind</span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className={inputClass}
            >
              {KIND_OPTIONS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k] ?? k}
                </option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            <span className="mb-1.5 block">Description (served to AI clients)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className={inputClass}
              placeholder="Why these entities are linked…"
            />
          </label>
          <Button size="sm" onClick={() => onSave({ kind, note: note.trim() ? note : null })} disabled={!dirty}>
            Save changes
          </Button>
        </div>
      ) : (
        edge.note && (
          <p className="mt-2.5 text-[13px] italic text-[var(--text-2)]">
            &ldquo;{edge.note}&rdquo;
          </p>
        )
      )}

      {isAdmin && (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--border)] pt-3.5">
          {edge.status === 'suggested' && (
            <Button size="sm" onClick={onConfirm}>
              Confirm
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={onReject}>
            Reject
          </Button>
          <Button size="sm" variant="secondary" onClick={onDelete} className="text-[var(--danger)]">
            Delete
          </Button>
        </div>
      )}
    </Card>
  );
}

function AddNodeForm({
  connectors,
  onCreate,
}: {
  connectors: Array<{ id: string; name: string }>;
  onCreate: (body: { connectorId: string; label: string; description?: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [connectorId, setConnectorId] = useState('');
  const [description, setDescription] = useState('');

  if (!open) {
    return (
      <Button size="sm" className="mt-4 mr-2" onClick={() => setOpen(true)}>
        + Add entity
      </Button>
    );
  }
  const valid = label.trim() && connectorId;
  return (
    <div className="mt-4 space-y-2 border-t border-[var(--border)] pt-3.5">
      <p className="text-[13px] font-semibold text-[var(--text)]">New entity</p>
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="Label (e.g. Loyalty tier)"
        className={inputClass}
      />
      <select
        value={connectorId}
        onChange={(e) => setConnectorId(e.target.value)}
        className={inputClass}
      >
        <option value="">Belongs to connector…</option>
        {connectors.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
        placeholder="Description (optional, served to AI clients)"
        className={inputClass}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!valid}
          onClick={() => {
            onCreate({ connectorId, label, description: description.trim() || undefined });
            setLabel('');
            setConnectorId('');
            setDescription('');
            setOpen(false);
          }}
        >
          Add entity
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function AddEdgeForm({
  nodes,
  onCreate,
}: {
  nodes: KgNode[];
  onCreate: (body: { sourceNodeId: string; targetNodeId: string; kind?: string; note?: string }) => void;
}) {
  const sorted = useMemo(
    () => [...nodes].sort((a, b) => a.label.localeCompare(b.label)),
    [nodes],
  );
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [kind, setKind] = useState<string>('references');
  const [note, setNote] = useState('');

  if (!open) {
    return (
      <Button size="sm" className="mt-4" onClick={() => setOpen(true)}>
        + Add connection
      </Button>
    );
  }

  const valid = source && target && source !== target;
  return (
    <div className="mt-4 space-y-2 border-t border-[var(--border)] pt-3.5">
      <p className="text-[13px] font-semibold text-[var(--text)]">New connection</p>
      <select value={source} onChange={(e) => setSource(e.target.value)} className={inputClass}>
        <option value="">From entity…</option>
        {sorted.map((n) => (
          <option key={n.id} value={n.id}>{n.label} ({n.connectorName ?? '—'})</option>
        ))}
      </select>
      <select value={kind} onChange={(e) => setKind(e.target.value)} className={inputClass}>
        {KIND_OPTIONS.map((k) => (
          <option key={k} value={k}>{KIND_LABEL[k] ?? k}</option>
        ))}
      </select>
      <select value={target} onChange={(e) => setTarget(e.target.value)} className={inputClass}>
        <option value="">To entity…</option>
        {sorted.map((n) => (
          <option key={n.id} value={n.id}>{n.label} ({n.connectorName ?? '—'})</option>
        ))}
      </select>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="Description (optional, served to AI clients)"
        className={inputClass}
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!valid}
          onClick={() => {
            onCreate({ sourceNodeId: source, targetNodeId: target, kind, note: note.trim() || undefined });
            setSource('');
            setTarget('');
            setNote('');
            setOpen(false);
          }}
        >
          Add
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-[var(--text-3)]">{k}</dt>
      <dd className="text-right font-medium text-[var(--text)]">{v}</dd>
    </div>
  );
}
