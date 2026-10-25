'use client';

import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import * as Dialog from '@radix-ui/react-dialog';
import { useAuth } from '@/lib/auth-context';
import { useTheme } from '@/lib/theme-context';
import { connectors, mcpServers, type Connector, type McpServer } from '@/lib/api';
import { NAV, SIDEBAR_SECTIONS, getVisibleSettingsSections } from '@/lib/navigation';
import { cn } from '@/lib/utils';

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface CommandItem {
  id: string;
  label: string;
  description?: string;
  group: 'Pages' | 'Settings' | 'Connectors' | 'MCP servers' | 'Actions';
  keywords?: string[];
  href?: string;
  action?: () => void | Promise<void>;
}

interface ResultGroup {
  name: string;
  items: CommandItem[];
}

import {
  recordsCache,
  inFlightRequests,
  clearCommandPaletteCache,
  type OrgRecordsCache,
} from '@/lib/command-palette-cache';

export { clearCommandPaletteCache };

function fetchOrgRecords(orgId: string, token: string): Promise<OrgRecordsCache> {
  const pending = inFlightRequests.get(orgId);
  if (pending) return pending;

  const promise = Promise.all([connectors.list(token), mcpServers.list(token)])
    .then(([connList, mcpList]) => {
      if (Array.isArray(connList) && Array.isArray(mcpList)) {
        const result: OrgRecordsCache = { connectors: connList, mcpServers: mcpList };
        recordsCache.set(orgId, result);
        return result;
      }
      throw new Error('Connectors or MCP servers response is not an array');
    })
    .finally(() => {
      inFlightRequests.delete(orgId);
    });

  inFlightRequests.set(orgId, promise);
  return promise;
}

function matchesWords(
  label: string,
  keywords: string[] | undefined,
  description: string | undefined,
  words: string[]
): boolean {
  if (words.length === 0) return true;
  const searchable = [label, ...(keywords || []), description || ''].join(' ').toLowerCase();
  return words.every((word) => searchable.includes(word));
}

function sanitizeId(prefix: string, path: string): string {
  const clean = path.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
  return `${prefix}-${clean || 'home'}`;
}

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /(Mac|iPhone|iPod|iPad)/i.test(navigator.userAgent || navigator.platform || '');
}

