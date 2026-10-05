import { BookOpenText, Bot, CloudOff, Gauge, Info, LoaderCircle, MessagesSquare, Route, Save, SlidersHorizontal, UserRound } from 'lucide-react';
import type { CloudAgent, CloudAgentsStatus } from '../../../shared/protocol.js';
import { HERMES_PERSONALITIES, PASEO_AGENT_PROVIDERS, REASONING_EFFORTS, SETTINGS_OPERATIONS } from '../../../shared/settings-ops.js';
import type { Timing } from '../../../shared/settings.js';
import { Page } from '../components/common.js';
import { HiddenNote, LevelChip, SettingsSectionSource, SettingRow, SettingsConfirmPrompt, SettingsSectionGuard, useSettingsReadOnly, SettingsReadNotice, viewReady, TimingNotes, accessForValue, useSettingsChange, useSettingsCloudAgents, useSettingsDraft, useSettingsSection, useSettingsView, type SettingsStatusState } from '../components/SettingsRows.js';
import { hermesSetting, rowValue, settingAsNumber, settingAsText } from '../settingsModel.js';

/**
 * Settings → Agents: how Hermes behaves in chat, which Paseo agents may be
 * started at all, what Paseo hands each agent it launches, and how far Hermes
 * may send its own work. Every row shows who may change it and when a change
 * takes effect; absent limits need explicit values before a paired save.
 */

const EFFORT_LABEL: Record<string, string> = {
  '': 'Hermes decides',
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};

/** Only known personality names are offered; an unknown name has no effect in Hermes. */
export const KNOWN_PERSONALITIES = HERMES_PERSONALITIES;

const PROVIDER_AGENT: Record<(typeof PASEO_AGENT_PROVIDERS)[number], { label: string; help: string; source: string }> = {
  claude: { label: 'Claude Code', help: 'Anthropic\u2019s coding agent.', source: 'https://www.anthropic.com/claude' },
  codex: { label: 'Codex', help: 'OpenAI\u2019s coding agent.', source: 'https://openai.com/codex' },
  opencode: { label: 'OpenCode', help: 'An open-source coding agent.', source: 'https://opencode.ai' },
  copilot: { label: 'Copilot', help: 'GitHub\u2019s coding agent.', source: 'https://github.com/features/copilot' },
  hermes: { label: 'Hermes in Paseo', help: 'Hermes as a Paseo agent.', source: 'https://github.com/vankoala/wayroost#readme' },
};

const CLOUD_STATE: Record<CloudAgent['state'], string> = {
  ready: 'Ready',
  off: 'Switched off',
  unavailable: 'Cannot run right now',
  loading: 'Checking\u2026',
  error: 'Error',
};

/** A timing from the operation catalogue, for display. Rows never invent one. */
export function opTiming(operation: keyof typeof SETTINGS_OPERATIONS): Timing {
  const rule = SETTINGS_OPERATIONS[operation].timing;
  if (Array.isArray(rule)) return rule;
  return [{ label: 'now' }];
}

function opTitle(operation: string): string {
  return Object.hasOwn(SETTINGS_OPERATIONS, operation) ? SETTINGS_OPERATIONS[operation as keyof typeof SETTINGS_OPERATIONS].title : operation;
}

