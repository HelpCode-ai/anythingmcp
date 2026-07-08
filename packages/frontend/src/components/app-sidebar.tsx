'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useRef, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import { LogoIcon } from '@/components/logo-icon';
import { cn } from '@/lib/utils';

/* ── Inline icons (match the redesign prototype) ── */
function I({ d, children, ...p }: { d?: string; children?: React.ReactNode } & React.SVGProps<SVGSVGElement>) {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" {...p}>
      {d ? <path d={d} /> : children}
    </svg>
  );
}
const DashboardIcon = () => (
  <I><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></I>
);
const AnalyticsIcon = () => (
  <I><path d="M3 3v16a2 2 0 0 0 2 2h16" /><rect x="7" y="11" width="3" height="6" rx="0.6" /><rect x="12" y="7" width="3" height="10" rx="0.6" /><rect x="17" y="13" width="3" height="4" rx="0.6" /></I>
);
const LogsIcon = () => <I d="M16 12H3M16 6H3M16 18H3M21 12h.01M21 6h.01M21 18h.01" />;
const ConnectorsIcon = () => (
  <I><path d="M17 21v-2a1 1 0 0 1-1-1v-1a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1" /><path d="M19 15V6.5a1 1 0 0 0-7 0v11a1 1 0 0 1-7 0V9" /><path d="M21 21v-2h-4M3 5v2a1 1 0 0 0 1 1h1a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H4a1 1 0 0 0-1 1M7 5H3" /></I>
);
const StoreIcon = () => <I d="M3 9h18M3 9l1.5-5h15L21 9M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M9 13h6" />;
const McpIcon = () => (
  <I><rect width="20" height="8" x="2" y="2" rx="2" /><rect width="20" height="8" x="2" y="14" rx="2" /><path d="M6 6h.01M6 18h.01" /></I>
);
const KgIcon = () => (
  <I><circle cx="5" cy="6" r="2.4" /><circle cx="19" cy="6" r="2.4" /><circle cx="12" cy="18" r="2.4" /><path d="M7.2 7.2 10.6 16M16.8 7.2 13.4 16M7 6h10" /></I>
);
const SkillsIcon = () => <I d="m12 3 2.2 4.6 5 .7-3.6 3.5.9 5L12 14.9 7.5 16.8l.9-5L4.8 8.3l5-.7z" />;
const OnboardingIcon = () => <I><path d="M12 2v4M12 2a10 10 0 1 0 10 10" /><path d="m16 12-4 4-2-2" /></I>;
const SettingsIcon = () => (
  <I><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></I>
);

type NavLink = { href: string; label: string; icon: () => React.ReactNode };
type NavGroup = { group: string; items: NavLink[] };

const NAV: NavGroup[] = [
  {
    group: 'Overview',
    items: [
      { href: '/', label: 'Dashboard', icon: DashboardIcon },
      { href: '/analytics', label: 'Analytics', icon: AnalyticsIcon },
      { href: '/logs', label: 'Audit Log', icon: LogsIcon },
    ],
  },
  {
    group: 'Build',
    items: [
      { href: '/connectors', label: 'Connectors', icon: ConnectorsIcon },
      { href: '/connectors/store', label: 'Marketplace', icon: StoreIcon },
      { href: '/mcp-server', label: 'MCP Servers', icon: McpIcon },
    ],
  },
  {
    group: 'Intelligence',
    items: [
      { href: '/knowledge-graph', label: 'Knowledge Graph', icon: KgIcon },
      { href: '/knowledge-graph/skills', label: 'AI Skills', icon: SkillsIcon },
    ],
  },
  {
    group: 'Get started',
    items: [{ href: '/welcome', label: 'Setup & onboarding', icon: OnboardingIcon }],
  },
];

// All navigable hrefs, used to resolve the single active item: the longest
// href that prefix-matches the current path wins (so /connectors/store lights
// up "Marketplace" only, /knowledge-graph/skills lights up "AI Skills", etc.).
const ALL_HREFS = [...NAV.flatMap((g) => g.items.map((i) => i.href)), '/settings'];

function bestHref(pathname: string): string | null {
  let best: string | null = null;
  for (const href of ALL_HREFS) {
    const matches = href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(href + '/');
    if (matches && (!best || href.length > best.length)) best = href;
  }
  return best;
}

