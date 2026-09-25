'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  adapters,
  productEvents,
  type StarterPackInstallResult,
  type StarterPackItem,
} from '@/lib/api';
import { findDemoBySlug } from '@/lib/demo-connectors';
import { Button } from '@/components/ui/button';
import { ConnectorLogo } from '@/components/connector-logo';

/**
 * The starter pack on /welcome: a few keyless connectors, ticked by default,
 * added in one click and put on the user's MCP server. A new workspace used
 * to start empty; this gives it something that works before any credentials
 * are asked for, without installing anything the user did not choose.
 */
export function StarterPack({ token }: { token: string }) {
  const [items, setItems] = useState<StarterPackItem[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState<{
    results: StarterPackInstallResult[];
    server: { id: string; name: string } | null;
  } | null>(null);
  const viewed = useRef(false);

  useEffect(() => {
    adapters
      .starterPack(token)
      .then((res) => {
        const list = Array.isArray(res) ? res : [];
        setItems(list);
        setSelected(new Set(list.filter((i) => i.preselected && !i.installed).map((i) => i.slug)));
        if (list.length > 0 && !viewed.current) {
          viewed.current = true;
          productEvents.track('starter_pack_viewed', token);
        }
      })
      // Nothing to offer is not an error the user can act on: the page
      // still has the marketplace and the custom-API paths below.
      .catch(() => setItems([]));
  }, [token]);

  if (!items || items.length === 0) return null;

  const offered = items.filter((i) => !i.installed);
  const allInstalled = offered.length === 0;

  const toggle = (slug: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  const install = async () => {
    if (installing || selected.size === 0) return;
    setInstalling(true);
    setError('');
    try {
      const res = await adapters.installStarterPack(Array.from(selected), token);
      setOutcome(res);
      const done = new Set(res.results.filter((r) => r.status !== 'failed').map((r) => r.slug));
      setItems((prev) => prev?.map((i) => (done.has(i.slug) ? { ...i, installed: true } : i)) ?? prev);
    } catch (err: any) {
      setError(err?.message || 'Could not add the connectors. Try again.');
    } finally {
      setInstalling(false);
    }
  };

  const bySlug = new Map(items.map((i) => [i.slug, i]));

  return (
    <section aria-labelledby="starter-pack-title" className="mb-10">
      <p className="mb-1.5 font-mono text-xs uppercase tracking-[0.14em] text-[var(--brand)]">
        Starter pack
      </p>
      <h2 id="starter-pack-title" className="text-lg font-semibold text-[var(--text)]">
        Start with connectors that need no keys
      </h2>
      <p className="mt-1 mb-4 text-sm text-[var(--text-2)]">
        We add them to your MCP server, so your AI can use them as soon as you connect it. Untick
        what you don&apos;t need; you can remove any of them later.
      </p>

      {outcome ? (
        <StarterPackOutcome outcome={outcome} bySlug={bySlug} />
      ) : allInstalled ? (
        <div className="rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-4 text-sm text-[var(--text-2)]">
          You already have every connector in the starter pack.{' '}
          <Link href="/connectors" className="font-medium text-[var(--brand)] hover:underline">
            See your connectors →
          </Link>
        </div>
      ) : (
        <>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => {
              const checked = item.installed || selected.has(item.slug);
              return (
                <li key={item.slug} className="min-w-0">
                  <label
                    className={
                      'flex h-full min-w-0 gap-3 rounded-[14px] border p-4 transition-colors ' +
                      (item.installed
                        ? 'cursor-default border-[var(--border)] bg-[var(--surface-2)] opacity-80'
                        : checked
                          ? 'cursor-pointer border-[var(--brand)] bg-[var(--brand-tint)]'
                          : 'cursor-pointer border-[var(--border)] bg-[var(--surface)] hover:border-[var(--border-strong)]')
                    }
                  >
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={checked}
                      disabled={item.installed || installing}
                      onChange={() => toggle(item.slug)}
                      aria-describedby={`starter-${item.slug}-pitch`}
                    />
                    <ConnectorLogo icon={item.icon} name={item.name} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-start justify-between gap-2">
                        <span className="text-sm font-semibold leading-snug text-[var(--text)]">
                          {item.name}
                        </span>
                        <Tick checked={checked} muted={item.installed} />
                      </span>
                      <span
                        id={`starter-${item.slug}-pitch`}
                        className="mt-1 block text-[13px] leading-snug text-[var(--text-2)]"
                      >
                        {item.pitch}
                      </span>
                      <span className="mt-2 block text-xs text-[var(--text-3)]">
                        {item.installed
                          ? 'Already added'
                          : `${item.toolCount} tool${item.toolCount === 1 ? '' : 's'} · no key`}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>

          {error && (
            <p
              role="alert"
              className="mt-3 rounded-[9px] bg-[var(--t-danger-bg)] p-2.5 text-xs text-[var(--t-danger-fg)]"
            >
              {error}
            </p>
          )}

          <div className="mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-[var(--text-3)]" aria-live="polite">
              {selected.size === 0
                ? 'Nothing selected.'
                : `${selected.size} of ${offered.length} selected.`}
            </p>
            <Button
              variant="primary"
              size="lg"
              onClick={install}
              disabled={installing || selected.size === 0}
              className="w-full sm:w-auto"
            >
              {installing
                ? `Adding ${selected.size} connector${selected.size === 1 ? '' : 's'}…`
                : selected.size === 0
                  ? 'Select a connector'
                  : `Add ${selected.size} connector${selected.size === 1 ? '' : 's'}`}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

function StarterPackOutcome({
  outcome,
  bySlug,
}: {
  outcome: { results: StarterPackInstallResult[]; server: { id: string; name: string } | null };
  bySlug: Map<string, StarterPackItem>;
}) {
  const added = outcome.results.filter((r) => r.status === 'installed');
  const failed = outcome.results.filter((r) => r.status === 'failed');
  return (
    <div className="rounded-[14px] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5">
      <p role="status" className="text-sm font-semibold text-[var(--text)]">
        {added.length > 0
          ? `Added ${added.length} connector${added.length === 1 ? '' : 's'}${
              outcome.server ? ` to ${outcome.server.name}` : ''
            }.`
          : failed.length > 0
            ? 'No connector could be added.'
            : 'These connectors were already there.'}
      </p>
      <ul className="mt-3 divide-y divide-[var(--border)]">
        {outcome.results.map((r) => {
          const item = bySlug.get(r.slug);
          const demo = r.connectorId ? findDemoBySlug(r.slug) : undefined;
          return (
            <li key={r.slug} className="flex min-w-0 items-center gap-3 py-2.5">
              <ConnectorLogo icon={item?.icon ?? r.slug} name={item?.name ?? r.slug} small />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-[var(--text)]">
                  {item?.name ?? r.slug}
                </span>
                <span
                  className="block text-xs"
                  style={{ color: r.status === 'failed' ? 'var(--danger)' : 'var(--text-3)' }}
                >
                  {r.status === 'installed'
                    ? `Added · ${r.toolsCreated ?? 0} tool${r.toolsCreated === 1 ? '' : 's'}${r.probeOk === false ? ' · first test call failed' : ''}`
                    : r.status === 'already_installed'
                      ? 'Already added'
                      : `Not added: ${r.error ?? 'unknown error'}`}
                </span>
              </span>
              {demo && r.connectorId && (
                <Link
                  href={`/connectors/${r.connectorId}?demoTool=${encodeURIComponent(demo.tool)}&autorun=1&from=welcome`}
                  className="shrink-0 rounded-[8px] px-2 py-1.5 text-sm font-medium text-[var(--brand)] hover:bg-[var(--brand-tint)]"
                >
                  Try it →
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        {outcome.server && (
          <Link
            href={`/mcp-server/${outcome.server.id}`}
            className="inline-flex h-11 w-full items-center justify-center rounded-[10px] bg-[var(--brand)] px-4 text-sm font-semibold text-white hover:opacity-90 sm:w-auto"
          >
            Connect your AI client →
          </Link>
        )}
        <Link
          href="/connectors/store?from=welcome"
          className="inline-flex h-11 w-full items-center justify-center rounded-[10px] border border-[var(--border)] px-4 text-sm font-medium text-[var(--text)] hover:border-[var(--border-strong)] sm:w-auto"
        >
          Browse more connectors
        </Link>
      </div>
    </div>
  );
}

function Tick({ checked, muted }: { checked: boolean; muted?: boolean }) {
  return (
    <span
      aria-hidden
      className="mt-0.5 flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-[5px] border-[1.5px]"
      style={{
        borderColor: checked ? (muted ? 'var(--text-3)' : 'var(--brand)') : 'var(--border-strong)',
        background: checked ? (muted ? 'var(--text-3)' : 'var(--brand)') : 'transparent',
      }}
    >
      {checked && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )}
    </span>
  );
}
