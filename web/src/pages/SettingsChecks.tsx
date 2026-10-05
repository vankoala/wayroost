import { CircleCheck, RefreshCw, TriangleAlert } from 'lucide-react';
import { settingsChecksResponseSchema, type CheckFix, type SettingsCheckRow, type SettingsChecksResponse } from '../../../shared/settings-checks.js';
import { operationLevel, operationSpec, operationTarget, type KeyTimingRule } from '../../../shared/settings-ops.js';
import type { Timing } from '../../../shared/settings.js';
import { api } from '../api.js';
import { Page } from '../components/common.js';
import { SettingsRestart } from '../components/SettingsRestart.js';
import { SettingsConfirmPrompt, SettingsReadNotice, SettingsSectionGuard, TimingNotes, LevelChip, accessForValue, useSettingsChange, useSettingsReadOnly, useSettingsSection, useSettingsStatus, type SettingsReadState } from '../components/SettingsRows.js';
import { settingsErrorText } from '../settingsModel.js';
import { setState } from '../store.js';

function isChecks(value: unknown): value is SettingsChecksResponse {
  return settingsChecksResponseSchema.safeParse(value).success;
}

/** Catalogue timing describes the Fix; check states always come from the server. */
function fixTiming(operation: string, params: Record<string, unknown>): Timing {
  const rule = operationSpec(operation)!.timing;
  const selected = 'byParams' in rule ? rule.values[rule.byParams.map(key => String(params[key])).join('/')] : rule;
  if (!selected) return [];
  return 'byKeys' in selected ? (selected as KeyTimingRule).byKeys.flatMap(group => group.timing) : selected;
}

function ApplyFix({ id, operation, params }: { id: string; operation: string; params: Record<string, unknown> }) {
  const spec = operationSpec(operation)!;
  const readOnly = useSettingsReadOnly();
  const section = useSettingsSection(spec.section);
  const change = useSettingsChange(section.payload);
  const parameter = 'byParam' in spec.level ? String(params[spec.level.byParam]) : 'any';
  const access = accessForValue(section.payload, operation, parameter);
  return <div className="setting-stack">
    <div className="setting-inline">
      <LevelChip level={operationLevel(spec, params)} />
      <button type="button" className="btn btn-secondary" aria-label={`Fix ${id}`} disabled={readOnly || access === 'read-only' || change.busy !== null}
        onClick={() => void change.run(id, { operation, params })}>Fix</button>
    </div>
    <TimingNotes timing={fixTiming(operation, params)} />
    {access === 'read-only' && <div className="muted">This Fix is read-only on this device.</div>}
    <SettingsConfirmPrompt pending={change.pending} busy={change.busy !== null} disabled={readOnly}
      onConfirm={() => void change.confirmNow()} onCancel={change.dismiss} />
  </div>;
}

function Fix({ id, fix, read, refresh }: { id: string; fix: CheckFix; read: SettingsReadState; refresh: () => void }) {
  if ('restart' in fix) return <SettingsRestart {...fix.restart} disabled={read.status !== 'ready'} refreshing={!!read.refreshing} onAccepted={refresh} />;
  const operation = 'action' in fix ? fix.action : fix.operation;
  const params = 'action' in fix ? {} : fix.params;
  const spec = operationSpec(operation)!;
  const needsManaged = !spec.recovery && operationTarget(spec, params) === 'hermes-config' && spec.section !== 'checks';
  return <SettingsSectionGuard section={spec.section} reads={[read]}
    dependency={needsManaged ? { section: 'safety', views: ['hermes.managed'] } : undefined}>
    <ApplyFix id={id} operation={operation} params={params} />
  </SettingsSectionGuard>;
}

const STATE_TEXT: Record<SettingsCheckRow['state'], string> = { ok: 'OK', warn: 'Warning', fail: 'Needs attention', unknown: 'Unknown' };

/** Server rows are ordered for attention without deriving any check result. */
export function CheckRows({ rows, read, refresh }: { rows: readonly SettingsCheckRow[]; read: SettingsReadState; refresh: () => void }) {
  const ordered = [...rows].sort((a, b) => Number(b.priority === 'high') - Number(a.priority === 'high')
    || Number(b.state === 'fail') - Number(a.state === 'fail'));
  return <div className="group settings-checks">
    {ordered.map(row => <div className="kv" key={row.id} data-check-id={row.id} data-state={row.state}>
      {row.state === 'ok' ? <CircleCheck size={18} /> : <TriangleAlert size={18} />}
      <div className="grow setting-stack">
        <div>{row.sentence}</div>
        <div className="muted">{STATE_TEXT[row.state]}{row.priority && <> · Priority: {row.priority}</>} · <code>{row.id}</code></div>
        {row.details?.map((detail, index) => <div className="muted" key={index}>{detail}</div>)}
        {row.fix && <Fix key={JSON.stringify(row.fix)} id={row.id} fix={row.fix} read={read} refresh={refresh} />}
      </div>
    </div>)}
    {rows.length === 0 && <div className="kv"><div className="grow muted">The server returned no check rows.</div></div>}
  </div>;
}

/** Settings → Checks: comparisons and their suggested changes, as reported by this PC. */
export function ChecksSettingsPage() {
  const checks = useSettingsStatus(api.settingsChecks, isChecks);
  const refresh = () => setState(state => ({ ...state, settingsVersion: state.settingsVersion + 1 }));
  return <Page className="page-checks-settings" title="Checks">
    <p className="page-lead">What this PC checked, and the changes it offers for mismatches.</p>
    <button type="button" className="btn btn-secondary" disabled={checks.status === 'loading' || !!checks.refreshing} onClick={refresh}>
      <RefreshCw size={16} /> Refresh checks
    </button>
    <SettingsReadNotice state={checks} />
    {checks.value && <>
      <p className="muted">Checked at {new Date(checks.value.generatedAt).toLocaleString()}.</p>
      {checks.value.unavailable?.map((code, index) => <p className="muted" role="status" key={index}>{settingsErrorText(code)}</p>)}
      <CheckRows rows={checks.value.rows} read={checks} refresh={checks.reload} />
    </>}
  </Page>;
}
