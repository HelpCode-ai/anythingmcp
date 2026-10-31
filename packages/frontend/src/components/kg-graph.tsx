'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { KgNode, KgEdge } from '@/lib/api';

const NODE_PALETTE = [
  '#6366f1', '#16a34a', '#f59e0b', '#ec4899', '#0ea5e9', '#8b5cf6',
  '#ef4444', '#14b8a6', '#f97316', '#84cc16', '#06b6d4', '#d946ef',
];

const EDGE_STYLE: Record<string, { color: string; dashed?: boolean; arrow?: boolean }> = {
  references: { color: '#6366f1', arrow: true },
  produces_consumes: { color: '#16a34a', arrow: true },
  parent_child: { color: '#94a3b8', arrow: true },
  same_identity: { color: '#f59e0b', dashed: true },
  related: { color: '#a855f7', dashed: true },
};

interface Pos {
  x: number;
  y: number;
}

interface Props {
  nodes: KgNode[];
  edges: KgEdge[];
  selectedNodeId: string | null;
  selectedEdgeId?: string | null;
  onSelectNode: (id: string | null) => void;
  onSelectEdge: (id: string | null) => void;
}

/** Deterministic cluster layout: one circular cluster per connector, clusters on a grid. */
function layout(nodes: KgNode[]): { pos: Map<string, Pos>; colorByConnector: Map<string, string> } {
  const byConnector = new Map<string, KgNode[]>();
  for (const n of nodes) {
    const list = byConnector.get(n.connectorId) ?? [];
    list.push(n);
    byConnector.set(n.connectorId, list);
  }
  const connectorIds = [...byConnector.keys()].sort();
  const colorByConnector = new Map(
    connectorIds.map((id, i) => [id, NODE_PALETTE[i % NODE_PALETTE.length]]),
  );

  const pos = new Map<string, Pos>();
  const cols = Math.max(1, Math.ceil(Math.sqrt(connectorIds.length)));
  const CELL = 520;
  connectorIds.forEach((cid, ci) => {
    const cx = (ci % cols) * CELL + CELL / 2;
    const cy = Math.floor(ci / cols) * CELL + CELL / 2;
    const group = byConnector.get(cid)!;
    const radius = Math.min(190, 60 + group.length * 14);
    group.forEach((node, i) => {
      if (group.length === 1) {
        pos.set(node.id, { x: cx, y: cy });
      } else {
        const angle = (i / group.length) * Math.PI * 2 - Math.PI / 2;
        pos.set(node.id, {
          x: cx + Math.cos(angle) * radius,
          y: cy + Math.sin(angle) * radius,
        });
      }
    });
  });
  return { pos, colorByConnector };
}