interface ResultListProps {
  groupedResults: ResultGroup[];
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  executeItem: (item: CommandItem) => void;
  query: string;
  listRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Result list child component rendered inside the command palette dialog.
 * Improves accessibility with role="group" and aria-labelledby for each group.
 */
function CommandPaletteResultList({
  groupedResults,
  activeIndex,
  setActiveIndex,
  executeItem,
  query,
  listRef,
}: ResultListProps) {
  let currentIndexTracker = 0;

  return (
    <div
      id="command-palette-results"
      role="listbox"
      aria-label="Commands"
      ref={listRef}
      className="max-h-[360px] overflow-y-auto p-2"
    >
      {groupedResults.length === 0 ? (
        <div className="py-8 text-center text-[13px] text-[var(--text-3)]">
          {query ? (
            <>
              No results found for &ldquo;<span className="font-medium text-[var(--text-2)]">{query}</span>&rdquo;
            </>
          ) : (
            'No commands available'
          )}
        </div>
      ) : (
        groupedResults.map((group) => {
          const groupHeaderId = sanitizeId('group-header', group.name);
          return (
            <div
              key={group.name}
              role="group"
              aria-labelledby={groupHeaderId}
              className="mb-2 last:mb-0"
            >
              <div
                id={groupHeaderId}
                className="px-2.5 pb-1 pt-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--text-3)]"
              >
                {group.name}
              </div>
              {group.items.map((item) => {
                const itemIndex = currentIndexTracker++;
                const isSelected = itemIndex === activeIndex;

                return (
                  <div
                    key={item.id}
                    id={item.id}
                    role="option"
                    aria-selected={isSelected}
                    data-index={itemIndex}
                    onClick={() => executeItem(item)}
                    onMouseEnter={() => setActiveIndex(itemIndex)}
                    className={cn(
                      'flex cursor-pointer items-center justify-between gap-3 rounded-[9px] px-2.5 py-2 text-left text-[13px] transition-colors',
                      isSelected
                        ? 'bg-[var(--brand-tint)] text-[var(--brand)] font-medium'
                        : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]'
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className={cn('truncate', isSelected ? 'text-[var(--brand)]' : 'text-[var(--text)]')}>
                        {item.label}
                      </div>
                      {item.description && (
                        <div className="truncate text-[11px] text-[var(--text-3)]">
                          {item.description}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {isSelected && (
                        <kbd className="hidden sm:inline-flex items-center rounded border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-mono text-[var(--text-3)]">
                          ↵
                        </kbd>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })
      )}
    </div>
  );
}

interface CommandPaletteContentProps {
  onClose: () => void;
}

/**
 * Child component rendered inside Dialog.Content only while the palette is open.
 * Ensures search query is reset on every open and groupedResults is never computed when closed.
 */
function CommandPaletteContent({ onClose }: CommandPaletteContentProps) {
  const router = useRouter();
  const { token, user, orgs, switchOrg, logout, deploymentMode } = useAuth();
  const { resolvedTheme, setTheme } = useTheme();

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const orgId = user?.organizationId;
  const cached = orgId ? recordsCache.get(orgId) : null;

  const [connectorsData, setConnectorsData] = useState<Connector[] | null>(cached?.connectors ?? null);
  const [mcpServersData, setMcpServersData] = useState<McpServer[] | null>(cached?.mcpServers ?? null);
  const [isLoadingRecords, setIsLoadingRecords] = useState(() => !cached && Boolean(token && orgId));

  const isAdmin = user?.role === 'ADMIN';
  const isViewer = user?.role === 'VIEWER';
  const isCloud = deploymentMode === 'cloud';
  const isDark = resolvedTheme === 'dark';

  // Load/refresh records from API (stale-while-revalidate)
  useEffect(() => {
    if (!token || !user?.organizationId) return;

    const currentOrgId = user.organizationId;
    let active = true;

    fetchOrgRecords(currentOrgId, token)
      .then((data) => {
        if (!active) return;
        setConnectorsData(data.connectors);
        setMcpServersData(data.mcpServers);
      })
      .catch(() => {
        if (!active) return;
        // Keep existing cached data if present; if initial fetch failed, fallback to empty arrays
        setConnectorsData((prev) => prev ?? []);
        setMcpServersData((prev) => prev ?? []);
      })
      .finally(() => {
        if (active) {
          setIsLoadingRecords(false);
        }
      });

    return () => {
      active = false;
    };
  }, [token, user?.organizationId]);

  // Parse words from search query
  const queryWords = useMemo(() => {
    return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  }, [query]);

  // Generate candidates for all 5 groups
  const groupedResults = useMemo(() => {
    // 1. Pages
    const pagesCandidates: CommandItem[] = NAV.flatMap((group) =>
      group.items.map((item) => ({
        id: sanitizeId('page', item.href),
        label: item.label,
        description: group.group,
        group: 'Pages' as const,
        keywords: item.keywords,
        href: item.href,
      }))
    );
    const pages = pagesCandidates
      .filter((i) => matchesWords(i.label, i.keywords, i.description, queryWords))
      .slice(0, 8);

    // 2. Settings (using shared visibility filtering helper)
    const visibleSections = getVisibleSettingsSections(SIDEBAR_SECTIONS, { isAdmin, isCloud });
    const settingsCandidates: CommandItem[] = visibleSections.flatMap((section) =>
      section.items.map((item) => ({
        id: sanitizeId('settings', item.href),
        label: item.label,
        description: item.description,
        group: 'Settings' as const,
        keywords: item.keywords,
        href: item.href,
      }))
    );
    const settings = settingsCandidates
      .filter((i) => matchesWords(i.label, i.keywords, i.description, queryWords))
      .slice(0, 8);

    // 3. Connectors
    const connectorItems: CommandItem[] = (connectorsData || []).map((c) => ({
      id: `connector-${c.id}`,
      label: c.name || 'Unnamed connector',
      description: c.type ? `${c.type} connector` : undefined,
      group: 'Connectors' as const,
      keywords: [c.type, c.slug, 'connector'].filter(Boolean) as string[],
      href: `/connectors/${c.id}`,
    }));
    const connectorsGroup = connectorItems
      .filter((i) => matchesWords(i.label, i.keywords, i.description, queryWords))
      .slice(0, 8);

    // 4. MCP servers
    const mcpItems: CommandItem[] = (mcpServersData || []).map((s) => ({
      id: `mcp-${s.id}`,
      label: s.name || 'Unnamed server',
      description: s.slug || 'MCP server',
      group: 'MCP servers' as const,
      keywords: [s.slug, 'mcp', 'server'].filter(Boolean) as string[],
      href: `/mcp-server/${s.id}`,
    }));
    const mcpServersGroup = mcpItems
      .filter((i) => matchesWords(i.label, i.keywords, i.description, queryWords))
      .slice(0, 8);

    // 5. Actions
    const actionCandidates: CommandItem[] = [];

    // Add connector (hidden for VIEWER)
    if (!isViewer) {
      actionCandidates.push({
        id: 'action-add-connector',
        label: 'Add connector',
        description: 'Create a new connector',
        group: 'Actions' as const,
        keywords: ['add connector', 'create', 'new', 'connector', 'import'],
        href: '/connectors/new',
      });
    }

    actionCandidates.push({
      id: 'action-browse-marketplace',
      label: 'Browse Marketplace',
      description: 'Find and install connectors',
      group: 'Actions' as const,
      keywords: ['browse marketplace', 'store', 'marketplace', 'catalog', 'adapters'],
      href: '/connectors/store',
    });

    actionCandidates.push({
      id: 'action-toggle-theme',
      label: 'Toggle theme',
      description: isDark ? 'Switch to light mode' : 'Switch to dark mode',
      group: 'Actions' as const,
      keywords: ['toggle theme', 'theme', 'dark', 'light', 'mode'],
      action: () => setTheme(isDark ? 'light' : 'dark'),
    });

    // Workspace switchers: safely guard orgs with Array.isArray
    const otherOrgs = Array.isArray(orgs) ? orgs.filter((o) => o?.id !== user?.organizationId) : [];
    for (const org of otherOrgs) {
      actionCandidates.push({
        id: `action-switch-org-${org.id}`,
        label: `Switch to ${org.name}`,
        description: `Workspace (${org.role})`,
        group: 'Actions' as const,
        keywords: ['switch to', 'workspace', 'organization', 'org', org.name],
        action: () => {
          clearCommandPaletteCache();
          switchOrg(org.id);
        },
      });
    }

    actionCandidates.push({
      id: 'action-logout',
      label: 'Log out',
      description: 'Sign out of your account',
      group: 'Actions' as const,
      keywords: ['log out', 'logout', 'sign out'],
      action: () => {
        clearCommandPaletteCache();
        logout();
      },
    });

    const actions = actionCandidates
      .filter((i) => matchesWords(i.label, i.keywords, i.description, queryWords))
      .slice(0, 8);

    return [
      { name: 'Pages', items: pages },
      { name: 'Settings', items: settings },
      { name: 'Connectors', items: connectorsGroup },
      { name: 'MCP servers', items: mcpServersGroup },
      { name: 'Actions', items: actions },
    ].filter((group) => group.items.length > 0);
  }, [
    queryWords,
    isAdmin,
    isViewer,
    isCloud,
    isDark,
    connectorsData,
    mcpServersData,
    orgs,
    user?.organizationId,
    setTheme,
    switchOrg,
    logout,
  ]);

  // Flattened items for single-index keyboard navigation
  const flatItems = useMemo(() => {
    return groupedResults.flatMap((g) => g.items);
  }, [groupedResults]);

  // Derive safe bounded active index
  const safeActiveIndex =
    flatItems.length === 0
      ? -1
      : activeIndex >= flatItems.length || activeIndex < 0
      ? 0
      : activeIndex;

  // Scroll active item into view
  useEffect(() => {
    if (safeActiveIndex >= 0 && listRef.current) {
      const activeEl = listRef.current.querySelector(`[data-index="${safeActiveIndex}"]`) as HTMLElement | null;
      if (activeEl) {
        activeEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [safeActiveIndex]);

  const executeItem = useCallback(
    (item: CommandItem) => {
      onClose();
      if (item.action) {
        item.action();
      } else if (item.href) {
        router.push(item.href);
      }
    },
    [onClose, router]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (flatItems.length > 0) {
        setActiveIndex((prev) => {
          const current = prev >= 0 && prev < flatItems.length ? prev : 0;
          return (current + 1) % flatItems.length;
        });
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (flatItems.length > 0) {
        setActiveIndex((prev) => {
          const current = prev >= 0 && prev < flatItems.length ? prev : 0;
          return (current - 1 + flatItems.length) % flatItems.length;
        });
      }
    } else if (e.key === 'Enter') {
      // Ignore Enter while IME composition is active
      if (e.nativeEvent.isComposing || (e as any).isComposing) {
        return;
      }
      e.preventDefault();
      if (safeActiveIndex >= 0 && safeActiveIndex < flatItems.length) {
        executeItem(flatItems[safeActiveIndex]);
      }
    }
  };

  const activeItem = safeActiveIndex >= 0 ? flatItems[safeActiveIndex] : null;

  return (
    <>
      {/* Search Input Bar */}
      <div className="flex items-center gap-2.5 border-b border-[var(--border)] px-4 py-3">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="flex-shrink-0 text-[var(--text-3)]"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="command-palette-results"
          aria-activedescendant={activeItem ? activeItem.id : undefined}
          aria-autocomplete="list"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Type a command or search..."
          className="flex-1 bg-transparent text-[14px] text-[var(--text)] placeholder-[var(--text-3)] focus:outline-none"
          autoComplete="off"
          autoCorrect="off"
          spellCheck="false"
          autoFocus
        />
        {query ? (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              inputRef.current?.focus();
            }}
            className="rounded p-0.5 text-[var(--text-3)] hover:text-[var(--text)]"
            aria-label="Clear search"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        ) : (
          <kbd className="hidden sm:inline-flex items-center rounded border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-3)]">
            ESC
          </kbd>
        )}
      </div>

      {/* Loading Status: rendered outside the listbox to conform to ARIA standards */}
      {isLoadingRecords && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-2 text-xs text-[var(--text-3)]"
        >
          <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--brand)]" />
          <span>Loading connectors and servers...</span>
        </div>
      )}

      {/* Results Area */}
      <CommandPaletteResultList
        groupedResults={groupedResults}
        activeIndex={safeActiveIndex}
        setActiveIndex={setActiveIndex}
        executeItem={executeItem}
        query={query}
        listRef={listRef}
      />

      {/* Footer Navigation Hints */}
      <div className="flex items-center justify-between border-t border-[var(--border)] bg-[var(--surface-2)]/40 px-3.5 py-2 text-[11px] text-[var(--text-3)]">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-[var(--border)] bg-[var(--surface)] px-1 py-0.5 text-[10px]">↑</kbd>
            <kbd className="rounded border border-[var(--border)] bg-[var(--surface)] px-1 py-0.5 text-[10px]">↓</kbd>
            <span>Navigate</span>
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-[var(--border)] bg-[var(--surface)] px-1 py-0.5 text-[10px]">↵</kbd>
            <span>Select</span>
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-[var(--border)] bg-[var(--surface)] px-1 py-0.5 text-[10px]">esc</kbd>
            <span>Close</span>
          </span>
        </div>
        <div className="text-[10.5px]">
          Anything<span className="text-[var(--brand)]">MCP</span>
        </div>
      </div>
    </>
  );
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const triggerElementRef = useRef<HTMLElement | null>(null);

  // Keyboard shortcut listener: ⌘K on macOS, Ctrl+K on other platforms
  // Ignores shortcut when Shift or Alt is held, does not hijack macOS Ctrl+K
  useEffect(() => {
    function handleGlobalKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented) return;
      if (e.key !== 'k' && e.key !== 'K' && e.code !== 'KeyK') return;
      if (e.shiftKey || e.altKey) return;

      const isMac = isMacPlatform();
      const matches = isMac ? (e.metaKey && !e.ctrlKey) : (e.ctrlKey && !e.metaKey);

      if (matches) {
        e.preventDefault();
        if (!open && typeof document !== 'undefined') {
          triggerElementRef.current = (document.activeElement as HTMLElement) ?? null;
        }
        onOpenChange(!open);
      }
    }
    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, [open, onOpenChange]);

  // Track the trigger element when dialog opens
  useEffect(() => {
    if (open && typeof document !== 'undefined' && !triggerElementRef.current) {
      triggerElementRef.current = (document.activeElement as HTMLElement) ?? null;
    }
  }, [open]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen && typeof document !== 'undefined' && !triggerElementRef.current) {
        triggerElementRef.current = (document.activeElement as HTMLElement) ?? null;
      }
      onOpenChange(nextOpen);
    },
    [onOpenChange]
  );

  // Restore keyboard focus to the opening element when dialog closes
  const handleCloseAutoFocus = useCallback((event: Event) => {
    const el = triggerElementRef.current;
    triggerElementRef.current = null;
    if (el && typeof el.focus === 'function' && el.isConnected) {
      event.preventDefault();
      el.focus();
    }
  }, []);

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-xs data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
        <Dialog.Content
          className="fixed left-1/2 top-[15%] sm:top-[20%] z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-[14px] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-lg,0_16px_48px_rgba(0,0,0,0.2))] flex flex-col p-0 focus:outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
          aria-describedby={undefined}
          onCloseAutoFocus={handleCloseAutoFocus}
        >
          <Dialog.Title className="sr-only">Command Palette</Dialog.Title>
          {open && <CommandPaletteContent onClose={() => onOpenChange(false)} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
