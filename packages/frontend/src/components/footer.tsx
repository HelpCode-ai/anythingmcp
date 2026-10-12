'use client';

import { useState, useEffect } from 'react';
import { useTheme } from '@/lib/theme-context';
import { siteSettings, versionApi } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

function SunIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" /><path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" /><path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />
    </svg>
  );
}

function MoonIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}

function MonitorIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="20" height="14" x="2" y="3" rx="2" /><line x1="8" x2="16" y1="21" y2="21" /><line x1="12" x2="12" y1="17" y2="21" />
    </svg>
  );
}

interface FooterLink {
  label: string;
  url: string;
}

interface VersionInfo {
  version: string;
  commit: string;
}

/** Fetch the version once per session; every mount shares the same promise. */
let versionPromise: Promise<VersionInfo | null> | null = null;

function getVersionOnce(token: string): Promise<VersionInfo | null> {
  if (!versionPromise) {
    versionPromise = versionApi
      .get(token)
      .then((v) => ({ version: v.version, commit: v.commit }))
      .catch(() => null);
  }
  return versionPromise;
}

/** Shorten a 40-char SHA for display; pass anything else through. */
function shortSha(c: string): string {
  return /^[0-9a-f]{40}$/.test(c) ? c.slice(0, 7) : c;
}

function VersionBadge({ version }: { version: VersionInfo }) {
  const sha = shortSha(version.commit);
  return (
    <span className="text-[var(--text-3)]">
      v{version.version} ·{' '}
      {/^[0-9a-f]{7}$/.test(sha) && version.commit.length === 40 ? (
        <a
          href={`https://github.com/HelpCode-ai/anythingmcp/commit/${version.commit}`}
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-[var(--text)] hover:underline"
        >
          {sha}
        </a>
      ) : (
        sha
      )}
    </span>
  );
}

export function Footer() {
  const { theme, setTheme } = useTheme();
  const { token } = useAuth();
  const [links, setLinks] = useState<FooterLink[]>([]);
  const [version, setVersion] = useState<{ version: string; commit: string } | null>(null);

  useEffect(() => {
    siteSettings.footerLinks().then(setLinks).catch(() => {});
  }, []);

  useEffect(() => {
    if (!token) return;
    getVersionOnce(token).then(setVersion).catch(() => {});
  }, [token]);

  const themeOptions = [
    { value: 'light' as const, label: 'Light', icon: SunIcon },
    { value: 'dark' as const, label: 'Dark', icon: MoonIcon },
    { value: 'system' as const, label: 'System', icon: MonitorIcon },
  ];

  return (
    <footer className="border-t border-[var(--border)] bg-[var(--surface)]">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
          {/* Left: Legal links */}
          <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--text-3)]">
            <span>&copy; {new Date().getFullYear()} Anything<span className="text-[var(--brand)]">MCP</span></span>
            <span className="hidden sm:inline">·</span>
            <a href="https://helpcode.ai" target="_blank" rel="noopener noreferrer" className="hover:text-[var(--text)] hover:underline">Powered by helpcode.ai</a>
            {version && (
              <>
                <span className="hidden sm:inline">·</span>
                <VersionBadge version={version} />
              </>
            )}
            {links.length > 0 && (
              <>
                <span className="hidden sm:inline">·</span>
                {links.map((link) => (
                  <a
                    key={link.label}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-[var(--text)] hover:underline"
                  >
                    {link.label}
                  </a>
                ))}
              </>
            )}
          </div>

          {/* Right: Theme toggle */}
          <div className="flex items-center gap-1 p-0.5 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]">
            {themeOptions.map((opt) => {
              const isActive = theme === opt.value;
              return (
                <button
                  key={opt.value}
                  onClick={() => setTheme(opt.value)}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-colors ${
                    isActive
                      ? 'bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-sm)] font-medium'
                      : 'text-[var(--text-3)] hover:text-[var(--text)]'
                  }`}
                  title={opt.label}
                >
                  <opt.icon size={14} />
                  <span className="hidden sm:inline">{opt.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </footer>
  );
}
