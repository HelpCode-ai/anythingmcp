'use client';

import { useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="absolute top-2 right-2 px-2 py-1 text-xs rounded bg-[var(--muted)] hover:bg-[var(--border)] text-[var(--muted-foreground)] transition-colors"
    >
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

export function ChatMessage({
  role,
  content,
}: {
  role: 'user' | 'assistant';
  content: string;
}) {
  if (role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] px-4 py-2 rounded-lg text-sm whitespace-pre-wrap bg-[var(--brand)] text-white">
          {content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-lg text-sm chat-message">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            p({ children }) {
              return <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>;
            },
            h1({ children }) {
              return <h1 className="text-lg font-bold mb-2 mt-4 first:mt-0">{children}</h1>;
            },
            h2({ children }) {
              return <h2 className="text-base font-bold mb-2 mt-3 first:mt-0">{children}</h2>;
            },
            h3({ children }) {
              return <h3 className="text-sm font-bold mb-1 mt-2 first:mt-0">{children}</h3>;
            },
            ul({ children }) {
              return <ul className="list-disc pl-5 mb-3 space-y-1">{children}</ul>;
            },
            ol({ children }) {
              return <ol className="list-decimal pl-5 mb-3 space-y-1">{children}</ol>;
            },
            li({ children }) {
              return <li className="leading-relaxed">{children}</li>;
            },
            strong({ children }) {
              return <strong className="font-semibold">{children}</strong>;
            },
            a({ href, children }) {
              return (
                <a href={href} target="_blank" rel="noopener noreferrer" className="text-[var(--brand)] underline hover:opacity-80">
                  {children}
                </a>
              );
            },
            blockquote({ children }) {
              return (
                <blockquote className="border-l-3 border-[var(--brand)] pl-3 my-3 text-[var(--muted-foreground)] italic">
                  {children}
                </blockquote>
              );
            },
            table({ children }) {
              return (
                <div className="overflow-x-auto mb-3">
                  <table className="min-w-full border-collapse border border-[var(--border)] text-xs">
                    {children}
                  </table>
                </div>
              );
            },
            thead({ children }) {
              return <thead className="bg-[var(--muted)]">{children}</thead>;
            },
            th({ children }) {
              return <th className="border border-[var(--border)] px-3 py-1.5 text-left font-semibold">{children}</th>;
            },
            td({ children }) {
              return <td className="border border-[var(--border)] px-3 py-1.5">{children}</td>;
            },
            code({ className, children, ...props }) {
              const match = /language-(\w+)/.exec(className || '');
              const codeString = String(children).replace(/\n$/, '');

              // Inline code
              if (!match && !codeString.includes('\n')) {
                return (
                  <code className="bg-[var(--muted)] px-1.5 py-0.5 rounded text-xs font-mono text-[var(--brand)]" {...props}>
                    {children}
                  </code>
                );
              }

              // Code block
              const language = match ? match[1] : '';
              return (
                <div className="relative my-3 rounded-lg overflow-hidden border border-[var(--border)]">
                  {language && (
                    <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--muted)] border-b border-[var(--border)]">
                      <span className="text-xs text-[var(--muted-foreground)] font-mono">{language}</span>
                    </div>
                  )}
                  <CopyButton text={codeString} />
                  <pre className="p-3 overflow-x-auto bg-[#1e1e1e] text-[#d4d4d4]">
                    <code className="text-xs font-mono leading-relaxed" {...props}>
                      {children}
                    </code>
                  </pre>
                </div>
              );
            },
            pre({ children }) {
              return <>{children}</>;
            },
            hr() {
              return <hr className="my-4 border-[var(--border)]" />;
            },
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
