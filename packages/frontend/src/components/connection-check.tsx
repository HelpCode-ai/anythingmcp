'use client';

import { useEffect, useRef, useState } from 'react';
import { mcpServers, productEvents } from '@/lib/api';
import { Card } from '@/components/ui/card';

/** How often the page asks whether a request has arrived. */
const POLL_MS = 5_000;
/** After this long without a request the page stops asking (a reload restarts it). */
const POLL_FOR_MS = 30 * 60_000;

export function timeAgo(iso: string, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

type State =
  | { kind: 'loading' }
  | { kind: 'waiting' }
  | { kind: 'arrived'; at: string }
  | { kind: 'active'; at: string; calls: number };

/**
 * Shows, live, whether an AI client has reached this server yet.
 *
 * Most workspaces that attach a connector never send a single MCP request,
 * and nothing on the connect page told them whether the step they just did
 * in Claude or ChatGPT worked. While no request has arrived this polls the
 * server's activity and turns green the moment the first one lands.
 */
export function ConnectionCheck({ serverId, token }: { serverId: string; token: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const sawWaiting = useRef(false);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();

    const check = async () => {
      if (!live) return;
      // A hidden tab does not need an answer; ask again when it is visible.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        timer = setTimeout(check, POLL_MS);
        return;
      }
      try {
        const activity = await mcpServers.activity(serverId, token);
        if (!live) return;
        if (activity.lastCallAt) {
          if (sawWaiting.current) {
            setState({ kind: 'arrived', at: activity.lastCallAt });
            productEvents.track('first_call_seen', token, { serverId });
          } else {
            setState({ kind: 'active', at: activity.lastCallAt, calls: activity.calls30d });
          }
          return;
        }
        sawWaiting.current = true;
        setState({ kind: 'waiting' });
      } catch {
        // A failed poll is not news; keep the current state and try again.
      }
      if (Date.now() - startedAt < POLL_FOR_MS) timer = setTimeout(check, POLL_MS);
    };

    void check();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [serverId, token]);

  if (state.kind === 'loading') return null;

  if (state.kind === 'active') {
    return (
      <div
        className="flex items-center gap-2 rounded-[10px] px-3 py-2 text-[12.5px]"
        style={{ background: 'var(--t-emerald-bg)', color: 'var(--t-emerald-fg)' }}
      >
        <span className="h-2 w-2 rounded-full bg-[var(--ok)]" aria-hidden />
        Connected · last request {timeAgo(state.at)} · {state.calls.toLocaleString('en-US')} in 30 days
      </div>
    );
  }

  if (state.kind === 'arrived') {
    return (
      <Card className="p-[18px]" role="region" aria-label="Connection check" aria-live="polite">
        <div className="flex items-start gap-3">
          <span
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold"
            style={{ background: 'var(--t-emerald-bg)', color: 'var(--t-emerald-fg)' }}
            aria-hidden
          >
            ✓
          </span>
          <div>
            <div className="text-sm font-semibold">Connected — your AI client just called this server</div>
            <div className="mt-1 text-[12.5px] text-[var(--text-2)]">
              Everything works. Ask it anything your connectors can answer.
            </div>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-[18px]" role="region" aria-label="Connection check" aria-live="polite">
      <div className="flex items-start gap-3">
        <span className="relative mt-1 flex h-2.5 w-2.5 flex-shrink-0" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--brand)] opacity-60" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[var(--brand)]" />
        </span>
        <div>
          <div className="text-sm font-semibold">Waiting for the first request</div>
          <ol className="mt-2 list-decimal space-y-1 pl-4 text-[12.5px] text-[var(--text-2)]">
            <li>Pick your AI client under Quick Connect and add this server.</li>
            <li>Ask it to use one of your tools, e.g. &ldquo;What can you do with my connectors?&rdquo;</li>
            <li>This box turns green as soon as the request arrives.</li>
          </ol>
        </div>
      </div>
    </Card>
  );
}
