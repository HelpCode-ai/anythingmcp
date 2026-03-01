'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@/lib/auth-context';
import { ai, connectors, users } from '@/lib/api';
import { NavBar } from '@/components/nav-bar';
import { Footer } from '@/components/footer';
import { ChatMessage } from '@/components/chat-message';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface ModelOption {
  id: string;
  label: string;
}

function formatAiResult(result: any): string {
  if (typeof result === 'string') return result;

  const parts: string[] = [];

  if (result.explanation) {
    parts.push(result.explanation);
  }

  if (result.action && result.action !== 'none') {
    parts.push(`\n**Suggested action:** \`${result.action}\``);
  }

  if (result.connector) {
    parts.push(`\n### Connector Configuration\n\`\`\`json\n${JSON.stringify(result.connector, null, 2)}\n\`\`\``);
  }

  if (result.tools?.length) {
    parts.push(`\n### Tools\n\`\`\`json\n${JSON.stringify(result.tools, null, 2)}\n\`\`\``);
  }

  return parts.length > 0 ? parts.join('\n') : JSON.stringify(result, null, 2);
}

export default function AiAssistantPage() {
  const { token } = useAuth();
  const [message, setMessage] = useState('');
  const [provider, setProvider] = useState<'anthropic' | 'openai'>('anthropic');
  const [model, setModel] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState(false);
  const [existingConnectors, setExistingConnectors] = useState<any[]>([]);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [hasEnvApiKey, setHasEnvApiKey] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [modelOptions, setModelOptions] = useState<{
    anthropic: { models: ModelOption[]; default: string };
    openai: { models: ModelOption[]; default: string };
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load user's saved AI config + available models + connectors
  useEffect(() => {
    if (!token) return;

    connectors.list(token).then(setExistingConnectors).catch(() => {});

    Promise.all([
      users.me(token),
      ai.models(token),
    ]).then(([profile, models]) => {
      setModelOptions(models);
      if (profile.aiProvider) {
        setProvider(profile.aiProvider as 'anthropic' | 'openai');
      }
      if (profile.aiModel) {
        setModel(profile.aiModel);
      } else if (profile.aiProvider && models) {
        const providerConfig = models[profile.aiProvider as 'anthropic' | 'openai'];
        if (providerConfig) setModel(providerConfig.default);
      }
      setHasApiKey(!!profile.hasAiApiKey);
      setHasEnvApiKey(!!profile.hasEnvApiKey);
      setConfigLoaded(true);
    }).catch(() => {
      setConfigLoaded(true);
    });
  }, [token]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  // Auto-resize textarea
  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 150) + 'px';
  }, []);

  const handleSend = async () => {
    if (!message.trim() || !token) return;

    const userMsg: Message = { role: 'user', content: message };
    setMessages((prev) => [...prev, userMsg]);
    const currentMessage = message;
    setMessage('');
    setSending(true);

    // Reset textarea height
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    try {
      const result = await ai.configure(
        {
          message: currentMessage,
          existingConnectors: existingConnectors.map((c) => ({
            name: c.name,
            type: c.type,
            baseUrl: c.baseUrl,
          })),
          provider,
          model: model || undefined,
        },
        token,
      );

      setMessages((prev) => [...prev, { role: 'assistant', content: formatAiResult(result) }]);
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `**Error:** ${err.message}` },
      ]);
    } finally {
      setSending(false);
      // Re-focus textarea so mobile keyboard stays open
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleProviderChange = (newProvider: 'anthropic' | 'openai') => {
    setProvider(newProvider);
    if (modelOptions) {
      const providerConfig = modelOptions[newProvider];
      if (providerConfig) setModel(providerConfig.default);
    }
  };

  const clearChat = () => {
    setMessages([]);
  };

  const currentModels: ModelOption[] =
    modelOptions ? modelOptions[provider]?.models || [] : [];

  const isReady = configLoaded && (hasApiKey || hasEnvApiKey);

  return (
    <div className="min-h-screen bg-[var(--background)] flex flex-col">
      <NavBar
        breadcrumbs={[{ label: 'Dashboard', href: '/' }]}
        title="AI Assistant"
      />

      <main className="max-w-7xl mx-auto px-6 py-8 flex-1 w-full">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Chat Area */}
          <div className="lg:col-span-2 border border-[var(--border)] rounded-lg flex flex-col h-[700px]">
            {/* Header */}
            <div className="p-4 border-b border-[var(--border)] flex items-center justify-between">
              <div>
                <h3 className="font-medium">AI Configuration Assistant</h3>
                <p className="text-xs text-[var(--muted-foreground)]">
                  Describe what APIs you want to connect and get configuration suggestions.
                </p>
              </div>
              {messages.length > 0 && (
                <button
                  onClick={clearChat}
                  className="text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] px-2 py-1 rounded border border-[var(--border)] hover:bg-[var(--muted)] transition-colors"
                >
                  Clear
                </button>
              )}
            </div>

            {/* Messages */}
            <div className="flex-1 p-4 overflow-y-auto space-y-4">
              {messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-[var(--muted-foreground)]">
                  <div className="w-12 h-12 rounded-full bg-[var(--muted)] flex items-center justify-center mb-4">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 2a10 10 0 1 0 10 10H12V2z" /><path d="M12 2a10 10 0 0 1 10 10" /><circle cx="12" cy="12" r="2" />
                    </svg>
                  </div>
                  <p className="text-sm mb-6">How can I help you configure your APIs?</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-lg">
                    {[
                      'I want to connect to the GitHub API and expose repository management tools',
                      'Help me set up a connector for a REST API with Bearer auth',
                      'I have an OpenAPI spec — help me import tools from it',
                      'Configure a GraphQL connector for my endpoint',
                    ].map((example, i) => (
                      <button
                        key={i}
                        onClick={() => { setMessage(example); textareaRef.current?.focus(); }}
                        disabled={!isReady}
                        className="text-left text-xs px-3 py-2.5 rounded-lg border border-[var(--border)] hover:bg-[var(--muted)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {example}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                messages.map((msg, i) => (
                  <ChatMessage key={i} role={msg.role} content={msg.content} />
                ))
              )}
              {sending && (
                <div className="flex justify-start">
                  <div className="px-4 py-3 rounded-lg text-sm text-[var(--muted-foreground)] flex items-center gap-3">
                    <div className="flex gap-1">
                      <div className="w-2 h-2 bg-[var(--brand)] rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                      <div className="w-2 h-2 bg-[var(--brand)] rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                      <div className="w-2 h-2 bg-[var(--brand)] rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
                    </div>
                    <span className="text-xs">Thinking...</span>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <div className="p-4 border-t border-[var(--border)]">
              {configLoaded && !isReady && (
                <p className="text-xs text-[var(--destructive)] mb-2">
                  No API key configured. Go to <a href="/settings" className="underline font-medium">Settings</a> to set up your API key, or add ANTHROPIC_API_KEY / OPENAI_API_KEY to your .env file.
                </p>
              )}
              <div className="flex gap-2 items-end">
                <div className="flex-1 relative">
                  <textarea
                    ref={textareaRef}
                    value={message}
                    onChange={(e) => { setMessage(e.target.value); adjustTextareaHeight(); }}
                    onKeyDown={handleKeyDown}
                    placeholder={isReady ? 'Describe what you want to connect... (Shift+Enter for new line)' : 'Configure your AI provider first'}
                    disabled={!isReady || sending}
                    rows={1}
                    className="w-full border border-[var(--input)] rounded-lg px-3 py-2.5 text-sm bg-[var(--background)] disabled:opacity-50 resize-none overflow-hidden focus:outline-none focus:ring-2 focus:ring-[var(--brand)] focus:border-transparent"
                  />
                </div>
                <button
                  onClick={handleSend}
                  disabled={!message.trim() || !isReady || sending}
                  className="bg-[var(--brand)] text-white p-2.5 rounded-lg hover:brightness-90 disabled:opacity-50 transition-opacity flex-shrink-0"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                </button>
              </div>
            </div>
          </div>

          {/* Sidebar */}
          <div className="space-y-4">
            {/* Model Selection */}
            <div className="border border-[var(--border)] rounded-lg p-4">
              <h3 className="font-medium mb-3">AI Provider & Model</h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium mb-1 text-[var(--muted-foreground)]">Provider</label>
                  <select
                    value={provider}
                    onChange={(e) => handleProviderChange(e.target.value as 'anthropic' | 'openai')}
                    className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                  >
                    <option value="anthropic">Anthropic (Claude)</option>
                    <option value="openai">OpenAI (GPT)</option>
                  </select>
                </div>
                {currentModels.length > 0 && (
                  <div>
                    <label className="block text-xs font-medium mb-1 text-[var(--muted-foreground)]">Model</label>
                    <select
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
                    >
                      {currentModels.map((m) => (
                        <option key={m.id} value={m.id}>{m.label}</option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="pt-1">
                  {hasApiKey ? (
                    <div className="flex items-center gap-1.5 text-xs text-[var(--success)]">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                      API key configured (Settings)
                    </div>
                  ) : hasEnvApiKey ? (
                    <div className="flex items-center gap-1.5 text-xs text-[var(--success)]">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                      API key configured (.env)
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-xs text-[var(--destructive)]">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                      <a href="/settings" className="underline">Configure API key</a>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="border border-[var(--border)] rounded-lg p-4">
              <h3 className="font-medium mb-3">Capabilities</h3>
              <ul className="text-xs space-y-2 text-[var(--muted-foreground)]">
                <li className="flex items-start gap-2">
                  <span className="text-[var(--brand)] mt-0.5 font-bold">+</span>
                  Auto-generate tool definitions from API specs
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-[var(--brand)] mt-0.5 font-bold">+</span>
                  Improve tool descriptions for LLM comprehension
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-[var(--brand)] mt-0.5 font-bold">+</span>
                  Configure connectors via natural language
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-[var(--brand)] mt-0.5 font-bold">+</span>
                  Suggest parameter naming and groupings
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-[var(--brand)] mt-0.5 font-bold">+</span>
                  Optimize response mappings
                </li>
              </ul>
            </div>

            <div className="border border-[var(--border)] rounded-lg p-4 bg-[var(--muted)]/30">
              <h3 className="font-medium mb-2 text-sm">Keyboard Shortcuts</h3>
              <div className="space-y-1 text-xs text-[var(--muted-foreground)]">
                <div className="flex justify-between">
                  <span>Send message</span>
                  <kbd className="px-1.5 py-0.5 bg-[var(--muted)] rounded border border-[var(--border)] font-mono text-[10px]">Enter</kbd>
                </div>
                <div className="flex justify-between">
                  <span>New line</span>
                  <kbd className="px-1.5 py-0.5 bg-[var(--muted)] rounded border border-[var(--border)] font-mono text-[10px]">Shift+Enter</kbd>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
