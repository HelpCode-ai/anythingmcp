'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';
import { ai, connectors } from '@/lib/api';
import { NavBar } from '@/components/nav-bar';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export default function AiAssistantPage() {
  const { token } = useAuth();
  const [message, setMessage] = useState('');
  const [provider, setProvider] = useState<'anthropic' | 'openai'>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState(false);
  const [existingConnectors, setExistingConnectors] = useState<any[]>([]);

  useEffect(() => {
    if (!token) return;
    connectors.list(token).then(setExistingConnectors).catch(() => {});
  }, [token]);

  const handleSend = async () => {
    if (!message.trim() || !token || !apiKey) return;

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
          apiKey,
        },
        token,
      );

      const assistantMsg: Message = {
        role: 'assistant',
        content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
      };
      setMessages((prev) => [...prev, assistantMsg]);
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
            </div>

            <div className="p-4 border-t border-[var(--border)]">
              {!apiKey && (
                <p className="text-xs text-[var(--destructive)] mb-2">
                  Please enter your AI API key in the settings panel to start chatting.
                </p>
              )}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Describe what you want to connect..."
                  disabled={!apiKey || sending}
                  className="flex-1 border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)] disabled:opacity-50"
                />
                <button
                  onClick={handleSend}
                  disabled={!message.trim() || !apiKey || sending}
                  className="bg-[var(--brand)] text-white px-4 py-2 rounded-md text-sm font-medium hover:opacity-90 disabled:opacity-50"
                >
                  Send
                </button>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="border border-[var(--border)] rounded-lg p-4">
              <h3 className="font-medium mb-3">AI Provider</h3>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value as 'anthropic' | 'openai')}
                className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)] mb-3"
              >
                <option value="anthropic">Claude (Anthropic)</option>
                <option value="openai">GPT-4o (OpenAI)</option>
              </select>

              <label className="block text-sm font-medium mb-1">API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={provider === 'anthropic' ? 'sk-ant-...' : 'sk-...'}
                className="w-full border border-[var(--input)] rounded-md px-3 py-2 text-sm bg-[var(--background)]"
              />
              <p className="text-xs text-[var(--muted-foreground)] mt-1">
                Your API key is sent per-request and never stored.
              </p>
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
