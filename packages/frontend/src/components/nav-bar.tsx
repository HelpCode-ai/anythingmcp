'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from '@/lib/auth-context';

/* Inline SVG logo component */
function LogoIcon({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 40 40" fill="none" width={size} height={size}>
      <rect x="2" y="2" width="36" height="36" rx="8" fill="url(#navLogoGrad)" />
      <circle cx="12" cy="13" r="2.2" fill="white" opacity="0.95" />
      <circle cx="12" cy="20" r="2.2" fill="white" opacity="0.95" />
      <circle cx="12" cy="27" r="2.2" fill="white" opacity="0.95" />
      <path d="M14.5 13.5 L22 18" stroke="white" strokeWidth="1.3" strokeLinecap="round" opacity="0.6" />
      <path d="M14.5 20 L22 20" stroke="white" strokeWidth="1.3" strokeLinecap="round" opacity="0.6" />
      <path d="M14.5 26.5 L22 22" stroke="white" strokeWidth="1.3" strokeLinecap="round" opacity="0.6" />
      <path d="M27 15 L31 17.5 L31 22.5 L27 25 L23 22.5 L23 17.5 Z" fill="white" opacity="0.95" />
      <defs>
        <linearGradient id="navLogoGrad" x1="2" y1="2" x2="38" y2="38" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6366f1" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
    </svg>
  );
}

const NAV_ITEMS = [
  { href: '/connectors', label: 'Connectors', icon: CableIcon },
  { href: '/mcp-server', label: 'MCP Server', icon: ServerIcon },
  { href: '/ai-assistant', label: 'AI Assistant', icon: SparklesIcon },
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

  const allNavItems = [
    ...NAV_ITEMS,
    ...(user?.role === 'ADMIN' ? [{ href: '/admin/users', label: 'Users', icon: UsersIcon }] : []),
  ];

  return (
    <header className="border-b border-[var(--border)] bg-[var(--background)]/95 backdrop-blur-sm sticky top-0 z-50">
      <div className="flex items-center justify-between max-w-7xl mx-auto px-6 h-14">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2.5 group">
            <span className="transition-transform group-hover:scale-105"><LogoIcon /></span>
            <span className="text-lg font-bold hidden sm:inline">AnythingToMCP</span>
          </Link>
          {/* Desktop nav */}
          <nav className="hidden lg:flex items-center gap-1">
            {allNavItems.map((item) => {
              const isActive = pathname === item.href || pathname.startsWith(item.href + '/');
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
          <div className="hidden sm:flex items-center gap-2 text-[var(--muted-foreground)]">
            <div className="w-6 h-6 rounded-full bg-[var(--brand)] text-white flex items-center justify-center text-xs font-medium">
              {(user?.name || user?.email || '?')[0].toUpperCase()}
            </div>
            <span className="max-w-[120px] truncate">{user?.email}</span>
          </div>
          <button
            onClick={logout}
            className="hidden sm:block text-[var(--muted-foreground)] hover:text-[var(--destructive)] px-2 py-1 rounded text-xs"
          >
            Logout
          </button>
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
            const isActive = pathname === item.href || pathname.startsWith(item.href + '/');
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
        <div className="flex items-center justify-between max-w-7xl mx-auto px-6 py-2 text-sm border-t border-[var(--border)]">
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

function SparklesIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
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

function ChevronRightIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

export { LogoIcon };
