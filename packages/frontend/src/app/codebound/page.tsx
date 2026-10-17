'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/lib/auth-context';
import {
  codebound,
  mcpServers,
  type SavedScript,
  type SavedScriptSummary,
  type ScriptTool,
} from '@/lib/api';

const EXAMPLE = `const post = await tools.call("setup_demo_get_post", {});
if (!post || typeof post.id !== "number" || typeof post.title !== "string") {
  throw new Error("Expected a post with a numeric id and a title.");
}
return { id: post.id, title: post.title };`;
const fieldClass =
  'w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-sm';
const PAGE_SIZE = 20;

export default function CodeboundPage() {
  const { token, user } = useAuth();
  const canWrite = user?.role !== 'VIEWER';
  const [servers, setServers] = useState<{ id: string; name: string }[]>([]);
  const [serverId, setServerId] = useState('');
  const [tools, setTools] = useState<ScriptTool[]>([]);
  const [allowedTools, setAllowedTools] = useState<string[]>([]);
  const [code, setCode] = useState(EXAMPLE);
  const [input, setInput] = useState('{}');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [selected, setSelected] = useState<SavedScript | null>(null);
  const [scripts, setScripts] = useState<SavedScriptSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingTools, setLoadingTools] = useState(false);
  const [busy, setBusy] = useState<'run' | 'save' | 'open' | 'delete' | null>(
    null,
  );
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dirty, setDirty] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SavedScriptSummary | null>(
    null,
  );
  const [output, setOutput] = useState<Awaited<
    ReturnType<typeof codebound.run>
  > | null>(null);
  const selectedId = selected?.id;

  useEffect(() => {
    if (!token) return;
    let stale = false;
    mcpServers
      .list(token)
      .then((items) => {
        if (stale) return;
        const active = items.filter((server) => server.isActive);
        setServers(active);
        setTools([]);
        setAllowedTools([]);
        setOutput(null);
        setLoadingTools(active.length > 0);
        setServerId(active[0]?.id ?? '');
      })
      .catch((error: Error) => {
        if (!stale) setError(error.message);
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let stale = false;
    codebound
      .list(token, offset)
      .then((page) => {
        if (!stale) {
          setScripts(page.items);
          setTotal(page.total);
          if (offset > 0 && offset >= page.total)
            setOffset(
              Math.max(
                0,
                Math.floor((Math.max(page.total, 1) - 1) / PAGE_SIZE) *
                  PAGE_SIZE,
              ),
            );
        }
      })
      .catch((error: Error) => {
        if (!stale) setError(error.message);
      })
      .finally(() => {
        if (!stale) setListLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [token, offset, refresh]);

  useEffect(() => {
    if (!token || !serverId) return;
    let stale = false;
    codebound
      .tools(serverId, token)
      .then((items) => {
        if (stale) return;
        setTools(items);
        if (!selectedId)
          setAllowedTools(
            items.some((tool) => tool.name === 'setup_demo_get_post')
              ? ['setup_demo_get_post']
              : [],
          );
      })
      .catch((error: Error) => {
        if (!stale) {
          setTools([]);
          setError(error.message);
        }
      })
      .finally(() => {
        if (!stale) setLoadingTools(false);
      });
    return () => {
      stale = true;
    };
  }, [token, serverId, selectedId]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function parameters(): Record<string, unknown> {
    const parsed: unknown = JSON.parse(input);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Parameters must be a JSON object.');
    return parsed as Record<string, unknown>;
  }
  function reloadList() {
    setListLoading(true);
    setRefresh((value) => value + 1);
  }
  function discardChanges() {
    return !dirty || window.confirm('Discard unsaved changes?');
  }
  function newScript() {
    if (!discardChanges()) return;
    if (selectedId && serverId) setLoadingTools(true);
    setSelected(null);
    setName('');
    setDescription('');
    setCode(EXAMPLE);
    setInput('{}');
    setOutput(null);
    setError('');
    setNotice('');
    setDirty(false);
  }
  async function openScript(id: string) {
    if (!token || !discardChanges()) return;
    setBusy('open');
    setError('');
    setNotice('');
    try {
      const script = await codebound.get(id, token);
      if (script.id !== selectedId || script.mcpServerId !== serverId)
        setLoadingTools(true);
      setSelected(script);
      setName(script.name);
      setDescription(script.description);
      setServerId(script.mcpServerId);
      setCode(script.code);
      setInput(JSON.stringify(script.input, null, 2));
      setAllowedTools(script.allowedTools);
      setOutput(null);
      setDirty(false);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Could not open script.',
      );
    } finally {
      setBusy(null);
    }
  }
  async function save() {
    if (!token) return;
    setBusy('save');
    setError('');
    setNotice('');
    try {
      const body = {
        name: name.trim(),
        description,
        mcpServerId: serverId,
        code,
        input: parameters(),
        allowedTools,
      };
      const saved = selected
        ? await codebound.update(
            selected.id,
            { ...body, revision: selected.revision },
            token,
          )
        : await codebound.create(body, token);
      if (!selectedId) setLoadingTools(true);
      setSelected(saved);
      setName(saved.name);
      setDirty(false);
      setNotice('Script saved.');
      setOffset(0);
      reloadList();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Could not save script.',
      );
    } finally {
      setBusy(null);
    }
  }
  const runsSavedSource =
    selected &&
    selected.code === code &&
    selected.mcpServerId === serverId &&
    JSON.stringify(selected.allowedTools) === JSON.stringify(allowedTools);
  async function run() {
    if (!token) return;
    setBusy('run');
    setError('');
    setOutput(null);
    setNotice('');
    try {
      const params = parameters();
      setOutput(
        selected && runsSavedSource
          ? await codebound.runSaved(
              selected.id,
              params,
              selected.revision,
              token,
            )
          : await codebound.run(
              serverId,
              { code, input: params, allowedTools },
              token,
            ),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Script failed.');
    } finally {
      setBusy(null);
    }
  }
  async function remove() {
    if (!token || !deleteTarget) return;
    setBusy('delete');
    setError('');
    try {
      await codebound.delete(deleteTarget.id, token);
      if (selectedId === deleteTarget.id) {
        setSelected(null);
        setName('');
        setDescription('');
        setCode(EXAMPLE);
        setInput('{}');
        setOutput(null);
        setDirty(false);
        if (serverId) setLoadingTools(true);
      }
      setDeleteTarget(null);
      setNotice('Script deleted.');
      if (scripts.length === 1 && offset > 0)
        setOffset(Math.max(0, offset - PAGE_SIZE));
      reloadList();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Could not delete script.',
      );
    } finally {
      setBusy(null);
    }
  }
  const unavailable = allowedTools.filter(
    (name) => !tools.some((tool) => tool.name === name),
  );

  return (
    <AppShell
      title="Codebound"
      subtitle="Save scripts and run them against your connector tools"
    >
      <div className="space-y-5">
        <Card className="space-y-4 p-5" aria-label="Saved scripts">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-medium">Saved scripts ({total})</h2>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                disabled={!!busy}
                onClick={reloadList}
              >
                Refresh list
              </Button>
              <Button disabled={!!busy} onClick={newScript}>
                New script
              </Button>
            </div>
          </div>
          {scripts.length === 0 && (
            <p className="text-sm text-[var(--text-3)]">
              {listLoading
                ? 'Loading saved scripts…'
                : 'No saved scripts yet. Name your script and save it below.'}
            </p>
          )}
          {scripts.map((script) => (
            <div
              key={script.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border)] p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium">{script.name}</p>
                <p className="break-words text-xs text-[var(--text-3)]">
                  {script.description}
                </p>
              </div>
              <Button
                variant="secondary"
                disabled={!!busy}
                aria-label={`Open ${script.name}`}
                onClick={() => openScript(script.id)}
              >
                Open
              </Button>
              {canWrite && (
                <Button
                  variant="secondary"
                  disabled={!!busy}
                  aria-label={`Delete ${script.name}`}
                  onClick={() => setDeleteTarget(script)}
                >
                  Delete
                </Button>
              )}
            </div>
          ))}
          {total > PAGE_SIZE && (
            <div className="flex items-center gap-3 text-sm">
              <Button
                variant="secondary"
                disabled={!!busy || listLoading || offset === 0}
                onClick={() => {
                  setListLoading(true);
                  setOffset(Math.max(0, offset - PAGE_SIZE));
                }}
              >
                Previous
              </Button>
              <span>
                {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
              </span>
              <Button
                variant="secondary"
                disabled={!!busy || listLoading || offset + PAGE_SIZE >= total}
                onClick={() => {
                  setListLoading(true);
                  setOffset(offset + PAGE_SIZE);
                }}
              >
                Next
              </Button>
            </div>
          )}
        </Card>
        {deleteTarget && (
          <Card
            role="alertdialog"
            aria-label="Delete saved script"
            className="space-y-3 p-5"
          >
            <p>Delete “{deleteTarget.name}”? This removes the saved script.</p>
            <div className="flex gap-2">
              <Button disabled={!!busy} onClick={remove}>
                Confirm delete
              </Button>
              <Button
                variant="secondary"
                disabled={!!busy}
                onClick={() => setDeleteTarget(null)}
              >
                Cancel
              </Button>
            </div>
          </Card>
        )}
        <p className="text-sm text-[var(--text-2)]">
          Call tools with <code>await tools.call(name, args)</code>, read
          parameters from <code>input</code>, and return a JSON value.
          {selected
            ? ` Editing “${selected.name}”.`
            : ' Start a new script below.'}
          {dirty && ' Unsaved changes.'}
        </p>
        {!canWrite && (
          <p className="text-sm text-[var(--text-3)]">
            Viewers can open and run scripts. An editor or administrator can
            save and delete them.
          </p>
        )}
        <Card className="space-y-4 p-5">
          <label className="block space-y-2 text-sm">
            <span>Script name</span>
            <input
              aria-label="Script name"
              className={fieldClass}
              value={name}
              maxLength={120}
              disabled={!!busy || !canWrite}
              onChange={(event) => {
                setName(event.target.value);
                setDirty(true);
              }}
            />
          </label>
          <label className="block space-y-2 text-sm">
            <span>Description</span>
            <textarea
              aria-label="Description"
              className={fieldClass}
              value={description}
              maxLength={2000}
              disabled={!!busy || !canWrite}
              onChange={(event) => {
                setDescription(event.target.value);
                setDirty(true);
              }}
            />
          </label>
          <label className="block space-y-2 text-sm">
            <span>MCP server</span>
            <select
              aria-label="MCP server"
              className={fieldClass}
              value={serverId}
              disabled={!!busy || loading}
              onChange={(event) => {
                setServerId(event.target.value);
                setTools([]);
                setAllowedTools([]);
                setOutput(null);
                setError('');
                setLoadingTools(true);
                setDirty(true);
              }}
            >
              {servers.length === 0 && !serverId && (
                <option value="">
                  {loading
                    ? 'Loading servers…'
                    : 'Create an active MCP server first'}
                </option>
              )}
              {serverId &&
                !servers.some((server) => server.id === serverId) && (
                  <option value={serverId}>Unavailable MCP server</option>
                )}
              {servers.map((server) => (
                <option key={server.id} value={server.id}>
                  {server.name}
                </option>
              ))}
            </select>
          </label>
          <fieldset disabled={!!busy || loadingTools} className="space-y-2">
            <legend className="mb-2 text-sm font-medium">
              Allowed tools for this script
            </legend>
            {tools.length === 0 && (
              <p className="text-sm text-[var(--text-3)]">
                {loadingTools
                  ? 'Loading tools…'
                  : 'No permitted REST read tools. Assign a connector to this server to get started.'}
              </p>
            )}
            {tools.map((tool) => (
              <div
                key={tool.name}
                className="rounded-lg border border-[var(--border)] p-3"
              >
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={allowedTools.includes(tool.name)}
                    onChange={(event) => {
                      setAllowedTools((current) =>
                        event.target.checked
                          ? [...current, tool.name]
                          : current.filter((name) => name !== tool.name),
                      );
                      setDirty(true);
                    }}
                  />
                  <span className="font-mono">{tool.name}</span>
                </label>
                <details className="mt-2 text-xs text-[var(--text-2)]">
                  <summary className="cursor-pointer">
                    Description and schemas
                  </summary>
                  <p className="my-2">{tool.description}</p>
                  <pre className="overflow-auto">
                    {JSON.stringify(
                      {
                        inputSchema: tool.inputSchema,
                        outputSchema: tool.outputSchema,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              </div>
            ))}
            {!loadingTools &&
              unavailable.map((toolName) => (
                <label
                  key={toolName}
                  className="flex items-center gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked
                    onChange={() => {
                      setAllowedTools((current) =>
                        current.filter((item) => item !== toolName),
                      );
                      setDirty(true);
                    }}
                  />
                  {toolName} (currently unavailable)
                </label>
              ))}
          </fieldset>
        </Card>
        <Card className="space-y-4 p-5">
          <label className="block space-y-2 text-sm">
            <span>JavaScript</span>
            <textarea
              aria-label="JavaScript"
              className={`${fieldClass} min-h-64 font-mono`}
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
                setDirty(true);
              }}
              disabled={!!busy}
              spellCheck={false}
              maxLength={32768}
            />
          </label>
          <label className="block space-y-2 text-sm">
            <span>Parameters (JSON)</span>
            <textarea
              aria-label="Parameters (JSON)"
              className={`${fieldClass} min-h-24 font-mono`}
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                setDirty(true);
              }}
              disabled={!!busy}
              spellCheck={false}
            />
          </label>
          <p className="text-xs text-[var(--text-3)]">
            5 seconds · 20 sequential REST reads · 32 KiB result
          </p>
          {selected && !runsSavedSource && (
            <p className="text-sm text-[var(--text-3)]">
              Run uses your draft. Save to update the reusable script.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {canWrite && (
              <Button
                variant="secondary"
                onClick={save}
                disabled={
                  !serverId ||
                  !name.trim() ||
                  !code.trim() ||
                  !!busy ||
                  loadingTools
                }
              >
                {busy === 'save'
                  ? 'Saving…'
                  : selected
                    ? 'Save changes'
                    : 'Save script'}
              </Button>
            )}
            <Button
              onClick={run}
              disabled={!serverId || !code.trim() || !!busy || loadingTools}
            >
              {busy === 'run' ? 'Running…' : 'Run script'}
            </Button>
          </div>
        </Card>
        {notice && (
          <p role="status" aria-label="Script notification" className="text-sm">
            {notice}
          </p>
        )}
        {error && (
          <div
            role="alert"
            aria-label="Script error"
            className="rounded-lg border border-red-400 p-4 text-sm"
          >
            {error}
          </div>
        )}
        {output && (
          <Card className="space-y-3 p-5" aria-label="Script result">
            <p role="status" className="text-sm">
              Completed in {output.durationMs} ms · {output.calls} tool calls
            </p>
            <pre className="overflow-auto whitespace-pre-wrap break-words text-sm">
              {JSON.stringify(output.result, null, 2)}
            </pre>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
