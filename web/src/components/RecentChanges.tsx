import { RotateCcw } from 'lucide-react';
import { SETTINGS_OPERATIONS } from '../../../shared/settings-ops.js';
import { LevelChip, SettingsConfirmPrompt, SettingsSectionGuard, useSettingsReadOnly, SettingsReadNotice, TimingNotes, accessForUndo, useSettingsChange, useSettingsSection } from './SettingsRows.js';
import { useStore } from '../store.js';
import { keyChips, settingsErrorText } from '../settingsModel.js';
import { shortTime } from '../format.js';
import type { RecentChange } from '../settingsModel.js';

/**
 * Settings → Overview → Recent changes: the last thirty settings moves on
 * this PC, each with what it touched, who made it, its level and when it took
 * effect — and Undo where undo is allowed. An undo runs through the same
 * pipeline as the change and is audited the same way; if the file moved since,
 * the server refuses it and says so.
 */

function changeTitle(change: RecentChange): string {
  const title = Object.hasOwn(SETTINGS_OPERATIONS, change.operation)
    ? SETTINGS_OPERATIONS[change.operation as keyof typeof SETTINGS_OPERATIONS].title
    : change.operation;
  return change.action === 'undo' ? `Undo of ${title}` : title;
}

export function RecentChanges() {
  return <SettingsSectionGuard section="overview"><RecentChangesList /></SettingsSectionGuard>;
}

function RecentChangesList() {
  const readOnly = useSettingsReadOnly();
  const section = useSettingsSection('overview');
  const { payload } = section;
  const change = useSettingsChange();
  const device = useStore((state) => state.device);
  if (section.status !== 'ready') return <><div className="group-title">Recent changes</div><SettingsReadNotice state={section} /></>;
  const changes = payload?.changes ?? [];
  return (
    <>
      <div className="group-title">Recent changes</div>
      <div className="group recent-changes">
        {changes.length === 0 && (
          <div className="kv">
            <div className="grow muted">Nothing has been changed through Settings yet.</div>
          </div>
        )}
        {changes.map((entry) => {
          const access = accessForUndo(entry, device);
          return (
          <div className="kv" key={entry.id}>
            <div className="grow">
              <div>
                {changeTitle(entry)}
                &nbsp;<LevelChip level={entry.level} />
              </div>
              <div className="muted">
                {shortTime(entry.at)}
                {entry.device ? ` · ${entry.device.name || (entry.device.kind === 'desktop' ? 'this PC' : entry.device.kind)}` : ''}
                {' · '}
                {entry.result === 'ok' ? (entry.action === 'undo' ? 'Undone.' : 'Applied.') : settingsErrorText(entry.result)}
              </div>
              {entry.keys.length > 0 && <div className="muted key-list">{keyChips(entry.keys).join(' · ')}</div>}
              <TimingNotes timing={entry.timing} />
            </div>
            {entry.undoable && (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={readOnly || change.busy !== null || access === 'read-only'}
                title={access === 'read-only' ? 'Restore this change on the PC.' : undefined}
                aria-label={`Undo ${changeTitle(entry)}`}
                onClick={() => void change.run(`undo-${entry.id}`, { change: entry.id })}
              >
                <RotateCcw size={16} /> Undo
              </button>
            )}
          </div>
        ); })}
      </div>
      <SettingsConfirmPrompt pending={change.pending} busy={change.busy !== null} disabled={readOnly} onConfirm={() => void change.confirmNow()} onCancel={change.dismiss} />
    </>
  );
}