export function KgGraph({
  nodes,
  edges,
  selectedNodeId,
  selectedEdgeId,
  onSelectNode,
  onSelectEdge,
}: Props) {
  const t = useTranslations('knowledgeGraph.graph');
  const { pos, colorByConnector } = useMemo(() => layout(nodes), [nodes]);

  // Degree per node + adjacency (used for sizing, label priority and focus mode).
  const { degree, neighbors } = useMemo(() => {
    const degree = new Map<string, number>();
    const neighbors = new Map<string, Set<string>>();
    for (const n of nodes) {
      degree.set(n.id, 0);
      neighbors.set(n.id, new Set());
    }
    for (const e of edges) {
      if (!degree.has(e.sourceNodeId) || !degree.has(e.targetNodeId)) continue;
      degree.set(e.sourceNodeId, (degree.get(e.sourceNodeId) ?? 0) + 1);
      degree.set(e.targetNodeId, (degree.get(e.targetNodeId) ?? 0) + 1);
      neighbors.get(e.sourceNodeId)!.add(e.targetNodeId);
      neighbors.get(e.targetNodeId)!.add(e.sourceNodeId);
    }
    return { degree, neighbors };
  }, [nodes, edges]);

  const maxDegree = useMemo(() => Math.max(1, ...degree.values()), [degree]);

  const bounds = useMemo(() => {
    const xs = [...pos.values()].map((p) => p.x);
    const ys = [...pos.values()].map((p) => p.y);
    if (!xs.length) return { x: 0, y: 0, w: 800, h: 600 };
    const pad = 120;
    const minX = Math.min(...xs) - pad;
    const minY = Math.min(...ys) - pad;
    return {
      x: minX,
      y: minY,
      w: Math.max(...xs) - minX + pad,
      h: Math.max(...ys) - minY + pad,
    };
  }, [pos]);

  const [view, setView] = useState(bounds);
  const [hovered, setHovered] = useState<string | null>(null);

  // Re-fit the viewport whenever the graph's bounds change (node set/layout).
  const fitKey = `${nodes.length}:${bounds.x}:${bounds.y}:${bounds.w}:${bounds.h}`;
  useEffect(() => {
    setView(bounds);
    // bounds is encoded by fitKey; depending on the object would loop every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey]);

  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);

  // Node in focus = the hovered one, else the selected one. When set, we dim
  // everything not adjacent to it so the local neighbourhood stands out.
  const focusId = hovered ?? selectedNodeId;
  const focusSet = useMemo(() => {
    if (!focusId) return null;
    const s = new Set<string>([focusId]);
    for (const nb of neighbors.get(focusId) ?? []) s.add(nb);
    return s;
  }, [focusId, neighbors]);

  const zoomBy = (factor: number) =>
    setView((v) => {
      const nw = Math.min(12000, Math.max(120, v.w * factor));
      const nh = Math.min(12000, Math.max(90, v.h * factor));
      return { x: v.x + (v.w - nw) / 2, y: v.y + (v.h - nh) / 2, w: nw, h: nh };
    });

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.12 : 0.89;
    setView((v) => {
      const rect = svgRef.current?.getBoundingClientRect();
      const px = rect ? (e.clientX - rect.left) / rect.width : 0.5;
      const py = rect ? (e.clientY - rect.top) / rect.height : 0.5;
      const nw = Math.min(12000, Math.max(120, v.w * factor));
      const nh = Math.min(12000, Math.max(90, v.h * factor));
      return { x: v.x + (v.w - nw) * px, y: v.y + (v.h - nh) * py, w: nw, h: nh };
    });
  };

  const onMouseDown = (e: React.MouseEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const d = drag.current;
    if (!d || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const dx = ((e.clientX - d.x) / rect.width) * view.w;
    const dy = ((e.clientY - d.y) / rect.height) * view.h;
    if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
    setView((v) => ({ ...v, x: d.vx - dx, y: d.vy - dy }));
  };
  const endDrag = () => {
    drag.current = null;
  };

  // Show a label only when it won't drown the canvas: hubs, the focused node and
  // its neighbours, and the current selection. Everything else reveals on hover.
  const hubCutoff = Math.max(3, Math.ceil(maxDegree * 0.4));
  const labelVisible = (id: string, deg: number) =>
    deg >= hubCutoff || id === selectedNodeId || (focusSet?.has(id) ?? false);

  const ctrlBtn =
    'w-8 h-8 flex items-center justify-center rounded-md border border-[var(--border)] ' +
    'bg-[var(--background)]/90 backdrop-blur text-[var(--foreground)] text-base leading-none ' +
    'hover:bg-[var(--accent)] cursor-pointer transition-colors shadow-sm';

  return (
    <div className="relative w-full h-full">
      <svg
        ref={svgRef}
        viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
        className="w-full h-full cursor-grab active:cursor-grabbing select-none"
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        onClick={() => {
          if (!drag.current?.moved) onSelectNode(null);
        }}
      >
        <defs>
          {Object.entries(EDGE_STYLE)
            .filter(([, s]) => s.arrow)
            .map(([kind, s]) => (
              <marker
                key={kind}
                id={`arrow-${kind}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill={s.color} />
              </marker>
            ))}
        </defs>

        {/* Edges */}
        {edges.map((edge) => {
          const a = pos.get(edge.sourceNodeId);
          const b = pos.get(edge.targetNodeId);
          if (!a || !b) return null;
          const style = EDGE_STYLE[edge.kind] ?? EDGE_STYLE.references;
          const selected = edge.id === selectedEdgeId;
          const inFocus =
            !focusSet ||
            focusSet.has(edge.sourceNodeId) ||
            focusSet.has(edge.targetNodeId);
          const base = 0.28 + Math.min(0.7, edge.confidence) * 0.72;
          const opacity = selected ? 1 : inFocus ? base : 0.06;
          return (
            <line
              key={edge.id}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={style.color}
              strokeWidth={(selected ? 2.5 : 1) + edge.confidence * 2.5}
              strokeOpacity={opacity}
              strokeDasharray={style.dashed ? '6 5' : undefined}
              markerEnd={style.arrow ? `url(#arrow-${edge.kind})` : undefined}
              style={{ cursor: 'pointer', transition: 'stroke-opacity 150ms' }}
              onClick={(e) => {
                e.stopPropagation();
                onSelectEdge(edge.id);
              }}
            />
          );
        })}

        {/* Nodes */}
        {nodes.map((node) => {
          const p = pos.get(node.id);
          if (!p) return null;
          const color = colorByConnector.get(node.connectorId) ?? '#6366f1';
          const selected = node.id === selectedNodeId;
          const deg = degree.get(node.id) ?? 0;
          const dimmed = focusSet ? !focusSet.has(node.id) : false;
          // Radius grows with connectivity so hubs read as more important.
          const r = (selected ? 5 : 0) + 6 + Math.sqrt(deg / maxDegree) * 8;
          return (
            <g
              key={node.id}
              transform={`translate(${p.x} ${p.y})`}
              style={{ cursor: 'pointer', opacity: dimmed ? 0.18 : 1, transition: 'opacity 150ms' }}
              onMouseEnter={() => setHovered(node.id)}
              onMouseLeave={() => setHovered((h) => (h === node.id ? null : h))}
              onClick={(e) => {
                e.stopPropagation();
                onSelectNode(node.id);
              }}
            >
              <circle
                r={r}
                fill={color}
                stroke={selected ? 'var(--foreground)' : 'var(--background)'}
                strokeWidth={selected ? 3 : 1.5}
                fillOpacity={node.source === 'OBSERVED' ? 1 : 0.85}
              />
              {labelVisible(node.id, deg) && (
                <text
                  x={0}
                  y={r + 13}
                  textAnchor="middle"
                  fontSize="12"
                  fontWeight={selected ? 700 : 500}
                  fill="var(--foreground)"
                  stroke="var(--background)"
                  strokeWidth={3}
                  paintOrder="stroke"
                  style={{ userSelect: 'none' }}
                >
                  {node.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Zoom / fit controls */}
      <div className="absolute bottom-3 right-3 flex flex-col gap-1.5">
        <button type="button" aria-label={t('zoomIn')} className={ctrlBtn} onClick={() => zoomBy(0.8)}>
          +
        </button>
        <button type="button" aria-label={t('zoomOut')} className={ctrlBtn} onClick={() => zoomBy(1.25)}>
          −
        </button>
        <button
          type="button"
          aria-label={t('fit')}
          title={t('fitTitle')}
          className={ctrlBtn}
          onClick={() => setView(bounds)}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M16 21h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />
          </svg>
        </button>
      </div>
    </div>
  );
}
