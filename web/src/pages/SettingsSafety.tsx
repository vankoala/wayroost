import { Ban, BookOpen, Eye, Info, LoaderCircle, ShieldCheck, TerminalSquare, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { WorkerApprovalsStatus } from '../../../shared/safety.js';
import type { SafetyCommandsStatus } from '../../../shared/protocol.js';
import { APPROVAL_MODES } from '../../../shared/settings-ops.js';
import { api } from '../api.js';
import { Page } from '../components/common.js';
import { SettingsRestart } from '../components/SettingsRestart.js';
import { HiddenNote, LevelChip, NoDataLine, SettingsReadNotice, SettingsSectionSource, SettingsSectionGuard, useSettingsReadOnly, useSettingsRefreshing, useSettingsStatus, viewReady, SettingRow, SettingsConfirmPrompt, TimingNotes, accessForValue, useSettingsChange, useSettingsSection, type SettingsStatusState } from '../components/SettingsRows.js';
import { entrySha256, hermesSetting, rowValue, settingAsStringList, settingAsText, settingsErrorText, type RowValue, type SettingsSectionPayload } from '../settingsModel.js';
import { opTiming } from './SettingsAgents.js';

/**
 * Settings → Safety: when Hermes asks before it acts, the commands it stopped
 * asking about, whether its own skill edits wait for an OK, whether Paseo
 * workers may answer each other's permissions, and what is only shown here.
 * Tighten at the lower level, loosen at the higher one: making things stricter
 * always reaches a phone; making them looser needs a code or the PC.
 */

/** What each approval mode means, in the words the page shows beside it. */
export const APPROVAL_MODE_HELP: Record<string, string> = {
  manual: 'Always ask before guarded actions that have not already been approved.',
  smart: 'A model guardian approves the flagged commands and lets the rest through.',
  off: 'Never ask. Guarded commands run without anyone.',
};

const WORKER_LIMITATIONS: Record<WorkerApprovalsStatus['limitations'][number], string> = {
  existing_agents: 'Agents already running keep their old limits until they restart.',
  caller_identity: 'Caller identity is a guardrail; it does not isolate workers.',
  same_user_config: 'Programs running as the same user can still edit the configuration.',
  cli_guard_not_installed: 'The CLI guard is not installed.',
};

const PIN_READ_ONLY = 'Keys the install pins are shown read-only; managing them waits for a later release.';
const PIN_VALUE_UNAVAILABLE = 'Pinned by the install; the effective value is unavailable. Read-only here.';

function isWorkerApprovalsStatus(value: unknown): value is WorkerApprovalsStatus {
  return WorkerApprovalsStatus.safeParse(value).success;
}

function isSafetyCommandsStatus(value: unknown): value is SafetyCommandsStatus {
  if (!value || typeof value !== 'object') return false;
  const status = value as Partial<SafetyCommandsStatus>;
  return typeof status.enabled === 'boolean' && Array.isArray(status.commands) && status.commands.every(command => typeof command === 'string');
}

/** Managed entries override the user file even when their values are not projected. */
function safetySetting(payload: SettingsSectionPayload, key: string) {
  return hermesSetting(payload, 'hermes.safety', key, payload);
}

function ApprovalMode() {
  const readOnly = useSettingsReadOnly();
  const section = useSettingsSection('safety');
  const { payload } = section;
  const change = useSettingsChange(payload);
  if (section.status !== 'ready' || !payload) return <SettingsReadNotice state={section} />;
  if (!viewReady(payload, 'hermes.safety')) return <SettingsReadNotice state={section} view="hermes.safety" />;
  const approval = safetySetting(payload, 'approvals.mode');
  const mode = approval.unavailable ? '' : settingAsText(approval.value, 'smart');
  const cron = safetySetting(payload, 'approvals.cron_mode');
  const cronMode = settingAsText(cron.value, '');
  return (
    <>
      <div className="group-title">Hermes approvals</div>
      <div className="group safety-approvals">
        <SettingRow
          icon={<ShieldCheck size={18} />}
          title="Approval mode"
          help={approval.unavailable ? approval.pinned ? PIN_VALUE_UNAVAILABLE : 'The effective value is unavailable. Read-only here.'
            : <>{approval.pinned && 'Pinned by the install. '}{APPROVAL_MODE_HELP[mode] ?? `Now: ${mode}.`}</>}
          timing={opTiming('hermes.approval-mode')}
        >
          <div className="approval-options" role="radiogroup" aria-label="Approval mode">
            {APPROVAL_MODES.map((option) => {
              const access = accessForValue(payload, 'hermes.approval-mode', option);
              return (
                <label className="approval-option" key={option}>
                  <input
                    type="radio"
                    name="approval-mode"
                    value={option}
                    checked={option === mode}
                    disabled={readOnly || approval.pinned || approval.unavailable || access === 'read-only' || change.busy !== null}
                    title={approval.pinned ? 'Pinned by the install.' : access === 'read-only' ? 'Only the PC can move the mode this way.' : APPROVAL_MODE_HELP[option]}
                    onChange={() => void change.run(`mode-${option}`, { operation: 'hermes.approval-mode', params: { mode: option } }, 'hermes.safety')}
                  />
                  <span className="approval-name">{option}</span>
                  {!approval.unavailable && <span className="approval-help muted">{APPROVAL_MODE_HELP[option]}</span>}
                  <LevelChip level={option === 'manual' ? 'anywhere' : 'pc-only'} />
                </label>
              );
            })}
          </div>
        </SettingRow>
        <div className="kv">
          <BookOpen size={18} />
          <div className="grow">
            <div>Unattended runs</div>
            <div className="muted">
              {cron.unavailable ? cron.pinned ? PIN_VALUE_UNAVAILABLE : 'Scheduled-job approval mode is unavailable.'
                : cronMode ? `Scheduled jobs answer with: ${cronMode}.${cron.pinned ? ' Pinned by the install.' : ''}` : 'Scheduled jobs follow Hermes’ own default.'} Shown here; not edited.
            </div>
          </div>
        </div>
      </div>
      <SettingsConfirmPrompt pending={change.pending} busy={change.busy !== null} disabled={readOnly} onConfirm={() => void change.confirmNow()} onCancel={change.dismiss} />
    </>
  );
}

/** The “always allowed” list: entries as texts, each with a revoke. */
function AlwaysAllowed() {
  const readOnly = useSettingsReadOnly();
  const refreshing = useSettingsRefreshing();
  const section = useSettingsSection('safety');
  const { payload } = section;
  const [revoked, setRevoked] = useState(false);
  const [restartError, setRestartError] = useState<string>();
  const change = useSettingsChange(payload);
  const [revoking, setRevoking] = useState<string | null>(null);
  if (section.status !== 'ready' || !payload) return <SettingsReadNotice state={section} />;
  if (!viewReady(payload, 'hermes.safety')) return <SettingsReadNotice state={section} view="hermes.safety" />;
  const restartRun = payload.restartRuns?.at(-1);
  const allowlist = safetySetting(payload, 'command_allowlist');
  const access = allowlist.pinned || allowlist.overlayUnavailable || allowlist.value.kind === 'no-data' ? 'read-only' : accessForValue(payload, 'hermes.revoke-always', 'any');
  const list = settingAsStringList(allowlist.value);
  const revoke = async (entry: string, digest?: string) => {
    setRevoking(entry);
    digest ??= await entrySha256(entry);
    const outcome = await change.run(`revoke-${digest}`, { operation: 'hermes.revoke-always', params: { entrySha256: digest } }, 'hermes.safety', () => setRevoked(true));
    if (outcome.kind === 'applied') setRestartError(outcome.change.restartRequired?.code ? settingsErrorText(outcome.change.restartRequired.code) : undefined);
    setRevoking(null);
  };
  return (
    <>
      <div className="group-title">Always allowed commands</div>
      <div className="group safety-always">
        {allowlist.pinned && !allowlist.unavailable && <div className="kv">
          <Eye size={18} />
          <div className="grow muted">Pinned by the install. Read-only here.</div>
        </div>}
        {list === 'hidden' && (
          <div className="kv">
            <Eye size={18} />
            <div className="grow muted">{allowlist.pinned ? PIN_VALUE_UNAVAILABLE : 'The commands and their exact text are shown on the PC. You can revoke a hidden entry here.'}</div>
          </div>
        )}
        {list === 'hidden' && !allowlist.pinned && !allowlist.overlayUnavailable && payload.allowlistEntries?.map((entry, index) => <div className="kv" key={entry.entrySha256}>
          <TerminalSquare size={18} /><div className="grow">Hidden command {index + 1} <LevelChip level="anywhere" /></div>
          <button type="button" className="btn btn-secondary" aria-label={`Revoke hidden command ${index + 1}`} disabled={readOnly || access === 'read-only' || revoking !== null || change.busy !== null}
            onClick={() => void revoke(`Hidden command ${index + 1}`, entry.entrySha256)}>Revoke</button>
        </div>)}
        {Array.isArray(list) && list.length === 0 && (
          <div className="kv">
            <Eye size={18} />
            <div className="grow muted">Nothing is on the list. Guarded commands follow the effective approval mode.</div>
          </div>
        )}
        {Array.isArray(list) && list.map((entry) => (
          <div className="kv" key={entry}>
            <TerminalSquare size={18} />
            <div className="grow">
              <div><code>{entry}</code>&nbsp;<LevelChip level="anywhere" /></div>
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={readOnly || access === 'read-only' || revoking !== null || change.busy !== null}
              aria-label={`Revoke ${entry}`}
              onClick={() => void revoke(entry)}
            >
              {revoking === entry || change.busy?.startsWith('revoke-') ? <LoaderCircle size={16} className="spin" /> : <Ban size={16} />}
              <span>Revoke</span>
            </button>
          </div>
        ))}
        <div className="kv">
          <Info size={18} />
          <div className="grow muted">
            Revoking removes the entry from your file. WhatsApp and phone calls need a Hermes gateway restart to reload the saved list. Wayroost schedules a tracked restart when idle after saving the revocation.
            <TimingNotes timing={opTiming('hermes.revoke-always')} />
          </div>
        </div>
        {(revoked || restartRun) && <div className="kv"><div className="grow">
          {restartError && <div role="status">The idle restart could not be scheduled. {restartError}</div>}
          <div className="muted">Hermes’ gateway may keep honouring the revoked entry until its tracked restart finishes.</div>
          <SettingsRestart component="hermes" initialRun={restartRun} when={restartRun ? "now" : undefined} disableWhileRunning disabled={readOnly && !refreshing} refreshing={refreshing} />
        </div></div>}
      </div>
      <SettingsConfirmPrompt pending={change.pending} busy={change.busy !== null} disabled={readOnly} onConfirm={() => void change.confirmNow()} onCancel={change.dismiss} />
    </>
  );
}

function SkillStaging() {
  const readOnly = useSettingsReadOnly();
  const section = useSettingsSection('safety');
  const { payload } = section;
  const change = useSettingsChange(payload);
  if (section.status !== 'ready' || !payload) return <SettingsReadNotice state={section} />;
  if (!viewReady(payload, 'hermes.safety')) return <SettingsReadNotice state={section} view="hermes.safety" />;
  const staging = safetySetting(payload, 'skills.write_approval');
  const stagingValue = staging.value;
  const memory = safetySetting(payload, 'memory.write_approval');
  const enabled = stagingValue.kind === 'value' ? stagingValue.value === true : false;
  const access = staging.pinned || staging.unavailable ? 'read-only' : accessForValue(payload, 'hermes.skill-staging', String(!enabled));
  return (
    <>
      <div className="group-title">What Hermes may write by itself</div>
      <div className="group safety-staging">
        <SettingRow
          icon={<BookOpen size={18} />}
          title="Skill changes wait for your OK"
          help={staging.unavailable ? staging.pinned ? PIN_VALUE_UNAVAILABLE : 'The effective value is unavailable. Read-only here.' : enabled
            ? 'On: Hermes holds every skill create or edit, background reviews included, for you to diff and approve.'
            : 'Off: Hermes writes skills as it likes. Switching this on is the safe direction and reaches a phone.'}
          level={enabled ? 'pc-only' : 'anywhere'}
          timing={opTiming('hermes.skill-staging')}
        >
          {access === 'read-only' ? (
            <span className="muted">{staging.unavailable ? 'Unavailable' : enabled ? 'Waiting for your OK' : 'Not waiting'}</span>
          ) : (
            <button
              type="button"
              role="switch"
              className="switch"
              aria-checked={enabled}
              aria-label="Skill changes wait for your OK"
              disabled={readOnly || change.busy !== null}
              onClick={() => void change.run('skill-staging', { operation: 'hermes.skill-staging', params: { enabled: !enabled } }, 'hermes.safety')}
            />
          )}
        </SettingRow>
        <div className="kv">
          <Eye size={18} />
          <div className="grow">
            <div>Memory saves</div>
            <div className="muted">
              {memory.unavailable ? memory.pinned ? PIN_VALUE_UNAVAILABLE : 'Memory-write approval is unavailable.' : memory.value.kind === 'value'
                ? `Memory writes: ${memory.value.value ? 'wait for your OK' : 'go through'}.${memory.pinned ? ' Pinned by the install.' : ''} Shown here; left as they are.`
                : 'Shown here; left as they are.'}
            </div>
          </div>
        </div>
      </div>
      <SettingsConfirmPrompt pending={change.pending} busy={change.busy !== null} disabled={readOnly} onConfirm={() => void change.confirmNow()} onCancel={change.dismiss} />
    </>
  );
}

/** Workers' approvals depend on the worker status and Paseo's saved configuration. */
function WorkerApprovalSwitch({ workerStatus }: {
  workerStatus: SettingsStatusState<WorkerApprovalsStatus>;
}) {
  const readOnly = useSettingsReadOnly();
  const section = useSettingsSection('safety');
  const { payload } = section;
  const agentsSection = useSettingsSection('agents');
  const change = useSettingsChange(payload ? { ...payload, views: [...(payload.views ?? []), ...(agentsSection.payload?.views ?? [])] } : undefined);
  const workerApprovals = workerStatus.status === 'ready' && !workerStatus.refreshing ? workerStatus.value : undefined;
  if (section.status !== 'ready' || !payload) return <SettingsReadNotice state={section} />;
  const workerKnown = workerApprovals !== undefined;
  const workerOn = workerApprovals?.enabled ?? true;
  const legacy = payload.operations?.find(info => info.operation === 'paseo.worker-approvals')?.writer === 'legacy';
  const workerAccess = accessForValue(payload, 'paseo.worker-approvals', String(!workerOn));
  return (
    <>
      <div className="group-title">Workers</div>
      <div className="group safety-switches">
        <SettingRow
          icon={<ShieldCheck size={18} />}
          title="Workers' approvals come to me"
          help={<>
            <div>{workerApprovals?.choiceConfirmed || workerApprovals?.config === 'written' ? 'Saved choice' : 'Default choice'}: {workerKnown ? workerOn ? 'On' : 'Off' : 'unavailable'}. Protection: {workerApprovals ? workerApprovals.application === 'pending' ? 'not verified' : 'partial' : 'unknown'}.</div>
            {workerApprovals && <>
              <div>Config: {workerApprovals.config} · reload: {workerApprovals.reload} · choice {workerApprovals.choiceConfirmed ? 'confirmed' : 'not confirmed'}</div>
              {workerApprovals.message && <div>{workerApprovals.message}</div>}
              {workerApprovals.uncoveredProviders.length > 0 && <div>Not covered: {workerApprovals.uncoveredProviders.join(', ')}</div>}
              {workerApprovals.limitations.map(limit => <div key={limit}>{WORKER_LIMITATIONS[limit]}</div>)}
            </>}
          </>}
          level={legacy || workerOn ? 'pc-only' : 'anywhere'}
          timing={opTiming('paseo.worker-approvals')}
        >
          {workerKnown ? (workerAccess === 'read-only' ? (
            <span className="muted">{workerOn ? 'On' : 'Off'}</span>
          ) : (
            <button
              type="button"
              role="switch"
              className="switch"
              aria-checked={workerOn}
              aria-label="Workers' approvals come to me"
              disabled={readOnly || change.busy !== null || !legacy && !viewReady(agentsSection.payload, 'paseo.agents')}
              onClick={() => void change.run('worker-approvals', { operation: 'paseo.worker-approvals', params: { enabled: !workerOn } }, 'paseo.agents')}
            />
          )) : <span className="muted">{workerStatus.status === 'error' ? 'Worker policy unavailable.' : 'Checking worker policy…'}</span>}
        </SettingRow>
      </div>
      <SettingsConfirmPrompt pending={change.pending} busy={change.busy !== null} disabled={readOnly} onConfirm={() => void change.confirmNow()} onCancel={change.dismiss} />
    </>
  );
}

function SafetyCommandSwitch({ commandStatus }: { commandStatus: SettingsStatusState<SafetyCommandsStatus> }) {
  const readOnly = useSettingsReadOnly();
  const section = useSettingsSection('safety');
  const { payload } = section;
  const change = useSettingsChange(payload);
  const commands = commandStatus.status === 'ready' && !commandStatus.refreshing ? commandStatus.value : undefined;
  if (section.status !== 'ready' || !payload) return <SettingsReadNotice state={section} />;
  const safetyEnabled = rowValue(payload, 'wayroost.settings', 'safetyCommandsEnabled');
  const legacy = payload.operations?.find(info => info.operation === 'wayroost.safety-commands')?.writer === 'legacy';
  const enabled = commands?.enabled ?? (safetyEnabled.kind === 'value' && safetyEnabled.value === true);
  const commandAccess = accessForValue(payload, 'wayroost.safety-commands', String(!enabled));
  const approval = safetySetting(payload, 'approvals.mode');
  const approvalText = approval.unavailable ? 'unavailable' : settingAsText(approval.value, 'smart');
  return (<>
      <div className="group-title">Safety commands</div>
      <div className="group safety-switches">
        {!commands && <SettingRow title="Hermes safety commands" help={commandStatus.status === 'error' ? 'Safety-command status unavailable.' : 'Checking safety-command status…'} />}
        {commands && (legacy || viewReady(payload, 'wayroost.settings')) ? (
          <SettingRow
            icon={enabled ? <TriangleAlert size={18} /> : <ShieldCheck size={18} />}
            title="Hermes safety commands"
            help={enabled
              ? `On: these slash commands are allowed in chats: ${commands.commands.map(command => `/${command}`).join(', ')}. Guarded actions follow the effective approval mode: ${approvalText}.`
              : `Off: only these slash commands are blocked in chats: ${commands.commands.map(command => `/${command}`).join(', ')}. Guarded actions follow the effective approval mode: ${approvalText}.`}
            level={!legacy && enabled ? 'anywhere' : 'pc-only'}
            timing={opTiming('wayroost.safety-commands')}
          >
            {commandAccess === 'read-only' ? (
              <span className="muted">{enabled ? 'On' : 'Off'}</span>
            ) : (
              <button
                type="button"
                role="switch"
                className="switch"
                aria-checked={enabled}
                aria-label="Hermes safety commands"
                disabled={readOnly || change.busy !== null}
                onClick={() => void change.run('safety-commands', { operation: 'wayroost.safety-commands', params: { enabled: !enabled } }, 'wayroost.settings')}
              />
            )}
          </SettingRow>
        ) : <SettingsReadNotice state={section} view="wayroost.settings" />}
        <div className="kv">
          <Info size={18} />
          <div className="grow muted">
            Secret prompts — the answers a card asks for — are typed in the app only, never echoed anywhere else.
          </div>
        </div>
      </div>
      <SettingsConfirmPrompt pending={change.pending} busy={change.busy !== null} disabled={readOnly} onConfirm={() => void change.confirmNow()} onCancel={change.dismiss} />
    </>
  );
}

/** What this release shows but does not manage. */
function ShownNotManaged() {
  const section = useSettingsSection('safety');
  const { payload } = section;
  if (section.status !== 'ready' || !payload) return <SettingsReadNotice state={section} />;
  const permissionDetail = (entries: [string, RowValue][], hiddenText: string): ReactNode => <>
    {entries.some(([, value]) => value.kind === 'hidden') ? <HiddenNote text={hiddenText} />
      : entries.some(([, value]) => value.kind === 'no-data') ? <NoDataLine code={entries.map(([, value]) => value).find(value => value.kind === 'no-data')?.code} />
      : entries.some(([, value]) => value.kind === 'value') ? entries.map(([label, value]) => value.kind === 'value'
        ? <div key={label}>{label}: <code>{typeof value.value === 'string' ? value.value : JSON.stringify(value.value)}</code></div> : null)
      : <div>No rules configured.</div>}
    <div>Read-only here; managing these rules waits for a later release.</div>
    {entries.some(([, value]) => value.kind === 'no-data') && <button type="button" className="btn btn-secondary" onClick={section.reload}>Retry</button>}
  </>;
  const claude = permissionDetail([
    ['Default mode', rowValue(payload, 'claude.permissions', 'permissions.defaultMode')],
    ['Allow', rowValue(payload, 'claude.permissions', 'permissions.allow')],
    ['Deny', rowValue(payload, 'claude.permissions', 'permissions.deny')],
  ], 'Claude Code permission rules are shown on the PC.');
  const opencode = permissionDetail([['Rules', rowValue(payload, 'opencode.permissions', 'permission')]], 'OpenCode permission rules are shown on the PC.');
  const codex = permissionDetail([
    ['Policy', rowValue(payload, 'codex.approvals', 'approval_policy')],
    ['sandbox', rowValue(payload, 'codex.approvals', 'sandbox_mode')],
  ], 'Codex approval rules are shown on the PC.');
  const pinned = (payload.views?.find((view) => view.view === 'hermes.managed')?.ok
    && payload.views?.find((view) => view.view === 'hermes.managed')?.present)
    ? (payload.views.find((view) => view.view === 'hermes.managed')?.values?.filter(entry => entry.exists).length ?? 0) : 0;
  const listRow = (label: string, detail: ReactNode) => (
    <div className="kv" key={label}>
      <Eye size={18} />
      <div className="grow">
        <div>{label}</div>
        <div className="muted">{detail}</div>
      </div>
    </div>
  );
  return (
    <>
      <div className="group-title">Shown, not managed here</div>
      <div className="group safety-shown">
        {listRow('Claude Code’s “always allow” rules', claude)}
        {listRow('Codex’s own approvals', codex)}
        {listRow('OpenCode’s permissions', opencode)}
        {pinned > 0 && listRow('Keys the install pins', `${pinned} key name${pinned === 1 ? '' : 's'} the install pins are in effect over your file. ${PIN_READ_ONLY}`)}
        {listRow('Risk tiers and “require the app”', 'The tier table arrives with the team section; it is read-only when it does.')}
        {listRow('Memory sources', 'A hard gate with no code on any channel. It arrives with the team section.')}
      </div>
    </>
  );
}

/** Settings → Safety. */
export function SafetySettingsPage() {
  const commandStatus = useSettingsStatus(api.safetyCommands, isSafetyCommandsStatus);
  const workerStatus = useSettingsStatus(api.workerApprovals, isWorkerApprovalsStatus);
  return (
    <Page className="page-safety-settings" title="Safety">
      <p className="page-lead">
        Who asks before acting, what is allowed without asking, and what only this PC may loosen.
        A phone can always make things stricter; loosening takes a confirm code or the desktop on the PC.
      </p>
      <SettingsSectionSource section="safety">
        <SettingsSectionSource section="agents">
          <SettingsSectionGuard section="safety" views={['hermes.safety', 'hermes.managed']}>
            <ApprovalMode />
            <AlwaysAllowed />
            <SkillStaging />
          </SettingsSectionGuard>
          <SettingsSectionGuard section="safety" dependency={{ section: 'agents', views: ['paseo.agents'] }} reads={[workerStatus]} legacyOperation="paseo.worker-approvals">
            <WorkerApprovalSwitch workerStatus={workerStatus} />
          </SettingsSectionGuard>
          <SettingsSectionGuard section="safety" views={['wayroost.settings']} reads={[commandStatus]} legacyOperation="wayroost.safety-commands">
            <SafetyCommandSwitch commandStatus={commandStatus} />
          </SettingsSectionGuard>
          <ShownNotManaged />
        </SettingsSectionSource>
      </SettingsSectionSource>
      <div className="group">
        <div className="kv">
          <Info size={18} />
          <div className="grow muted">
            “PC only” stops a phone, a stolen pairing used remotely, and remote routes. It does not stop a program
            running as you on this PC: on today’s stack, that is what the next release’s isolation is for.
          </div>
        </div>
      </div>
    </Page>
  );
}