function HermesBehaviour() {
  const readOnly = useSettingsReadOnly();
  const section = useSettingsSection('agents');
  const managed = useSettingsSection('safety');
  const payload = useSettingsView(section, 'hermes.agents');
  const limitsPayload = useSettingsView(section, 'hermes.models');
  const change = useSettingsChange(section.payload);
  const ready = !readOnly && section.status === 'ready' && viewReady(section.payload, 'hermes.agents');
  const limitsReady = !readOnly && section.status === 'ready' && viewReady(section.payload, 'hermes.models');
  if (!payload) return <SettingsReadNotice state={section} view="hermes.agents" />;
  const managedPayload = managed.status === 'ready' ? managed.payload : undefined;
  const effortSetting = hermesSetting(payload, 'hermes.agents', 'agent.reasoning_effort', managedPayload);
  const personalitySetting = hermesSetting(payload, 'hermes.agents', 'display.personality', managedPayload);
  const effort = settingAsText(effortSetting.value, '');
  const personality = settingAsText(personalitySetting.value, '');
  const effortAccess = effortSetting.pinned || effortSetting.unavailable ? 'read-only' : accessForValue(payload, 'hermes.reasoning-effort', effort);
  const personalityAccess = personalitySetting.pinned || personalitySetting.overlayUnavailable ? 'read-only' : accessForValue(payload, 'hermes.personality', personality);
  const personalityHidden = personalitySetting.value.kind === 'hidden';
  const names = payload.personalities ?? KNOWN_PERSONALITIES.map(name => ({ id: name, label: name || 'Default (none)' }));

  return (
    <>
      <SettingsReadNotice state={section} view="hermes.agents" />
      <SettingsReadNotice state={section} view="hermes.models" />
      <SettingsReadNotice state={managed} view="hermes.managed" />
      <div className="group-title">Hermes behaviour</div>
      <div className="group agents-behaviour">
        <SettingRow
          icon={<Gauge size={18} />}
          title="Reasoning effort"
          help="How much Hermes thinks before it answers. The effort it can offer depends on the model."
          level="anywhere"
          timing={opTiming('hermes.reasoning-effort')}
        >
          {effortAccess === 'read-only' ? (
            <span className="muted">{effortSetting.pinned && 'Pinned by the install. '}{effortSetting.unavailable ? 'The effective value is unavailable. Read-only here.' : EFFORT_LABEL[effort] ?? effort}</span>
          ) : (
            <select
              aria-label="Reasoning effort"
              disabled={!ready || change.busy !== null}
              value={REASONING_EFFORTS.includes(effort as (typeof REASONING_EFFORTS)[number]) ? effort : ''}
              onChange={(event) => {
                const next = event.target.value;
                if (next === effort) return;
                void change.run('reasoning', { operation: 'hermes.reasoning-effort', params: { effort: next } }, 'hermes.agents');
              }}
            >
              {REASONING_EFFORTS.map((value) => <option key={value || 'default'} value={value}>{EFFORT_LABEL[value] ?? value}</option>)}
            </select>
          )}
        </SettingRow>
        <SettingRow
          icon={<UserRound size={18} />}
          title="Personality"
          help="A named overlay Hermes speaks with. Only known names do anything; persona text is a later release."
          level="anywhere"
          timing={opTiming('hermes.personality')}
        >
          {personalityHidden && !personalitySetting.pinned && <HiddenNote />}
          {personalityAccess === 'read-only' ? (
            <span className="muted">{personalitySetting.pinned && 'Pinned by the install. '}{personalitySetting.unavailable ? 'The effective value is unavailable. Read-only here.' : personality || 'Default'}</span>
          ) : (
            <select
              aria-label="Personality"
              disabled={!ready || change.busy !== null}
              value={personalityHidden ? '__hidden__' : personality}
              onChange={(event) => {
                const next = event.target.value;
                if (!personalityHidden && next === personality) return;
                void change.run('personality', { operation: 'hermes.personality', params: { personality: next } }, 'hermes.agents');
              }}
            >
              {personalityHidden && <option value="__hidden__" disabled>Current choice shown on the PC</option>}
              {!personalityHidden && personality && !names.some(name => name.id === personality) && <option value={personality} disabled>Unknown: {personality}</option>}
              {names.map((name) => <option key={name.id || 'default'} value={name.id}>{name.label}</option>)}
            </select>
          )}
        </SettingRow>
        <DelegationLimits payload={limitsPayload} managedPayload={managedPayload} change={change} disabled={!limitsReady} />
      </div>
      <SettingsConfirmPrompt pending={change.pending} busy={change.busy !== null} disabled={!limitsReady} onConfirm={() => void change.confirmNow()} onCancel={change.dismiss} />
    </>
  );
}

