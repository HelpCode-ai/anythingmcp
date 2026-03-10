'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useRef, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';

/* Inline SVG logo component */
function LogoIcon({ size = 28 }: { size?: number }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 52 52"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
    >
      <line x1="26" y1="26" x2="26" y2="9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ opacity: 0.55 }} />
      <line x1="26" y1="26" x2="10" y2="40" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ opacity: 0.55 }} />
      <line x1="26" y1="26" x2="42" y2="40" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" style={{ opacity: 0.55 }} />
      <circle cx="26" cy="9" r="5" fill="currentColor" style={{ opacity: 0.65 }} />
      <circle cx="10" cy="40" r="5" fill="currentColor" style={{ opacity: 0.65 }} />
      <circle cx="42" cy="40" r="5" fill="currentColor" style={{ opacity: 0.65 }} />
      <circle cx="26" cy="26" r="10" fill="currentColor" />
      <circle cx="26" cy="26" r="5.5" fill="white" />
    </svg>
  );
}

const NAV_ITEMS = [
  { href: '/connectors', label: 'Connectors', icon: CableIcon },
  { href: '/mcp-server', label: 'MCP Servers', icon: ServerIcon },

  { href: '/logs', label: 'Logs', icon: ListIcon },
  { href: '/settings', label: 'Settings', icon: GearIcon },
];

interface NavBarProps {
  breadcrumbs?: { label: string; href: string }[];
  title?: string;
  actions?: React.ReactNode;
}

export function NavBar({ breadcrumbs, title, actions }: NavBarProps) {
  const { user, logout } = useAuth();
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const allNavItems = NAV_ITEMS;

  return (
    <header className="border-b border-[var(--border)] bg-[var(--background)]/95 backdrop-blur-sm sticky top-0 z-50">
      <div className="flex items-center justify-between max-w-7xl mx-auto px-4 sm:px-6 h-14">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2.5 group">
            <span className="transition-transform group-hover:scale-105 text-[var(--brand)]"><LogoIcon /></span>
            <span className="text-lg font-bold hidden sm:inline">Anything<span className="text-[var(--brand)]">MCP</span></span>
          </Link>
          {/* Desktop nav */}
          <nav className="hidden lg:flex items-center gap-1">
            {allNavItems.map((item) => {
              const isActive = item.href === '/settings'
                ? pathname === '/settings' || pathname.startsWith('/settings/')
                : pathname === item.href || pathname.startsWith(item.href + '/');
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm transition-colors ${
                    isActive
                      ? 'bg-[var(--brand-light)] text-[var(--brand)] font-medium'
                      : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)]'
                  }`}
                >
                  <item.icon size={15} />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="flex items-center gap-3 text-sm">
          {/* User dropdown (desktop) */}
          <div className="hidden sm:block relative" ref={userMenuRef}>
            <button
              onClick={() => setUserMenuOpen((v) => !v)}
              className="flex items-center text-[var(--muted-foreground)] hover:text-[var(--foreground)] p-1.5 rounded-full hover:bg-[var(--accent)] transition-colors"
            >
              <div className="w-7 h-7 rounded-full bg-[var(--brand)] text-white flex items-center justify-center text-xs font-medium">
                {(user?.name || user?.email || '?')[0].toUpperCase()}
              </div>
            </button>
            {userMenuOpen && (
              <div className="absolute right-0 mt-1 w-48 bg-[var(--background)] border border-[var(--border)] rounded-lg shadow-lg py-1 z-50">
                <div className="px-3 py-2 border-b border-[var(--border)]">
                  <p className="text-xs font-medium truncate">{user?.name || user?.email}</p>
                  {user?.name && <p className="text-xs text-[var(--muted-foreground)] truncate">{user?.email}</p>}
                </div>
                <button
                  onClick={() => { setUserMenuOpen(false); logout(); }}
                  className="w-full text-left px-3 py-2 text-sm text-[var(--destructive)] hover:bg-[var(--accent)] transition-colors flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                  </svg>
                  Logout
                </button>
              </div>
            )}
          </div>
          {/* Mobile hamburger */}
          <button
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            className="lg:hidden p-1.5 rounded-md hover:bg-[var(--accent)] text-[var(--muted-foreground)]"
            aria-label="Toggle menu"
          >
            {mobileMenuOpen ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="18" x2="20" y2="18" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Mobile nav dropdown */}
      {mobileMenuOpen && (
        <nav className="lg:hidden border-t border-[var(--border)] px-4 py-2 space-y-1">
          {allNavItems.map((item) => {
            const isActive = item.href === '/settings'
              ? pathname === '/settings' || pathname.startsWith('/settings/')
              : pathname === item.href || pathname.startsWith(item.href + '/');
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileMenuOpen(false)}
                className={`flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? 'bg-[var(--brand-light)] text-[var(--brand)] font-medium'
                    : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)]'
                }`}
              >
                <item.icon size={16} />
                {item.label}
              </Link>
            );
          })}
          <div className="sm:hidden flex items-center justify-between px-3 py-2 border-t border-[var(--border)] mt-2 pt-3">
            <div className="flex items-center gap-2 text-[var(--muted-foreground)]">
              <div className="w-6 h-6 rounded-full bg-[var(--brand)] text-white flex items-center justify-center text-xs font-medium">
                {(user?.name || user?.email || '?')[0].toUpperCase()}
              </div>
              <span className="text-xs truncate max-w-[150px]">{user?.email}</span>
            </div>
            <button
              onClick={logout}
              className="text-[var(--muted-foreground)] hover:text-[var(--destructive)] text-xs"
            >
              Logout
            </button>
          </div>
        </nav>
      )}

      {/* Breadcrumbs + Actions bar */}
      {(breadcrumbs || actions) && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 max-w-7xl mx-auto px-4 sm:px-6 py-2 text-sm border-t border-[var(--border)]">
          <div className="flex items-center gap-1.5 text-[var(--muted-foreground)]">
            {breadcrumbs?.map((crumb, i) => (
              <span key={crumb.href} className="flex items-center gap-1.5">
                {i > 0 && <ChevronRightIcon size={12} />}
                <Link href={crumb.href} className="hover:text-[var(--foreground)] hover:underline">
                  {crumb.label}
                </Link>
              </span>
            ))}
            {title && (
              <>
                {breadcrumbs && breadcrumbs.length > 0 && <ChevronRightIcon size={12} />}
                <span className="text-[var(--foreground)] font-medium">{title}</span>
              </>
            )}
          </div>
          {actions && <div>{actions}</div>}
        </div>
      )}
    </header>
  );
}

/* Minimal inline SVG icons */

function CableIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a1 1 0 0 1-1-1v-1a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1" />
      <path d="M19 15V6.5a1 1 0 0 0-7 0v11a1 1 0 0 1-7 0V9" />
      <path d="M21 21v-2h-4" />
      <path d="M3 5v2a1 1 0 0 0 1 1h1a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H4a1 1 0 0 0-1 1" />
      <path d="M7 5H3" />
    </svg>
  );
}

function ServerIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
      <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
      <line x1="6" x2="6.01" y1="6" y2="6" />
      <line x1="6" x2="6.01" y1="18" y2="18" />
    </svg>
  );
}

function ListIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 12H3" />
      <path d="M16 6H3" />
      <path d="M16 18H3" />
      <path d="M21 12h.01" />
      <path d="M21 6h.01" />
      <path d="M21 18h.01" />
    </svg>
  );
}

function GearIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function UsersIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function ShieldIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </svg>
  );
}

function ChevronRightIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

export { LogoIcon };
