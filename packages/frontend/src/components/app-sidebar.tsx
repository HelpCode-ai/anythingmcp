// File: packages/frontend/src/components/app-sidebar.tsx (Excerpt showing integration)

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useRef, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import { LogoIcon } from '@/components/logo-icon';
import { cn } from '@/lib/utils';
import { GithubStarButton } from '@/components/github-star-button';

// ... existing code ...

export function AppSidebar({ mobileOpen, setMobileOpen }: { mobileOpen: boolean; setMobileOpen: (open: boolean) => void }) {
  // ... existing code ...
  return (
    <>
      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-xs md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex flex-col border-r border-[var(--border)] bg-[var(--sidebar-bg)] transition-transform duration-200 ease-out md:static md:translate-x-0',
          collapsed ? 'w-[72px]' : 'w-[260px]',
          mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'
        )}
      >
        {/* Top header / logo */}
        <div className="flex h-16 items-center px-4 justify-between border-b border-[var(--border)]">
          <Link href="/dashboard" className="flex items-center gap-3 min-w-0">
            <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[10px] bg-[var(--text)] text-[var(--background)]">
              <LogoIcon className="h-5 w-5" />
            </div>
            {!collapsed && <span className="font-semibold text-sm tracking-tight truncate text-[var(--text)]">AnythingMCP</span>}
          </Link>
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="hidden md:flex h-7 w-7 items-center justify-center rounded-[7px] text-[var(--text-3)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {collapsed ? <path d="m9 18 6-6-6-6" /> : <path d="m15 18-6-6 6-6" />}
            </svg>
          </button>
        </div>

        {/* Nav Links */}
        <div className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
          {navLinks.map((link) => {
            const active = pathname === link.href || pathname.startsWith(link.href + '/');
            return (
              <Link
                key={link.href}
                href={link.href}
                title={collapsed ? link.label : undefined}
                className={cn(
                  'flex items-center gap-3 px-3 py-2.5 rounded-[10px] text-sm font-medium transition-colors',
                  active
                    ? 'bg-[var(--surface-2)] text-[var(--text)]'
                    : 'text-[var(--text-2)] hover:bg-[var(--surface)] hover:text-[var(--text)]'
                )}
              >
                <span className="flex-shrink-0">{link.icon}</span>
                {!collapsed && <span className="truncate">{link.label}</span>}
              </Link>
            );
          })}
        </div>

        {/* Footer / Star Button & User Profile */}
        <div className="p-3 border-t border-[var(--border)] space-y-2">
          {!collapsed && <GithubStarButton />}

          {/* User profile dropdown / section */}
          {user && (
            <div className="relative" ref={menuRef}>
              {/* ... user dropdown profile code ... */}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
