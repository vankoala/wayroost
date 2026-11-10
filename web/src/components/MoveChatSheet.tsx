import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationSummary, FolderStatus } from '../../../shared/protocol';
import { api, moveChat } from '../api';
import { homeRelative } from '../format';
import { moveDisabledReason, moveFolders, validMoveFolder } from '../move';
import { canonicalFolder, groupByProject, projectTree } from '../projects';
import { toast, useStore } from '../store';
import { Sheet } from './common';

export function MoveChatSheet({ conversation, onClose }: { conversation: ConversationSummary; onClose: () => void }) {
  const conversations = useStore((s) => s.conversations);
  const folderConnection = useStore((s) => s.statuses.paseo.state);
  const current = canonicalFolder(conversation.project?.path);
  const folders = useMemo(() => moveFolders(projectTree(groupByProject(Object.values(conversations),
    (c) => c.status === 'needs_approval' || c.pendingApprovals > 0))), [conversations]);
  const [path, setPath] = useState(current ?? '');
  const [check, setCheck] = useState<{ path: string; status: FolderStatus } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // The sheet closes by itself when its chat is removed; a late failure then needs another place to show.
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const reason = moveDisabledReason(conversation);
  const valid = validMoveFolder(path);
  useEffect(() => {
    if (!valid || path === current) return;
    let live = true;
    const timer = setTimeout(() => {
      api.folderStatus(path)
        .then(({ status }) => { if (live) setCheck({ path, status }); })
        .catch(() => { if (live) setCheck({ path, status: 'unknown' }); });
    }, 400);
    return () => { live = false; clearTimeout(timer); };
  }, [path, valid, current, folderConnection]);
  const status = check?.path === path ? check.status : undefined;
  const submit = async () => {
    if (busy || reason || !valid || path === current || status !== 'exists') return;
    setBusy(true);
    setError('');
    try {
      await moveChat(conversation, path);
      onClose();
    } catch (err) {
      if (mounted.current) setError((err as Error).message);
      else toast((err as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <Sheet title="Move to folder" onClose={() => !busy && onClose()} footer={
      <button type="button" className="btn btn-primary btn-block" disabled={busy || !!reason || !valid || path === current || status !== 'exists'} onClick={submit}>
        {busy ? 'Moving…' : 'Move chat'}
      </button>
    }>
      <p className="muted">Choose an existing folder. Sub-agents follow this chat.</p>
      <p className="muted move-current-folder">Current folder: {current ? homeRelative(current) : 'Other chats'}</p>
      <div className="options move-folders" role="radiogroup" aria-label="Project folders">
        {folders.map((f) => (
          <button type="button" className="option" role="radio" key={f.path} aria-checked={path === f.path}
            disabled={busy} style={{ paddingInlineStart: `${16 + Math.min(f.depth, 3) * 20}px` }} onClick={() => { setPath(f.path); setError(''); }}>
            <span className="radio" />
            <span className="label"><div>{f.name}{f.path === current ? ' (current folder)' : ''}</div><div>{homeRelative(f.path)}</div></span>
          </button>
        ))}
      </div>
      <label className="field">
        <span>Folder path</span>
        <input type="text" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false}
          value={path} disabled={busy} placeholder="/home/me/project" onChange={(e) => { setPath(e.target.value); setError(''); }} />
        <small role="status">
          {!valid ? 'Enter an absolute project folder with no trailing slash, . or .. parts.' : path === current ? 'Current folder' :
            status === 'exists' ? 'Folder exists.' : status === undefined ? 'Checking folder…' :
              status === 'unknown' ? "Couldn't check the folder. Connect Paseo and try again." : 'Choose a folder that already exists.'}
        </small>
      </label>
      {reason && <p className="error-text">{reason}</p>}
      {error && <p className="error-text" role="alert">{error}</p>}
    </Sheet>
  );
}
