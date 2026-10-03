import { ArchiveRestore, LoaderCircle, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ArchivedThread } from '../../../shared/protocol';
import { api, refreshList, reportTidy } from '../api';
import { readableBridgeText } from '../bridge';
import { shortTime } from '../format';
import { toast } from '../store';
import { ConfirmDialog, SOURCE_NAMES, Sheet, SourceAvatar } from './common';

const keyOf = (t: ArchivedThread) => `${t.source}:${t.id}`;

/** What's archived in Hermes and Paseo, to restore or delete for good. */
export function ArchivedSheet({ onClose, as = 'sheet' }: { onClose: () => void; as?: 'sheet' | 'page' }) {
  const [threads, setThreads] = useState<ArchivedThread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ArchivedThread | null>(null);

  useEffect(() => {
    let live = true;
    api.archived().then(
      (list) => {
        if (live) setThreads(list.threads);
      },
      (err) => {
        if (live) setError((err as Error).message);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const forget = (t: ArchivedThread) => setThreads((list) => list?.filter((x) => keyOf(x) !== keyOf(t)) ?? null);

  const restore = async (t: ArchivedThread) => {
    setBusy(keyOf(t));
    try {
      const ref = { source: t.source, id: t.id };
      if (reportTidy('restored', [ref], await api.restoreThreads([ref])).length) {
        forget(t);
        void refreshList().catch(() => {});
      }
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (t: ArchivedThread) => {
    setBusy(keyOf(t));
    try {
      const ref = { source: t.source, id: t.id };
      if (reportTidy('deleted', [ref], await api.deleteThreads([ref])).length) forget(t);
      setDeleting(null);
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet title="Archived threads" onClose={onClose} as={as}>
      {error ? (
        <p className="error-text">{error}</p>
      ) : !threads ? (
        <p className="muted archived-empty">
          <LoaderCircle size={16} className="spin" /> Loading…
        </p>
      ) : threads.length === 0 ? (
        <p className="muted archived-empty">Nothing is archived.</p>
      ) : (
        <div className="group archived-list">
          {threads.map((t) => {
            const title = readableBridgeText(t.title) ?? t.title;
            return (
              <div className="kv" key={keyOf(t)}>
                <SourceAvatar source={t.source} small />
                <div className="grow">
                  <div className="archived-title">{title}</div>
                  <div className="muted">{[t.folder, shortTime(t.updatedAt)].filter(Boolean).join(' · ')}</div>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => restore(t)}
                  disabled={busy !== null}
                  aria-label={`Restore ${title}`}
                >
                  {busy === keyOf(t) ? <LoaderCircle size={16} className="spin" /> : <ArchiveRestore size={16} />}
                  Restore
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setDeleting(t)}
                  disabled={busy !== null}
                  aria-label={`Delete ${title}`}
                >
                  <Trash2 size={18} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete this thread?"
          message={`“${readableBridgeText(deleting.title) ?? deleting.title}” will be deleted from ${SOURCE_NAMES[deleting.source]} for good. This can't be undone.`}
          confirmLabel="Delete"
          danger
          busy={busy !== null}
          onConfirm={() => remove(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </Sheet>
  );
}
