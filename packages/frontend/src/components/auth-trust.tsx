import { CLAUDE_DIRECTORY_URL } from '@/lib/marketing';
import type { TrustStatsDisplay } from '@/lib/trust-stats';

/**
 * Trust content next to the sign-up and sign-in forms. The numbers are live
 * (GET /api/public/stats) and simply left out when unknown; badges and claims
 * are true statements only, and the Cloud-only ones (EU hosting, DPA, trial,
 * Claude Directory listing) are never shown on a self-hosted instance.
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
export function TrustPanel({ stats }: { stats: TrustStatsDisplay | null }) {
  const tiles = [
    stats?.stars ? { n: stats.stars, l: 'stars on GitHub', star: true } : null,
    stats?.downloads ? { n: stats.downloads, l: 'downloads' } : null,
    stats?.toolCalls ? { n: stats.toolCalls, l: 'AI tool calls last month' } : null,
    stats?.workspaces ? { n: stats.workspaces, l: 'workspaces on AnythingMCP Cloud' } : null,
  ].filter(Boolean) as Array<{ n: string; l: string; star?: boolean }>;

  return (
    <aside
      aria-label="Why teams build on AnythingMCP"
      className="relative overflow-hidden bg-[#0b1220] px-5 py-8 text-[#e7ebf3] sm:px-10 lg:flex lg:flex-col lg:justify-center lg:px-14 lg:py-14"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-[180px] -top-[180px] h-[520px] w-[520px] rounded-full bg-[radial-gradient(circle,rgba(37,99,235,.35),transparent_65%)]"
      />
      <div className="relative max-w-[540px]">
        <p className="mb-3.5 text-[22px] font-semibold leading-[1.2] tracking-[-0.02em] lg:text-[30px]">
          Your AI, connected to <span className="text-[#8fb0ff]">the software your company already runs.</span>
        </p>
        <p className="mb-7 text-sm leading-relaxed text-[#aeb7c9] lg:text-[15px]">
          AnythingMCP turns any REST, SOAP, GraphQL or SQL system into tools your AI assistant can use: securely,
          with roles and a full audit log.
        </p>

        {tiles.length > 0 && (
          <div className="mb-6 grid grid-cols-2 gap-2 sm:gap-3" data-testid="trust-stats">
            {tiles.map((t) => (
              <div key={t.l} className="rounded-[12px] border border-white/[.09] bg-white/[.05] p-2.5 sm:p-3.5">
                <div className="text-[17px] font-semibold tracking-[-0.01em] sm:text-[22px]">
                  {t.star && (
                    <span aria-hidden className="text-[#f5b301]">
                      &#9733;{' '}
                    </span>
                  )}
                  {t.n}
                </div>
                <div className="mt-1 text-[11px] leading-snug text-[#97a1b5] sm:text-xs">{t.l}</div>
              </div>
            ))}
          </div>
        )}

        <div className="mb-7 flex flex-wrap gap-2">
          <a
            href={CLAUDE_DIRECTORY_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-[7px] rounded-full border border-[rgba(217,119,87,.55)] bg-[rgba(217,119,87,.10)] px-2.5 py-1.5 text-[11.5px] text-[#ffd9c9] hover:bg-[rgba(217,119,87,.18)] sm:px-3 sm:text-[12.5px]"
          >
            <img src="/logos/clients/claude.svg" width={14} height={14} alt="" />
            Listed in the Claude Directory
          </a>
          {['🇪🇺 EU-hosted · Frankfurt', 'GDPR · DPA included', 'AES-256-GCM', 'Open source · AGPL-3.0'].map((b) => (
            <span
              key={b}
              className="inline-flex items-center rounded-full border border-white/[.14] bg-white/[.03] px-2.5 py-1.5 text-[11.5px] text-[#dfe5f0] sm:px-3 sm:text-[12.5px]"
            >
              {b}
            </span>
          ))}
        </div>

        <div className="mb-7 flex flex-wrap items-center gap-x-3.5 gap-y-2.5 text-[12.5px] text-[#97a1b5]">
          <span>Works with</span>
          {CLIENTS.map((c) => (
            <span key={c.file} className="inline-flex items-center gap-1.5 text-[#dfe5f0]">
              <img src={`/logos/clients/${c.file}.svg`} width={20} height={20} alt="" className="rounded-[6px] bg-white p-[3px]" />
              {c.label}
            </span>
          ))}
        </div>

        <div className="border-t border-white/10 pt-5">
          <h2 className="mb-2.5 text-[13px] font-medium text-[#97a1b5]">Your 7-day trial includes</h2>
          <ul className="space-y-2 text-sm text-[#dfe5f0]">
            <li className="flex gap-2.5">
              <Tick />
              200+ ready-made connectors: DATEV, SAP, HubSpot, Shopify, Postgres…
            </li>
            <li className="flex gap-2.5">
              <Tick />
              Your own MCP servers with roles and a full audit log
            </li>
            <li className="flex gap-2.5">
              <Tick />
              Nothing to install, cancel any time, your data stays in the EU
            </li>
          </ul>
        </div>

        <p className="mt-5 text-[12.5px] text-[#7f8aa1]">
          In production at KOCH Freiburg GmbH, connecting its ERP to Claude with single sign-on.
        </p>
      </div>
    </aside>
  );
}

/** One quiet line under a sign-in card. */
export function TrustLine({ cloud, stats }: { cloud: boolean; stats: TrustStatsDisplay | null }) {
  const items = [
    'AES-256-GCM encryption',
    ...(cloud ? ['Hosted in Frankfurt', 'GDPR · DPA'] : []),
    'Every call in your audit log',
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
        {stats?.stars ? (
          <>
            <span aria-hidden className="text-[#e3a008]">
              &#9733;
            </span>{' '}
            {stats.stars} on GitHub · open source
          </>
        ) : (
          'Open source on GitHub'
        )}
      </a>
    </div>
  );
}
