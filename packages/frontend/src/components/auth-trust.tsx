import { useTranslations } from 'next-intl';
import { CLAUDE_DIRECTORY_URL } from '@/lib/marketing';
import type { TrustStatsDisplay } from '@/lib/trust-stats';

/**
 * Trust content next to the sign-up and sign-in forms. The numbers are live
 * (GET /api/public/stats) and simply left out when unknown; badges and claims
 * are true statements only, and the Cloud-only ones (EU hosting, DPA, trial,
 * Claude Directory listing) are never shown on a self-hosted instance. The
 * Claude Directory badge is also left out for someone connecting ChatGPT or
 * Muse: it is Anthropic's listing.
 */

const CLIENTS = [
  { file: 'claude', label: 'Claude' },
  { file: 'chatgpt', label: 'ChatGPT' },
  { file: 'copilot', label: 'Copilot' },
  { file: 'cursor', label: 'Cursor' },
  { file: 'muse', label: 'Meta Muse' },
];

function Tick() {
  return (
    <span aria-hidden className="mt-px font-bold text-[#4ade80]">
      &#10003;
    </span>
  );
}

/** The dark panel beside the Cloud sign-up form. */
export function TrustPanel({
  stats,
  directoryBadge = true,
}: {
  stats: TrustStatsDisplay | null;
  directoryBadge?: boolean;
}) {
  const t = useTranslations('trust');
  const tiles = [
    stats?.downloads ? { n: stats.downloads, l: t('stats.downloads') } : null,
    stats?.toolCalls ? { n: stats.toolCalls, l: t('stats.toolCalls') } : null,
    stats?.workspaces ? { n: stats.workspaces, l: t('stats.workspaces') } : null,
  ].filter(Boolean) as Array<{ n: string; l: string }>;

  return (
    <aside
      aria-label={t('panelLabel')}
      className="relative overflow-hidden bg-[#0b1220] px-5 py-8 text-[#e7ebf3] sm:px-10 lg:flex lg:flex-col lg:justify-center lg:px-14 lg:py-14"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-[180px] -top-[180px] h-[520px] w-[520px] rounded-full bg-[radial-gradient(circle,rgba(37,99,235,.35),transparent_65%)]"
      />
      <div className="relative max-w-[540px]">
        <p className="mb-3.5 text-[22px] font-semibold leading-[1.2] tracking-[-0.02em] lg:text-[30px]">
          {t.rich('headline', { accent: (chunks) => <span className="text-[#8fb0ff]">{chunks}</span> })}
        </p>
        <p className="mb-7 text-sm leading-relaxed text-[#aeb7c9] lg:text-[15px]">
          {t('intro')}
        </p>

        {tiles.length > 0 && (
          <div
            className={`mb-6 grid ${tiles.length === 3 ? 'grid-cols-3' : 'grid-cols-2'} gap-2 sm:gap-3`}
            data-testid="trust-stats"
          >
            {tiles.map((t) => (
              <div key={t.l} className="rounded-[12px] border border-white/[.09] bg-white/[.05] p-2.5 sm:p-3.5">
                <div className="text-[17px] font-semibold tracking-[-0.01em] sm:text-[22px]">
                  {t.n}
                </div>
                <div className="mt-1 text-[11px] leading-snug text-[#97a1b5] sm:text-xs">{t.l}</div>
              </div>
            ))}
          </div>
        )}

        <div className="mb-7 flex flex-wrap gap-2">
          {directoryBadge && (
            <a
              href={CLAUDE_DIRECTORY_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-[7px] rounded-full border border-[rgba(217,119,87,.55)] bg-[rgba(217,119,87,.10)] px-2.5 py-1.5 text-[11.5px] text-[#ffd9c9] hover:bg-[rgba(217,119,87,.18)] sm:px-3 sm:text-[12.5px]"
            >
              <img src="/logos/clients/claude.svg" width={14} height={14} alt="" />
              {t('directory')}
            </a>
          )}
          {[t('badges.euHosted'), t('badges.gdpr'), 'AES-256-GCM', t('badges.openSource')].map((b) => (
            <span
              key={b}
              className="inline-flex items-center rounded-full border border-white/[.14] bg-white/[.03] px-2.5 py-1.5 text-[11.5px] text-[#dfe5f0] sm:px-3 sm:text-[12.5px]"
            >
              {b}
            </span>
          ))}
        </div>

        <div className="mb-7 flex flex-wrap items-center gap-x-3.5 gap-y-2.5 text-[12.5px] text-[#97a1b5]">
          <span>{t('worksWith')}</span>
          {CLIENTS.map((c) => (
            <span key={c.file} className="inline-flex items-center gap-1.5 text-[#dfe5f0]">
              <img src={`/logos/clients/${c.file}.svg`} width={20} height={20} alt="" className="rounded-[6px] bg-white p-[3px]" />
              {c.label}
            </span>
          ))}
        </div>

        <div className="border-t border-white/10 pt-5">
          <h2 className="mb-2.5 text-[13px] font-medium text-[#97a1b5]">{t('trialIncludes')}</h2>
          <ul className="space-y-2 text-sm text-[#dfe5f0]">
            <li className="flex gap-2.5">
              <Tick />
              {t('trialItems.connectors')}
            </li>
            <li className="flex gap-2.5">
              <Tick />
              {t('trialItems.servers')}
            </li>
            <li className="flex gap-2.5">
              <Tick />
              {t('trialItems.noInstall')}
            </li>
          </ul>
        </div>

        <p className="mt-5 text-[12.5px] text-[#7f8aa1]">
          {t('customer')}
        </p>
      </div>
    </aside>
  );
}

/** One quiet line under a sign-in card. */
export function TrustLine({ cloud }: { cloud: boolean }) {
  const t = useTranslations('trust.line');
  const items = [
    t('encryption'),
    ...(cloud ? [t('hosted'), t('gdpr')] : []),
    t('auditLog'),
  ];
  return (
    <div className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1.5 text-xs text-[var(--text-3)]">
      {items.map((i) => (
        <span key={i}>{i}</span>
      ))}
      <a
        href="https://github.com/HelpCode-ai/anythingmcp"
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-[var(--text-2)] hover:text-[var(--text)]"
      >
        {t('github')}
      </a>
    </div>
  );
}
