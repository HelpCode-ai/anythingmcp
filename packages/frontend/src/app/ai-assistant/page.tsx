'use client';

import { useState, useEffect, useRef } from 'react';
import { useAuth } from '@/lib/auth-context';
import { ai, connectors, users } from '@/lib/api';
import { NavBar } from '@/components/nav-bar';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

interface ModelOption {
  id: string;
  label: string;
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
  const [configLoaded, setConfigLoaded] = useState(false);
  const [modelOptions, setModelOptions] = useState<{
    anthropic: { models: ModelOption[]; default: string };
    openai: { models: ModelOption[]; default: string };
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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
        // Use default model for the provider
        const providerConfig = models[profile.aiProvider as 'anthropic' | 'openai'];
        if (providerConfig) setModel(providerConfig.default);
      }
      setHasApiKey(!!profile.hasAiApiKey);
      setConfigLoaded(true);
    }).catch(() => {
      setConfigLoaded(true);
    });
  }, [token]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  const handleSend = async () => {
    if (!message.trim() || !token || !hasApiKey) return;

    const userMsg: Message = { role: 'user', content: message };
    setMessages((prev) => [...prev, userMsg]);
    setMessage('');
    setSending(true);

    try {
      const result = await ai.configure(
        {
          message: message,
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

      let content: string;
      if (typeof result === 'string') {
        content = result;
      } else if (result.explanation) {
        // Format the response nicely
        const parts: string[] = [];
        if (result.explanation) parts.push(result.explanation);
        if (result.action && result.action !== 'none') {
          parts.push(`\nAction: ${result.action}`);
        }
        if (result.connector) {
          parts.push(`\nConnector:\n${JSON.stringify(result.connector, null, 2)}`);
        }
        if (result.tools?.length) {
          parts.push(`\nTools:\n${JSON.stringify(result.tools, null, 2)}`);
        }
        content = parts.join('\n');
      } else {
        content = JSON.stringify(result, null, 2);
      }

      setMessages((prev) => [...prev, { role: 'assistant', content }]);
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: `Error: ${err.message}` },
      ]);
    } finally {
      setSending(false);
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

  const currentModels: ModelOption[] =
    modelOptions ? modelOptions[provider]?.models || [] : [];

  const isReady = configLoaded && hasApiKey;

  return (
    <div className="min-h-screen bg-[var(--background)]">
      <NavBar
        breadcrumbs={[{ label: 'Dashboard', href: '/' }]}
        title="AI Assistant"
      />

      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 border border-[var(--border)] rounded-lg flex flex-col h-[600px]">
            <div className="p-4 border-b border-[var(--border)]">
              <h3 className="font-medium">AI Configuration Assistant</h3>
              <p className="text-sm text-[var(--muted-foreground)]">
                Describe what APIs you want to connect and I&apos;ll help you configure them.
              </p>
            </div>

            <div className="flex-1 p-4 overflow-y-auto space-y-4">
              {messages.length === 0 ? (
                <div className="text-center text-[var(--muted-foreground)] text-sm py-8">
                  <p className="mb-4">Start a conversation to get AI-assisted configuration.</p>
                  <div className="space-y-2 text-xs">
                    <p className="font-medium text-[var(--foreground)]">Examples:</p>
                    <p>&quot;I want to connect to the GitHub API and expose repository management tools&quot;</p>
                    <p>&quot;Help me set up a connector for my company&apos;s internal REST API&quot;</p>
                    <p>&quot;I have a SOAP service with a WSDL at...&quot;</p>
                  </div>
                </div>
              ) : (
                messages.map((msg, i) => (
                  <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[80%] px-4 py-2 rounded-lg text-sm whitespace-pre-wrap ${
                      msg.role === 'user'
                        ? 'bg-[var(--brand)] text-white'
                        : 'bg-[var(--muted)]'
                    }`}>
                      {msg.content}
                    </div>
                  </div>
                ))
              )}
              {sending && (
                <div className="flex justify-start">
                  <div className="bg-[var(--muted)] px-4 py-2 rounded-lg text-sm text-[var(--muted-foreground)] flex items-center gap-2">
                    <div className="w-4 h-4 border-2 border-[var(--brand)] border-t-transparent rounded-full animate-spin"></div>
                    Thinking...
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            <div className="p-4 border-t border-[var(--border)]">
              {!configLoaded ? (
                <p className="text-xs text-[var(--muted-foreground)] mb-2">
                  Loading AI configuration...
                </p>
              ) : !hasApiKey ? (
                <p className="text-xs text-[var(--destructive)] mb-2">
                  No API key configured. Go to <a href="/settings" className="underline font-medium">Settings</a> to set up your AI provider and API key.
                </p>
              ) : null}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={isReady ? 'Describe what you want to connect...' : 'Configure your AI provider in Settings first'}
                  disabled={!isReady || sending}
                  className="flex-1 border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)] disabled:opacity-50"
                />
                <button
                  onClick={handleSend}
                  disabled={!message.trim() || !isReady || sending}
                  className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50"
                >
                  Send
                </button>
              </div>
            </div>
          </div>

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
                {hasApiKey ? (
                  <p className="text-xs text-[var(--success)]">
                    API key configured
                  </p>
                ) : (
                  <p className="text-xs text-[var(--destructive)]">
                    <a href="/settings" className="underline">Configure API key in Settings</a>
                  </p>
                )}
              </div>
            </div>

            <div className="border border-[var(--border)] rounded-lg p-4">
              <h3 className="font-medium mb-3">AI Capabilities</h3>
              <ul className="text-sm space-y-2 text-[var(--muted-foreground)]">
                <li className="flex items-start gap-2">
                  <span className="text-[var(--brand)] mt-0.5">*</span>
                  Auto-generate tool definitions from API specs
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-[var(--brand)] mt-0.5">*</span>
                  Improve tool descriptions for better LLM comprehension
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-[var(--brand)] mt-0.5">*</span>
                  Suggest parameter naming and groupings
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-[var(--brand)] mt-0.5">*</span>
                  Configure connectors via natural language
                </li>
                <li className="flex items-start gap-2">
                  <span className="text-[var(--brand)] mt-0.5">*</span>
                  Optimize response mappings
                </li>
              </ul>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
