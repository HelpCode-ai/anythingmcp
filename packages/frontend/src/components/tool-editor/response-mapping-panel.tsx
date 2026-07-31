'use client';

import { useMemo, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { tools, type MappingPreview, type ResponseTransform } from '@/lib/api';

/* ------------------------------------------------------------------ */
/*  Editor state <-> ResponseTransform                                 */
/* ------------------------------------------------------------------ */

export interface ResponseMappingState {
  mode: 'off' | 'select' | 'jmespath';
  /** JSON text of the `select` template (mode: select). */
  selectJson: string;
  /** One path per line (mode: select). */
  excludeText: string;
  /** JMESPath expression (mode: jmespath). */
  expression: string;
  fallbackToRaw: boolean;
  maxBytes: number;
}

export const EMPTY_MAPPING_STATE: ResponseMappingState = {
  mode: 'off',
  selectJson: '',
  excludeText: '',
  expression: '',
  fallbackToRaw: true,
  maxBytes: 0,
};

const EXAMPLE_SELECT = `{
  "page": {
    "count": "$.pageDetails.count",
    "totalCount": "$.pageDetails.totalCount",
    "nextPageUrl": "$.pageDetails.nextPageUrl"
  },
  "devices": {
    "$from": "$.devices[*]",
    "$select": {
      "id": "id",
      "hostname": "hostname",
      "siteName": "siteName",
      "category": "deviceType.category",
      "operatingSystem": "operatingSystem",
      "online": "online",
      "antivirusStatus": "antivirus.antivirusStatus"
    }
  }
}`;

const EXAMPLE_EXPRESSION = '{ total: length(devices), hostnames: devices[*].hostname }';

export function parseTransformToState(
  transform: ResponseTransform | null | undefined,
): ResponseMappingState {
  if (!transform) return EMPTY_MAPPING_STATE;
  const mode: ResponseMappingState['mode'] =
    transform.mode === 'off'
      ? 'off'
      : transform.mode === 'jmespath' || (!transform.mode && transform.expression)
        ? 'jmespath'
        : 'select';
  return {
    mode,
    selectJson: transform.select ? JSON.stringify(transform.select, null, 2) : '',
    excludeText: (transform.exclude ?? []).join('\n'),
    expression: transform.expression ?? '',
    fallbackToRaw: transform.fallbackToRaw !== false,
    maxBytes: typeof transform.maxBytes === 'number' ? transform.maxBytes : 0,
  };
}

/** Returns null when the mapping is off or empty (⇒ raw response is returned). */
export function stateToTransform(state: ResponseMappingState): ResponseTransform | null {
  if (state.mode === 'off') return null;

  const exclude = state.excludeText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const transform: ResponseTransform = { mode: state.mode };

  if (state.mode === 'jmespath') {
    if (!state.expression.trim()) return null;
    transform.expression = state.expression.trim();
  } else {
    const select = safeParseObject(state.selectJson);
    if (select) transform.select = select;
    if (exclude.length > 0) transform.exclude = exclude;
    if (!transform.select && !transform.exclude) return null;
  }

  if (!state.fallbackToRaw) transform.fallbackToRaw = false;
  if (state.maxBytes > 0) transform.maxBytes = state.maxBytes;
  return transform;
}

function safeParseObject(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** True when the operator typed something that doesn't parse yet. */
export function mappingStateInvalid(state: ResponseMappingState): boolean {
  return state.mode === 'select' && !!state.selectJson.trim() && !safeParseObject(state.selectJson);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

interface Props {
  state: ResponseMappingState;
  onChange: (next: ResponseMappingState) => void;
  /** Needed for the live preview — absent while creating a brand-new tool. */
  connectorId?: string;
  toolId?: string;
}

export function ResponseMappingPanel({ state, onChange, connectorId, toolId }: Props) {
  const { token } = useAuth();
  const [preview, setPreview] = useState<MappingPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const set = (patch: Partial<ResponseMappingState>) => onChange({ ...state, ...patch });
  const invalid = mappingStateInvalid(state);
  const canPreview = !!(connectorId && toolId && token) && !invalid;

  const transform = useMemo(() => stateToTransform(state), [state]);

  const runPreview = async () => {
    if (!connectorId || !toolId || !token) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const res = await tools.previewMapping(connectorId, toolId, { transform }, token);
      setPreview(res);
      if (!res.ok) setPreviewError(res.error ?? 'Preview failed');
    } catch (err: any) {
      setPreviewError(err?.message || 'Preview failed');
      setPreview(null);
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <div className="border border-[var(--border)] rounded-md p-3 space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <label className="text-xs font-semibold">Response Mapping</label>
          <p className="text-[10px] text-[var(--muted-foreground)] mt-0.5">
            Shape the API response before it reaches the AI client. Fewer tokens, and only
            the fields this tool actually needs leave your workspace. Off = the raw response
            is returned unchanged.
          </p>
        </div>
        <div className="flex gap-3 text-xs">
          {(
            [
              ['off', 'Off'],
              ['select', 'Field selection'],
              ['jmespath', 'JMESPath'],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-1 cursor-pointer">
              <input
                type="radio"
                name="responseMappingMode"
                checked={state.mode === value}
                onChange={() => set({ mode: value })}
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      {state.mode === 'select' && (
        <div className="space-y-2">
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[11px] font-medium">Output template (JSON)</label>
              <button
                type="button"
                onClick={() => set({ selectJson: EXAMPLE_SELECT })}
                className="text-[11px] text-[var(--brand)] hover:underline"
              >
                Insert example
              </button>
            </div>
            <textarea
              value={state.selectJson}
              onChange={(e) => set({ selectJson: e.target.value })}
              rows={10}
              spellCheck={false}
              placeholder={'{\n  "id": "$.data.id",\n  "name": "$.data.attributes.name"\n}'}
              className="w-full px-2 py-1.5 border border-[var(--border)] rounded-md bg-[var(--background)] text-xs font-mono"
            />
            {invalid && (
              <p className="text-[11px] text-[var(--danger)]">
                Not valid JSON — saving is disabled until this parses.
              </p>
            )}
            <p className="text-[11px] text-[var(--muted-foreground)] mt-1">
              Keys are the output names. A leaf is a path (<code>$.a.b</code>,{' '}
              <code>items[*].id</code>, <code>list[-1].x</code>), a static value (
              <code>&quot;= my-source&quot;</code>), or{' '}
              <code>{'{ "$from": "$.rows[*]", "$select": { … } }'}</code> to reshape every
              element of an array. A path that does not resolve is left out.
            </p>
          </div>

          <div>
            <label className="text-[11px] font-medium block mb-1">
              Exclude paths (one per line)
            </label>
            <textarea
              value={state.excludeText}
              onChange={(e) => set({ excludeText: e.target.value })}
              rows={3}
              spellCheck={false}
              placeholder={'devices[*].udf\ninternalToken'}
              className="w-full px-2 py-1.5 border border-[var(--border)] rounded-md bg-[var(--background)] text-xs font-mono"
            />
            <p className="text-[11px] text-[var(--muted-foreground)] mt-1">
              Removed before the template runs. Use this alone (no template) to drop a few
              noisy fields while keeping everything else.
            </p>
          </div>
        </div>
      )}

      {state.mode === 'jmespath' && (
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[11px] font-medium">JMESPath expression</label>
            <button
              type="button"
              onClick={() => set({ expression: EXAMPLE_EXPRESSION })}
              className="text-[11px] text-[var(--brand)] hover:underline"
            >
              Insert example
            </button>
          </div>
          <textarea
            value={state.expression}
            onChange={(e) => set({ expression: e.target.value })}
            rows={4}
            spellCheck={false}
            placeholder="devices[*].{id: id, host: hostname, category: deviceType.category}"
            className="w-full px-2 py-1.5 border border-[var(--border)] rounded-md bg-[var(--background)] text-xs font-mono"
          />
          <p className="text-[11px] text-[var(--muted-foreground)] mt-1">
            Full JMESPath, including functions — use this for computed values such as{' '}
            <code>length(devices)</code> or filters like{' '}
            <code>devices[?online == `false`]</code>.
          </p>
        </div>
      )}

      {state.mode !== 'off' && (
        <>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-1.5 text-[11px] cursor-pointer">
              <input
                type="checkbox"
                checked={state.fallbackToRaw}
                onChange={(e) => set({ fallbackToRaw: e.target.checked })}
              />
              Fall back to the raw response if the mapping fails
            </label>
            <label className="flex items-center gap-1.5 text-[11px]">
              Max response size
              <input
                type="number"
                min={0}
                value={state.maxBytes}
                onChange={(e) => set({ maxBytes: Math.max(0, parseInt(e.target.value) || 0) })}
                className="w-24 border border-[var(--input)] rounded px-2 py-1 text-xs bg-[var(--background)]"
              />
              bytes (0 = no limit)
            </label>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={runPreview}
              disabled={!canPreview || previewing}
              title={
                canPreview
                  ? 'Runs the mapping against the most recent real response for this tool. No API call is made.'
                  : 'Save the tool and run it once to get a real response to preview against.'
              }
              className="border border-[var(--border)] px-3 py-1 rounded text-xs hover:bg-[var(--accent)] disabled:opacity-50"
            >
              {previewing ? 'Previewing…' : 'Preview with last real response'}
            </button>
            {preview?.ok && (
              <span className="text-[11px] text-[var(--muted-foreground)]">
                {formatBytes(preview.rawBytes ?? 0)} → {formatBytes(preview.mappedBytes ?? 0)}{' '}
                <strong
                  className={
                    (preview.bytesSavedPct ?? 0) > 0 ? 'text-[var(--ok,#16a34a)]' : undefined
                  }
                >
                  ({(preview.bytesSavedPct ?? 0) > 0 ? '−' : ''}
                  {Math.abs(preview.bytesSavedPct ?? 0)}%)
                </strong>
                {preview.sampleCapturedAt && (
                  <> · sample from {new Date(preview.sampleCapturedAt).toLocaleString()}</>
                )}
              </span>
            )}
          </div>

          {previewError && (
            <p className="text-[11px] text-[var(--danger)]">{previewError}</p>
          )}
          {preview?.ok && preview.mappingError && (
            <p className="text-[11px] text-[var(--danger)]">
              Mapping failed ({preview.mappingError}) — the raw response is shown.
            </p>
          )}

          {preview?.ok && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <div>
                <p className="text-[10px] font-medium text-[var(--muted-foreground)] mb-1">
                  Raw response
                </p>
                <pre className="p-2 bg-[var(--muted)] rounded text-[10px] font-mono overflow-auto max-h-56">
                  {JSON.stringify(preview.raw, null, 2)}
                </pre>
              </div>
              <div>
                <p className="text-[10px] font-medium text-[var(--muted-foreground)] mb-1">
                  What the AI client receives
                </p>
                <pre className="p-2 bg-[var(--muted)] rounded text-[10px] font-mono overflow-auto max-h-56">
                  {JSON.stringify(preview.mapped, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