export function AppSidebar({ mobileOpen, onClose }: { mobileOpen: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const { user, orgName, orgs, switchOrg, logout } = useAuth();
  const [wsMenu, setWsMenu] = useState(false);
  const wsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (wsRef.current && !wsRef.current.contains(e.target as Node)) setWsMenu(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // Exactly one nav item is active: the longest href matching the current path.
  const active = bestHref(pathname);
  const settingsActive = active === '/settings';

  const orgInitials = (orgName || user?.email || 'A').slice(0, 2).toUpperCase();

  const navContent = (
    <>
      <div className="flex items-center gap-2.5 px-[18px] pb-4 pt-[18px]">
        <div
          className="flex h-[30px] w-[30px] items-center justify-center rounded-lg bg-[var(--brand)] text-white"
          style={{ boxShadow: '0 2px 8px var(--brand-ring)' }}
        >
          <LogoIcon size={18} />
        </div>
        <div className="text-[15px] font-semibold tracking-[-0.02em]">
          Anything<span className="text-[var(--brand)]">MCP</span>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3 py-1.5">
        {NAV.map((g) => (
          <div key={g.group}>
            <div className="px-2.5 pb-1 pt-2.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--text-3)]">
              {g.group}
            </div>
            {g.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onClose}
                  className={cn(
                    'flex w-full items-center gap-[11px] rounded-[9px] px-2.5 py-2 text-left text-[13.5px] font-medium transition-colors',
                    item.href === active
                      ? 'bg-[var(--brand-tint)] text-[var(--brand)]'
                      : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]'
                  )}
                >
                  <item.icon />
                  {item.label}
                </Link>
              ))}
          </div>
        ))}
      </nav>

      {/* Footer: Settings + workspace switcher */}
      <div className="relative border-t border-[var(--border)] p-3" ref={wsRef}>
        {wsMenu && (
          <div className="absolute inset-x-3 bottom-[64px] z-50 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow)]">
            <div className="px-3 py-2 text-[10.5px] font-semibold uppercase tracking-[0.05em] text-[var(--text-3)]">
              Switch workspace
            </div>
            {(orgs || []).map((org) => {
              const isCurrent = org.id === user?.organizationId;
              return (
                <button
                  key={org.id}
                  onClick={() => {
                    setWsMenu(false);
                    if (!isCurrent) switchOrg(org.id);
                  }}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left font-[inherit] hover:bg-[var(--surface-2)]"
                >
                  <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[7px] bg-[linear-gradient(135deg,var(--brand),#7c3aed)] text-[11px] font-semibold text-white">
                    {(org.name || '?').slice(0, 2).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-[var(--text)]">{org.name}</span>
                    <span className="block text-[11px] text-[var(--text-3)]">{org.role}</span>
                  </span>
                  {isCurrent && (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--brand)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                  )}
                </button>
              );
            })}
            <div className="border-t border-[var(--border)]">
              <button
                onClick={() => { setWsMenu(false); logout(); }}
                className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] font-medium text-[var(--danger)] hover:bg-[var(--t-danger-bg)]"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>
                Log out
              </button>
            </div>
          </div>
        )}

        <Link
          href="/settings"
          onClick={onClose}
          className={cn(
            'mb-1.5 flex w-full items-center gap-[11px] rounded-[9px] px-2.5 py-2 text-left text-[13.5px] font-medium transition-colors',
            settingsActive
              ? 'bg-[var(--brand-tint)] text-[var(--brand)]'
              : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]'
          )}
        >
          <SettingsIcon />
          Settings
        </Link>

        <button
          onClick={() => setWsMenu((v) => !v)}
          className="flex w-full items-center gap-2.5 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-2 text-left font-[inherit] hover:border-[var(--border-strong)]"
        >
          <div className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-lg bg-[linear-gradient(135deg,var(--brand),#7c3aed)] text-xs font-semibold text-white">
            {orgInitials}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-semibold text-[var(--text)]">{orgName || 'Workspace'}</div>
            <div className="text-[11px] text-[var(--text-3)]">{user?.email}</div>
          </div>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-3)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m7 15 5 5 5-5M7 9l5-5 5 5" /></svg>
        </button>
      </div>
    </>
  );

  return (
    <>
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          onClick={onClose}
          className="fixed inset-0 z-[60] bg-black/45 md:hidden"
        />
      )}
      <aside
        className={cn(
          'z-[70] flex w-[248px] flex-shrink-0 flex-col border-r border-[var(--border)] bg-[var(--sidebar)]',
          // desktop: in-flow; mobile: off-canvas drawer
          'max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:transition-transform',
          mobileOpen ? 'max-md:translate-x-0' : 'max-md:-translate-x-full'
        )}
      >
        {navContent}
      </aside>
    </>
  );
}
