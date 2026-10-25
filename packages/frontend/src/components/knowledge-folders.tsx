'use client';

import { useCallback, useEffect, useState } from 'react';
import { knowledgeFolders, roles as rolesApi, type KnowledgeFolder } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/** '' = everything, 'none' = items outside folders, else a folder id. */
export type FolderSelection = string;

const MAX_DEPTH = 4;

const inputCls =
  'w-full h-8 px-2.5 rounded-[8px] text-[12.5px] bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] placeholder:text-[var(--text-3)] outline-none focus:border-[var(--border-strong)]';

/** The workspace's knowledge folders (shared by skills and company memory). */
export function useKnowledgeFolders(token: string | null | undefined) {
  const [folders, setFolders] = useState<KnowledgeFolder[]>([]);
  const [restrictionsAvailable, setRestrictionsAvailable] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    knowledgeFolders
      .list(token)
      .then((r) => {
        if (cancelled) return;
        setFolders(Array.isArray(r?.folders) ? r.folders : []);
        setRestrictionsAvailable(!!r?.restrictionsAvailable);
      })
      .catch(() => {
        if (!cancelled) setFolders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [token, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { folders, restrictionsAvailable, reload };
}

/** Options for a "folder" select: top level first, then the tree by path. */
export function folderOptions(folders: KnowledgeFolder[], noneLabel = 'No folder') {
  return [{ value: '', label: noneLabel }, ...folders.map((f) => ({ value: f.id, label: f.path }))];
}

/**
 * Folder tree beside a list of skills or company memory: pick a folder to
 * filter, and (admins and editors) create, rename, describe, move or delete
 * folders. Admins with Enterprise can limit a folder to roles.
 */
export function KnowledgeFolderTree({
  token,
  kind,
  folders,
  restrictionsAvailable,
  selected,
  onSelect,
  canEdit,
  isAdmin,
  onChanged,
}: {
  token: string;
  kind: 'skill' | 'memory';
  folders: KnowledgeFolder[];
  restrictionsAvailable: boolean;
  selected: FolderSelection;
  onSelect: (s: FolderSelection) => void;
  canEdit: boolean;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const count = (f: KnowledgeFolder) => (kind === 'skill' ? f.skillCount : f.memoryCount);
  const parent = selected && selected !== 'none' ? folders.find((f) => f.id === selected) : undefined;

  const create = async () => {
    if (!newName.trim()) return;
    setError('');
    try {
      const f = await knowledgeFolders.create(token, {
        name: newName,
        parentId: parent && parent.depth < MAX_DEPTH ? parent.id : null,
      });
      setNewName('');
      setCreating(false);
      onChanged();
      onSelect(f.id);
    } catch (e: any) {
      setError(e.message || 'Could not create the folder');
    }
  };

  const item = (key: FolderSelection, label: string, depth: number, extra?: React.ReactNode) => (
    <button
      key={key || 'all'}
      onClick={() => onSelect(key)}
      className={cn(
        'flex w-full items-center gap-1.5 rounded-[7px] px-2 py-1.5 text-left text-[12.5px] transition-colors',
        selected === key
          ? 'bg-[var(--brand-tint)] text-[var(--text)] font-medium'
          : 'text-[var(--text-2)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]',
      )}
      style={{ paddingLeft: 8 + depth * 14 }}
    >
      {extra}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );

  return (
    <Card className="p-2.5">
      <div className="mb-1.5 flex items-center justify-between px-1">
        <span className="text-[11.5px] font-semibold uppercase tracking-wide text-[var(--text-3)]">Folders</span>
        {canEdit && (
          <button
            onClick={() => setCreating((v) => !v)}
            className="text-[12px] text-[var(--brand)] hover:underline"
            title={parent ? `New folder inside ${parent.path}` : 'New top-level folder'}
          >
            {creating ? 'Cancel' : '+ New'}
          </button>
        )}
      </div>
      {creating && (
        <div className="mb-2 flex flex-col gap-1.5 px-1">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
            placeholder={parent && parent.depth < MAX_DEPTH ? `Inside ${parent.path}` : 'Folder name'}
            className={inputCls}
          />
          <Button size="sm" variant="primary" onClick={create} disabled={!newName.trim()}>
            Create
          </Button>
        </div>
      )}
      {error && <p className="px-1 pb-1 text-[11.5px] text-[var(--danger)]">{error}</p>}
      <nav className="flex flex-col gap-0.5" aria-label="Folders">
        {item('', kind === 'skill' ? 'All skills' : 'All company memory', 0)}
        {folders.length > 0 && item('none', 'Not in a folder', 0)}
        {folders.map((f) => (
          <div key={f.id}>
            <div className="group flex items-center">
              <div className="min-w-0 flex-1">
                {item(
                  f.id,
                  f.name,
                  f.depth,
                  <>
                    <FolderIcon />
                    {f.roleIds.length > 0 && (
                      <>
                        <LockIcon />
                        <span className="sr-only">Limited to roles:</span>
                      </>
                    )}
                  </>,
                )}
              </div>
              <span className="px-1 text-[11px] text-[var(--text-3)]">{count(f) || ''}</span>
              {canEdit && (
                <button
                  onClick={() => setEditing(editing === f.id ? null : f.id)}
                  className="px-1 text-[11.5px] text-[var(--text-3)] opacity-0 hover:text-[var(--text)] group-hover:opacity-100 focus:opacity-100"
                  aria-label={`Edit folder ${f.path}`}
                >
                  Edit
                </button>
              )}
            </div>
            {editing === f.id && (
              <FolderEditor
                token={token}
                folder={f}
                folders={folders}
                restrictionsAvailable={restrictionsAvailable}
                isAdmin={isAdmin}
                onDone={(deleted) => {
                  setEditing(null);
                  if (deleted && selected === f.id) onSelect('');
                  onChanged();
                }}
              />
            )}
          </div>
        ))}
      </nav>
      {folders.length === 0 && (
        <p className="px-1 pt-1.5 text-[11.5px] leading-relaxed text-[var(--text-3)]">
          Folders group skills and company memory by topic, for people and for AI clients.
        </p>
      )}
    </Card>
  );
}

function FolderEditor({
  token,
  folder,
  folders,
  restrictionsAvailable,
  isAdmin,
  onDone,
}: {
  token: string;
  folder: KnowledgeFolder;
  folders: KnowledgeFolder[];
  restrictionsAvailable: boolean;
  isAdmin: boolean;
  onDone: (deleted?: boolean) => void;
}) {
  const [name, setName] = useState(folder.name);
  const [description, setDescription] = useState(folder.description ?? '');
  const [parentId, setParentId] = useState(folder.parentId ?? '');
  const [roleIds, setRoleIds] = useState<string[]>(folder.roleIds);
  const [roleList, setRoleList] = useState<Array<{ id: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const canRestrict = isAdmin && restrictionsAvailable;

  useEffect(() => {
    if (!canRestrict && folder.roleIds.length === 0) return;
    rolesApi
      .list(token)
      .then((r) => setRoleList(r.map((x: any) => ({ id: x.id, name: x.name }))))
      .catch(() => setRoleList([]));
  }, [token, canRestrict, folder.roleIds.length]);

  // A folder cannot move into itself or below itself.
  const below = new Set<string>([folder.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of folders) {
      if (f.parentId && below.has(f.parentId) && !below.has(f.id)) {
        below.add(f.id);
        grew = true;
      }
    }
  }
  const parents = folders.filter((f) => !below.has(f.id) && f.depth < MAX_DEPTH);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await knowledgeFolders.update(token, folder.id, {
        name,
        description: description.trim() || null,
        parentId: parentId || null,
      });
      const sameRoles =
        roleIds.length === folder.roleIds.length && roleIds.every((r) => folder.roleIds.includes(r));
      if (canRestrict && !sameRoles) await knowledgeFolders.setRoles(token, folder.id, roleIds);
      onDone();
    } catch (e: any) {
      setError(e.message || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (
      !confirm(
        `Delete the folder "${folder.path}"?\n\nIts subfolders, skills and memory move to ${
          folder.parentId ? 'the folder above' : 'the top level'
        }. Nothing else is deleted.`,
      )
    )
      return;
    setBusy(true);
    try {
      await knowledgeFolders.remove(token, folder.id);
      onDone(true);
    } catch (e: any) {
      setError(e.message || 'Could not delete');
      setBusy(false);
    }
  };

  return (
    <div className="my-1 ml-2 flex flex-col gap-1.5 rounded-[9px] border border-[var(--border)] bg-[var(--surface-2)] p-2.5">
      <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} aria-label="Folder name" />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={2}
        maxLength={500}
        placeholder="What belongs here (shown to AI clients)"
        className={cn(inputCls, 'h-auto py-1.5')}
      />
      <select
        value={parentId}
        onChange={(e) => setParentId(e.target.value)}
        className={inputCls}
        aria-label="Parent folder"
      >
        <option value="">Top level</option>
        {parents.map((f) => (
          <option key={f.id} value={f.id}>
            Inside {f.path}
          </option>
        ))}
      </select>
      {canRestrict ? (
        <fieldset className="rounded-[8px] border border-[var(--border)] p-2">
          <legend className="px-1 text-[11.5px] text-[var(--text-2)]">Visible to</legend>
          <p className="mb-1 text-[11px] text-[var(--text-3)]">
            None checked: the whole workspace. Admins always see every folder.
          </p>
          {roleList.length === 0 && (
            <p className="text-[11px] text-[var(--text-3)]">No roles yet: create them under Settings → Roles.</p>
          )}
          {roleList.map((r) => (
            <label key={r.id} className="flex items-center gap-1.5 text-[12px] text-[var(--text)]">
              <input
                type="checkbox"
                checked={roleIds.includes(r.id)}
                onChange={(e) =>
                  setRoleIds((prev) => (e.target.checked ? [...prev, r.id] : prev.filter((x) => x !== r.id)))
                }
              />
              {r.name}
            </label>
          ))}
        </fieldset>
      ) : folder.roleIds.length > 0 ? (
        <p className="text-[11px] text-[var(--text-3)]">
          Visible to: {folder.roleIds.map((id) => roleList.find((r) => r.id === id)?.name ?? 'a role').join(', ')}
        </p>
      ) : isAdmin ? (
        <p className="text-[11px] text-[var(--text-3)]">Limiting folders to roles is part of Enterprise.</p>
      ) : null}
      {error && <p className="text-[11.5px] text-[var(--danger)]">{error}</p>}
      <div className="flex gap-1.5">
        <Button size="sm" variant="primary" onClick={save} disabled={busy || !name.trim()}>
          Save
        </Button>
        <Button size="sm" variant="secondary" onClick={() => onDone()}>
          Cancel
        </Button>
        <Button size="sm" variant="danger" className="ml-auto" onClick={remove} disabled={busy}>
          Delete
        </Button>
      </div>
    </div>
  );
}

function FolderIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 opacity-70">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 opacity-70" aria-hidden="true">
      <title>Limited to roles</title>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}
