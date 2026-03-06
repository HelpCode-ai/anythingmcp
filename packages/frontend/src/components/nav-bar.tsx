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
      viewBox="-27.7889 7.4687 539.3757 461.4435"
      width={size}
      height={size}
      fill="#6366f1"
      aria-hidden="true"
    >
      <path d="M 169.824 76.228 C 179.799 76.228 187.824 84.254 187.824 94.228 C 187.824 104.202 179.799 112.228 169.824 112.228 C 159.85 112.228 151.824 104.202 151.824 94.228 C 151.824 84.254 159.85 76.228 169.824 76.228 Z M 169.824 142.228 C 170.65 142.228 171.475 142.228 172.299 142.153 L 192.475 185.353 C 168.999 201.628 152.199 226.903 147.324 256.228 L 94.375 256.228 C 87.25 238.602 69.999 226.228 49.899 226.228 C 23.424 226.228 1.899 247.753 1.899 274.228 C 1.899 300.702 23.424 322.228 49.899 322.228 C 70.075 322.228 87.324 309.854 94.375 292.228 L 147.324 292.228 C 155.873 343.302 200.349 382.228 253.824 382.228 C 286.675 382.228 316.073 367.602 335.873 344.428 L 386.424 374.728 C 386.05 377.128 385.824 379.677 385.824 382.153 C 385.824 408.628 407.349 430.153 433.824 430.153 C 460.299 430.153 481.824 408.628 481.824 382.153 C 481.824 355.677 460.299 334.153 433.824 334.153 C 422.949 334.153 412.975 337.752 404.949 343.828 L 354.473 313.528 C 359.273 301.303 361.899 288.028 361.899 274.153 C 361.899 256.752 357.775 240.254 350.424 225.702 L 408.624 183.028 C 415.975 187.602 424.599 190.228 433.899 190.228 C 460.373 190.228 481.899 168.702 481.899 142.228 C 481.899 115.753 460.373 94.228 433.899 94.228 C 407.424 94.228 385.899 115.753 385.899 142.228 C 385.899 146.277 386.424 150.252 387.324 154.002 L 329.124 196.677 C 309.699 177.778 283.149 166.153 253.899 166.153 C 243.925 166.153 234.325 167.503 225.173 170.052 L 204.999 126.928 C 212.949 118.378 217.824 106.903 217.824 94.228 C 217.824 67.753 196.299 46.228 169.824 46.228 C 143.349 46.228 121.824 67.753 121.824 94.228 C 121.824 120.702 143.349 142.228 169.824 142.228 Z M 433.824 124.228 C 443.799 124.228 451.824 132.254 451.824 142.228 C 451.824 152.202 443.799 160.228 433.824 160.228 C 423.85 160.228 415.824 152.202 415.824 142.228 C 415.824 132.254 423.85 124.228 433.824 124.228 Z M 415.824 382.228 C 415.824 372.254 423.85 364.228 433.824 364.228 C 443.799 364.228 451.824 372.254 451.824 382.228 C 451.824 392.202 443.799 400.228 433.824 400.228 C 423.85 400.228 415.824 392.202 415.824 382.228 Z M 49.824 256.228 C 59.799 256.228 67.824 264.254 67.824 274.228 C 67.824 284.202 59.799 292.228 49.824 292.228 C 39.85 292.228 31.824 284.202 31.824 274.228 C 31.824 264.254 39.85 256.228 49.824 256.228 Z M 253.824 202.228 C 293.575 202.228 325.824 234.477 325.824 274.228 C 325.824 313.978 293.575 346.228 253.824 346.228 C 214.075 346.228 181.824 313.978 181.824 274.228 C 181.824 234.477 214.075 202.228 253.824 202.228 Z" style={{ transformOrigin: "241.899px 238.19px" }} transform="matrix(0.98480803, 0.17364803, -0.17364803, 0.98480803, -0.00000707, -0.00000196)" />
      <path d="M 284.771 235.232 C 279.677 235.232 275.51 239.399 275.51 244.493 L 275.51 303.76 C 275.51 308.854 279.677 313.021 284.771 313.021 C 289.864 313.021 294.031 308.854 294.031 303.76 L 294.031 244.493 C 294.031 239.399 289.864 235.232 284.771 235.232 Z" />
      <path d="M 237.68 240.789 C 236.199 237.408 232.865 235.232 229.207 235.232 C 225.549 235.232 222.215 237.408 220.734 240.789 L 194.804 300.056 C 192.766 304.732 194.896 310.196 199.573 312.234 C 204.25 314.271 209.714 312.141 211.751 307.464 L 214.205 301.908 L 244.209 301.908 L 246.663 307.464 C 248.701 312.141 254.164 314.271 258.841 312.234 C 263.517 310.196 265.647 304.732 263.61 300.056 L 237.68 240.789 Z M 229.207 267.598 L 236.106 283.387 L 222.308 283.387 L 229.207 267.598 Z" />
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
            <span className="transition-transform group-hover:scale-105"><LogoIcon /></span>
            <span className="text-lg font-bold hidden sm:inline">AnythingMCP</span>
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
              className="flex items-center gap-2 text-[var(--muted-foreground)] hover:text-[var(--foreground)] px-2 py-1.5 rounded-md hover:bg-[var(--accent)] transition-colors"
            >
              <div className="w-6 h-6 rounded-full bg-[var(--brand)] text-white flex items-center justify-center text-xs font-medium">
                {(user?.name || user?.email || '?')[0].toUpperCase()}
              </div>
              <span className="max-w-[120px] truncate">{user?.email}</span>
              <svg className={`w-3.5 h-3.5 transition-transform ${userMenuOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
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
