'use client';

import { useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AdapterSetupInfo, SetupGuide, SetupGuideStep } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ConnectorLogo } from '@/components/connector-logo';
import { openSupportChat } from '@/components/support-chat';
import { copyText } from '@/lib/clipboard';
import { effortLabel, effortTone } from '@/lib/setup-effort';
import { cn } from '@/lib/utils';

/**
 * The pieces of a step-by-step connector setup (an adapter's `setupGuide`):
 * the intro, the stepper, and one step with what to open, what to type at the
 * provider and the common problems. The setup page owns the state, the fields
 * and the check; these only present it.
 */

/** Markdown of a guide. Links open in a new tab: the setup stays where it is. */
export function GuideMarkdown({ children, className }: { children: string; className?: string }) {
  return (
    <div
      className={cn(
        'prose prose-sm max-w-none text-[13.5px] leading-relaxed text-[var(--text-2)] dark:prose-invert [&_code]:rounded [&_code]:bg-[var(--surface-2)] [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12px] [&_code]:before:content-none [&_code]:after:content-none [&_p]:my-1.5 [&_strong]:text-[var(--text)]',
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: text }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="underline hover:text-[var(--text)]">
              {text}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

/** "Stuck? Ask us": opens the support chat where there is one (Cloud). */
export function StuckLink({ name }: { name: string }) {
  const { deploymentMode } = useAuth();
  if (deploymentMode !== 'cloud') return null;
  return (
    <button
      type="button"
      onClick={() => {
        if (!openSupportChat()) window.location.href = `mailto:support@anythingmcp.com?subject=${encodeURIComponent(`Setting up ${name}`)}`;
      }}
      className="text-sm text-[var(--text-3)] underline hover:text-[var(--text)]"
    >
      Stuck? Ask us
    </button>
  );
}

export function GuideIntro({
  info,
  guide,
  resume,
  onStart,
  onRestart,
  onShowForm,
  skipTo,
  onSkip,
}: {
  info: AdapterSetupInfo;
  guide: SetupGuide;
  /** The step saved from an earlier visit, offered first. */
  resume: { index: number; title: string } | null;
  onStart: () => void;
  onRestart: () => void;
  onShowForm: () => void;
  /** A connector being finished: the step to jump to when the rest is done. */
  skipTo?: { index: number; title: string } | null;
  onSkip?: () => void;
}) {
  const short = info.name.split(' ')[0];
  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <ConnectorLogo icon={info.icon} name={info.name} />
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-[var(--text)]">Connect {info.name} to your AI</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--text-3)]">
            <Badge tone={effortTone(guide)}>{effortLabel(guide)}</Badge>
            <span>
              {guide.steps.length} step{guide.steps.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>
      </div>

      {guide.examples && guide.examples.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-semibold text-[var(--text)]">Then ask your AI things like</h2>
          <ul className="space-y-1.5">
            {guide.examples.map((ex) => (
              <li key={ex} className="rounded-[9px] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--text-2)]">
                “{ex}”
              </li>
            ))}
          </ul>
        </div>
      )}

      {guide.needs && guide.needs.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-semibold text-[var(--text)]">What you need</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--text-2)]">
            {guide.needs.map((n) => (
              <li key={n}>
                <GuideMarkdown className="[&_p]:my-0">{n}</GuideMarkdown>
              </li>
            ))}
          </ul>
        </div>
      )}

      {guide.why && (
        <details className="rounded-[9px] border border-[var(--border)] px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium text-[var(--text)]">
            {guide.effort === 'own_app' ? `Why do I need my own ${short} app?` : 'Why this setup?'}
          </summary>
          <GuideMarkdown className="mt-2">{guide.why}</GuideMarkdown>
        </details>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {resume ? (
          <>
            <Button onClick={onStart}>Continue at step {resume.index + 1}: {resume.title}</Button>
            <button type="button" onClick={onRestart} className="text-sm text-[var(--text-3)] underline hover:text-[var(--text)]">
              Start over
            </button>
          </>
        ) : (
          <>
            <Button onClick={onStart}>Start</Button>
            {skipTo && onSkip && (
              <button type="button" onClick={onSkip} className="text-sm text-[var(--text-3)] underline hover:text-[var(--text)]">
                Done the rest already? Go to step {skipTo.index + 1}: {skipTo.title}
              </button>
            )}
          </>
        )}
      </div>
      <p className="text-xs text-[var(--text-3)]">
        Done this before?{' '}
        <button type="button" onClick={onShowForm} className="underline hover:text-[var(--text)]">
          Enter everything on one page
        </button>
      </p>
    </div>
  );
}

/** Where the user is: numbered steps, then "Use it". Titles from sm up. */
export function GuideStepper({ steps, current }: { steps: SetupGuideStep[]; current: number }) {
  const items = [...steps.map((s) => s.title), 'Use it'];
  return (
    <ol className="flex items-center gap-1.5" aria-label="Setup progress">
      {items.map((title, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={title} className={cn('flex min-w-0 items-center gap-1.5', active ? 'flex-auto' : 'flex-none sm:flex-1')}>
            <span
              aria-current={active ? 'step' : undefined}
              className={cn(
                'flex size-6 flex-none items-center justify-center rounded-full text-[11px] font-semibold',
                done && 'bg-[var(--brand)] text-[var(--primary-foreground)]',
                active && 'border-2 border-[var(--brand)] text-[var(--brand)]',
                !done && !active && 'border border-[var(--border-strong)] text-[var(--text-3)]',
              )}
            >
              {done ? '✓' : i + 1}
            </span>
            <span
              className={cn(
                'truncate text-xs',
                active ? 'font-medium text-[var(--text)]' : 'hidden text-[var(--text-3)] sm:inline',
              )}
            >
              {title}
            </span>
            {i < items.length - 1 && <span aria-hidden className="hidden h-px min-w-3 flex-1 bg-[var(--border)] sm:block" />}
          </li>
        );
      })}
    </ol>
  );
}

/** One value to type at the provider, with a copy button; or an option to pick there. */
function GuideValue({ label, value, note, pick }: { label: string; value: string; note?: string; pick?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-[var(--text-3)]">{label}</div>
      {pick ? (
        <div className="text-sm text-[var(--text)]">
          Select <strong>{value}</strong>
        </div>
      ) : (
        <div className="flex items-start gap-2">
          {/* A sentence (Etsy's app description) reads as text; a URL or a
              command as code. Either wraps only where it has to. */}
          <code
            className={cn(
              'min-h-9 flex-1 rounded-[8px] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[var(--text)] [overflow-wrap:anywhere]',
              /\s/.test(value) ? 'font-sans text-[13px] leading-snug' : 'font-mono text-[12.5px]',
            )}
          >
            {value}
          </code>
          <Button
            size="sm"
            variant="secondary"
            className="h-9 flex-none"
            onClick={async () => {
              if (await copyText(value)) {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }
            }}
          >
            {copied ? 'Copied ✓' : 'Copy'}
          </Button>
        </div>
      )}
      {note && <p className="text-xs text-[var(--text-3)]">{note}</p>}
    </div>
  );
}

/**
 * A step: what to do, the provider page to open, what to type there, the
 * fields to fill here (children), a confirmation for work done at the
 * provider, and the common problems.
 */
export function GuideStepView({
  step,
  index,
  total,
  redirectUri,
  actionUrl,
  confirmed,
  onConfirm,
  children,
}: {
  step: SetupGuideStep;
  index: number;
  total: number;
  redirectUri: string | null;
  /** The action's URL with {{VAR}} filled in; null while a value it needs is empty. */
  actionUrl: string | null;
  confirmed: boolean;
  onConfirm: (v: boolean) => void;
  children?: ReactNode;
}) {
  const fill = (v: string) => v.replace(/\{\{redirectUri\}\}/g, redirectUri ?? '…');
  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.06em] text-[var(--text-3)]">
          Step {index + 1} of {total}
        </p>
        <h2 className="mt-0.5 text-lg font-semibold text-[var(--text)]">{step.title}</h2>
      </div>

      {step.body && <GuideMarkdown>{step.body}</GuideMarkdown>}

      {step.action &&
        (actionUrl ? (
          <a
            href={actionUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonVariants({ variant: 'secondary', size: 'md' }), 'gap-1.5')}
          >
            {step.action.label}
            <span aria-hidden>↗</span>
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        ) : (
          <p className="text-xs text-[var(--text-3)]">{step.action.label}: fill in the previous step first.</p>
        ))}

      {step.image && (
        <figure className="space-y-1">
          <img src={step.image.src} alt={step.image.alt} className="w-full rounded-[9px] border border-[var(--border)]" />
          <figcaption className="text-[11px] text-[var(--text-3)]">Screenshot from {step.image.capturedAt}; the page may look slightly different now.</figcaption>
        </figure>
      )}

      {step.values && step.values.length > 0 && (
        <div className="space-y-3 rounded-[11px] border border-[var(--border)] p-3">
          {step.values.map((v) => (
            <GuideValue key={v.label} label={v.label} value={fill(v.value)} note={v.note} pick={v.pick} />
          ))}
        </div>
      )}

      {children}

      {step.confirm && (
        <label className="flex cursor-pointer items-start gap-2 text-sm text-[var(--text)]">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => onConfirm(e.target.checked)}
            className="mt-0.5 size-4 accent-[var(--brand)]"
          />
          {step.confirm}
        </label>
      )}

      {step.problems && step.problems.length > 0 && (
        <details className="rounded-[9px] border border-[var(--border)] px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium text-[var(--text-2)]">Common problems</summary>
          <div className="mt-2 space-y-3">
            {step.problems.map((p) => (
              <div key={p.q}>
                <p className="text-sm font-medium text-[var(--text)]">{p.q}</p>
                <GuideMarkdown>{p.a}</GuideMarkdown>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