function DelegationLimits({ payload, managedPayload, change, disabled }: { payload: ReturnType<typeof useSettingsSection>['payload']; managedPayload: ReturnType<typeof useSettingsSection>['payload']; change: ReturnType<typeof useSettingsChange>; disabled: boolean }) {
  const childrenSetting = hermesSetting(payload, 'hermes.models', 'delegation.max_concurrent_children', managedPayload);
  const iterationsSetting = hermesSetting(payload, 'hermes.models', 'delegation.max_iterations', managedPayload);
  const pinned = childrenSetting.pinned || iterationsSetting.pinned;
  const unavailable = childrenSetting.unavailable || iterationsSetting.unavailable;
  const children = settingAsNumber(childrenSetting.value);
  const iterations = settingAsNumber(iterationsSetting.value);
  const [maxChildren, setMaxChildren] = useSettingsDraft(children === null ? '' : String(children));
  const [maxIterations, setMaxIterations] = useSettingsDraft(iterations === null ? '' : String(iterations));
  const access = !pinned && !unavailable && viewReady(payload, 'hermes.models') ? accessForValue(payload, 'hermes.delegation-limits', 'any') : 'read-only';
  const numeric = (text: string) => /^\d+$/.test(text.trim()) && Number.isSafeInteger(Number(text)) && Number(text) >= 1;
  return (
    <SettingRow
      icon={<MessagesSquare size={18} />}
      title="Delegation limits"
      help="How many chats Hermes may run at once on someone else's task, and how many steps each may take."
      level="confirm"
      timing={opTiming('hermes.delegation-limits')}
    >
      {access === 'read-only' ? (
        <span className="muted">{pinned && 'Pinned by the install. '}{unavailable ? 'The effective value is unavailable. Read-only here.' : `${children ?? 'Hermes default'} at a time · ${iterations ?? 'Hermes default'} steps`}</span>
      ) : (
        <div className="setting-inline">
          <label className="field field-tight">
            <span>At once</span>
            <input aria-label="Delegated chats at once" value={maxChildren} onChange={(event) => setMaxChildren(event.target.value)} inputMode="numeric" placeholder="Hermes default" disabled={disabled || change.busy !== null} />
          </label>
          <label className="field field-tight">
            <span>Steps</span>
            <input aria-label="Steps per delegated chat" value={maxIterations} onChange={(event) => setMaxIterations(event.target.value)} inputMode="numeric" placeholder="Hermes default" disabled={disabled || change.busy !== null} />
          </label>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={disabled || change.busy !== null || !numeric(maxChildren) || !numeric(maxIterations)}
            onClick={() => void change.run('delegation-limits', {
              operation: 'hermes.delegation-limits',
              params: { maxConcurrentChildren: Number(maxChildren), maxIterations: Number(maxIterations) },
            }, 'hermes.models')}
          >
            {change.busy === 'delegation-limits' ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />} Save
          </button>
          {(children === null || iterations === null) && <small className="muted">A missing limit uses Hermes' default. Enter both limits explicitly to save.</small>}
        </div>
      )}
    </SettingRow>
  );
}

function PaseoAgents({ availability }: { availability: SettingsStatusState<CloudAgentsStatus> }) {
  const readOnly = useSettingsReadOnly();
  const section = useSettingsSection('agents');
  const { payload } = section;
  const change = useSettingsChange(payload);
  const agents = availability.status === 'ready' && !availability.refreshing ? availability.value?.agents : undefined;
  const readFailed = availability.status === 'error';
  if (!payload) return <SettingsReadNotice state={section} />;

  const legacy = payload.operations?.find(info => info.operation === 'paseo.provider-enabled')?.writer === 'legacy';
  if (!legacy && !viewReady(payload, 'paseo.agents')) return <SettingsReadNotice state={section} view="paseo.agents" />;
  const enabledState = (provider: string) => rowValue(payload, 'paseo.agents', `agents.providers.${provider}.enabled`);
  return (
    <>
      <SettingsReadNotice state={section} />
      <div className="group-title">Paseo agents</div>
      <div className="group agents-paseo">
        {readFailed && <div className="kv"><div className="grow muted">Paseo status unavailable.</div></div>}
        {PASEO_AGENT_PROVIDERS.map((provider) => {
          const agent = PROVIDER_AGENT[provider];
          const value = enabledState(provider);
          const enabled = legacy ? agents?.find(entry => entry.id === provider)?.enabled ?? null
            : value.kind === 'value' ? value.value === true : value.kind === 'absent' ? true : null;
          const access = accessForValue(payload, 'paseo.provider-enabled', 'any');
          const cloud = agents?.find((entry) => entry.id === provider);
          const installed = payload.agentAvailability?.find(entry => entry.id === provider)?.installed;
          return (
            <SettingRow
              key={provider}
              icon={installed === false ? <CloudOff size={18} /> : <Bot size={18} />}
              title={agent.label}
              help={
                installed === false
                  ? <>Not installed. <a href={agent.source} target="_blank" rel="noreferrer">Official source</a></>
                  : cloud ? `${CLOUD_STATE[cloud.state]}. Installation and sign-in status are not reported.${cloud.detail ? ` · ${cloud.detail}` : ''}` : readFailed ? 'Paseo status unavailable.' : agents ? 'Paseo availability unknown.' : 'Checking Paseo status…'
              }
              level={legacy ? 'pc-only' : 'confirm'}
              timing={opTiming('paseo.provider-enabled')}
            >
              {access === 'read-only' || enabled === null ? (
                <span className="muted">{enabled === null ? 'Unknown' : enabled ? 'On' : 'Off'}</span>
              ) : (
                <button
                  type="button"
                  role="switch"
                  className="switch"
                  aria-checked={enabled}
                  aria-label={agent.label}
                  disabled={readOnly || change.busy !== null}
                  onClick={() => void change.run(`provider-${provider}`, {
                    operation: 'paseo.provider-enabled',
                    params: { provider, enabled: !enabled },
                  }, 'paseo.agents')}
                />
              )}
            </SettingRow>
          );
        })}
        <div className="kv">
          <Info size={18} />
          <div className="grow muted">
            Switching an agent off turns it off in Paseo itself: nobody can start it, its own app included. Agents already running keep running.
          </div>
        </div>
      </div>
      <SettingsConfirmPrompt pending={change.pending} busy={change.busy !== null} disabled={readOnly} onConfirm={() => void change.confirmNow()} onCancel={change.dismiss} />
    </>
  );
}

function PaseoProfilesAndNote() {
  const readOnly = useSettingsReadOnly();
  const section = useSettingsSection('agents');
  const payload = useSettingsView(section, 'paseo.agents');
  const change = useSettingsChange(section.payload);
  const disabled = readOnly || section.status !== 'ready' || !viewReady(section.payload, 'paseo.agents');
  if (!payload) return <SettingsReadNotice state={section} view="paseo.agents" />;
  const entries = payload.views?.find(view => view.view === 'paseo.agents')?.values ?? [];
  const profiles = payload.profiles ?? entries.filter(entry => entry.path[0] === 'daemon' && entry.path[1] === 'agentProfiles' && entry.path[3] === 'id' && entry.exists && typeof entry.value === 'string')
    .map(entry => ({ id: String(entry.value), label: String(entry.value), model: entries.find(sibling => sibling.path[0] === 'daemon' && sibling.path[1] === 'agentProfiles' && sibling.path[2] === entry.path[2] && sibling.path[3] === 'model')?.value }));
  const note = rowValue(payload, 'paseo.agents', 'daemon.appendSystemPrompt');
  const noteAccess = accessForValue(payload, 'paseo.routing-note', 'any');
  return (
    <>
      <SettingsReadNotice state={section} view="paseo.agents" />
      <div className="group-title">Profiles and the routing note</div>
      <div className="group agents-profiles">
        {profiles.length === 0 && (
          <div className="kv">
            <SlidersHorizontal size={18} />
            <div className="grow">
              <div>Profiles</div>
              <div className="muted">No profile is saved in Paseo&rsquo;s settings, so agents start on the defaults.</div>
            </div>
          </div>
        )}
        {profiles.map((entry) => {
          const id = entry.id;
          const model = entry.model;
          const named = typeof model === 'string';
          const access = accessForValue(payload, 'paseo.profile-model', 'any');
          return (
            <SettingRow
              key={id}
              icon={<SlidersHorizontal size={18} />}
              title={`Profile ${entry.label}`}
              help="The model this profile starts on. Names the profiles show on the PC."
              level="confirm"
              timing={opTiming('paseo.profile-model')}
            >
              {access === 'read-only' ? (
                <span className="muted">{named ? model : 'Shown on the PC'}</span>
              ) : (
                <ProfileModelEditor profile={id} model={named ? model : ''} change={change} disabled={disabled} />
              )}
            </SettingRow>
          );
        })}
        <SettingRow
          icon={<Route size={18} />}
          title="Routing note"
          help="A note Paseo appends when it builds every new agent's launch."
          level="pc-only"
          timing={opTiming('paseo.routing-note')}
        >
          {note.kind === 'hidden' ? <HiddenNote /> : null}
          {noteAccess === 'read-only' ? (
            <span className="muted">{note.kind === 'value' && note.value ? 'Saved' : note.kind === 'absent' ? 'None' : ''}</span>
          ) : (
            <RoutingNote note={note.kind === 'value' && typeof note.value === 'string' ? note.value : ''} change={change} disabled={disabled} />
          )}
        </SettingRow>
      </div>
      <SettingsConfirmPrompt pending={change.pending} busy={change.busy !== null} disabled={disabled} onConfirm={() => void change.confirmNow()} onCancel={change.dismiss} />
    </>
  );
}

function ProfileModelEditor({ profile, model, change, disabled }: { profile: string; model: string; change: ReturnType<typeof useSettingsChange>; disabled: boolean }) {
  const [next, setNext] = useSettingsDraft(model);
  const valid = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[^\s]+$/.test(next.trim());
  return (
    <div className="setting-inline">
      <input aria-label={`Model for profile ${profile}`} value={next} onChange={(event) => setNext(event.target.value)} disabled={disabled || change.busy !== null} />
      <button
        type="button"
        className="btn btn-secondary"
        aria-label={`Save profile ${profile}`}
        disabled={disabled || change.busy !== null || !valid || next === model}
        onClick={() => void change.run(`profile-${profile}`, { operation: 'paseo.profile-model', params: { profile, model: next.trim() } }, 'paseo.agents')}
      >
        {change.busy === `profile-${profile}` ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />} Save
      </button>
    </div>
  );
}

function RoutingNote({ note, change, disabled }: { note: string; change: ReturnType<typeof useSettingsChange>; disabled: boolean }) {
  const [text, setText] = useSettingsDraft(note);
  const dirty = text !== note;
  return (
    <div className="setting-stack">
      <textarea aria-label="Routing note" rows={3} value={text} onChange={(event) => setText(event.target.value)} disabled={disabled || change.busy !== null} />
      <div>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={disabled || change.busy !== null || !dirty}
          onClick={() => void change.run('routing-note', { operation: 'paseo.routing-note', params: { text } }, 'paseo.agents')}
        >
          {change.busy === 'routing-note' ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />} Save
        </button>
      </div>
    </div>
  );
}

/** Read-only: what a pack build records per role, against the budget. Nothing here is editable. */
function RoleLoads() {
  const section = useSettingsSection('agents');
  if (section.status !== 'ready') return <SettingsReadNotice state={section} />;
  const loads = section.payload?.roleLoads;
  return <>
    <div className="group-title">What each role loads</div>
    <div className="group agents-role-loads">
      {loads?.length ? loads.map(load => <div className="kv" key={`${load.role}-${load.harness}`}>
        <BookOpenText size={18} /><div className="grow">
          <div>{load.role} · {load.harness}</div>
          <div className="muted">{load.words} words · {load.tokens} estimated tokens · target {load.targetWords ?? 'unavailable'} · budget {load.budgetWords ?? 'unavailable'}</div>
          <div className="muted">Shared rules {load.parts.shared} · dispatch {load.parts.dispatch} · role {load.parts.role} · skills {load.parts.skills} words</div>
          <div className="muted">{load.budgetWords !== null && load.words > load.budgetWords ? 'Over budget' : load.targetWords !== null && load.words > load.targetWords ? 'Above target' : 'Within reported limits'}</div>
        </div>
      </div>) : <div className="kv"><BookOpenText size={18} /><div className="grow muted">Role-load measurements unavailable. This PC has not reported its pack measurements or budgets.</div><button type="button" className="btn btn-secondary" onClick={section.reload}>Retry</button></div>}
    </div>
  </>;
}

/** Settings → Agents. */
export function AgentsSettingsPage() {
  const availability = useSettingsCloudAgents();
  return (
    <Page className="page-agents-settings" title="Agents">
      <p className="page-lead">
        How the agents on this PC behave: how Hermes speaks and delegates, which Paseo agents may run,
        and what Paseo hands each agent it starts.
      </p>
      <SettingsSectionSource section="agents">
        <SettingsSectionSource section="safety">
          <SettingsSectionGuard section="agents" views={['hermes.agents', 'hermes.models']} dependency={{ section: 'safety', views: ['hermes.managed'] }}><HermesBehaviour /></SettingsSectionGuard>
          <SettingsSectionGuard section="agents" views={['paseo.agents']} reads={[availability]} legacyOperation="paseo.provider-enabled"><PaseoAgents availability={availability} /></SettingsSectionGuard>
          <SettingsSectionGuard section="agents" views={['paseo.agents']}><PaseoProfilesAndNote /></SettingsSectionGuard>
          <RoleLoads />
        </SettingsSectionSource>
      </SettingsSectionSource>
    </Page>
  );
}

export { opTitle };
