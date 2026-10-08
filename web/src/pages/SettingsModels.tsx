import { SettingsRestart } from '../components/SettingsRestart.js';
import { Activity, CreditCard, Gauge, Info, KeyRound, LoaderCircle, Route, Save, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CloudAgentsStatus } from '../../../shared/protocol.js';
import { GATEWAY_ROLES } from '../../../shared/gateway.js';
import { HERMES_HELPER_TASKS, parseOperation } from '../../../shared/settings-ops.js';
import { formatKeyPath, type SettingValue } from '../../../shared/settings.js';
import { usageSummaryResultSchema, type UsageSummaryResult } from '../../../shared/supervisor-config.js';
import { api } from '../api.js';
import { Page } from '../components/common.js';
import { HiddenNote, LevelChip, SettingsSectionSource, SettingRow, SettingsConfirmPrompt, SettingsSectionGuard, useSettingsReadOnly, SettingsReadNotice, viewReady, TimingNotes, accessForValue, useSettingsChange, useSettingsCloudAgents, useSettingsDraft, useSettingsSection, useSettingsStatus, useSettingsView, type SettingsStatusState } from '../components/SettingsRows.js';
import { formatCount, formatUsd, hermesSetting, isOpaqueName, rowNames, rowValue, settingAsText, settingsErrorText, type SettingsUsagePayload } from '../settingsModel.js';
import { captureRollout, getRolloutGeneration, useStore } from '../store.js';
import { opTiming } from './SettingsAgents.js';

/**
 * Settings → Models & accounts: which backend serves each model role right
 * now, what Hermes runs on by default and on delegation, the keys that go to
 * the gateway, what the cloud sign-ins can do, and what all of it has used.
 * A manual role change lasts until the next model switch; the stack launcher
 * puts every role back on its profile row when the profile changes.
 */

const ROLE_HELP: Record<string, string> = {
  main: 'Chats and the default everything follows.',
  coder: 'The coding back end behind the coder role.',
  fast: 'The quick back end for helper work and delegation overflow.',
};

/** The result of a credential test, in words. The key itself is never shown. */
export const CREDENTIAL_TEST_TEXT: Record<string, string> = {
  credential_missing: 'No key is stored for this provider on this PC.',
  credential_rejected: 'The provider refused the stored key.',
  backend_unavailable: 'The backend did not answer.',
  test_failed: 'The test request failed.',
};

function backendField(payload: Parameters<typeof rowValue>[0], backend: string | undefined, field: string) {
  return backend ? rowValue(payload, 'gateway.role-map', formatKeyPath(['backends', backend, field])) : { kind: 'no-data' as const };
}

function contractLine(payload: Parameters<typeof rowValue>[0], role: string): string {
  const input = rowValue(payload, 'gateway.role-map', `contracts.${role}.input`);
  const tools = rowValue(payload, 'gateway.role-map', `contracts.${role}.toolCalling`);
  const thinking = rowValue(payload, 'gateway.role-map', `contracts.${role}.thinkingLevels`);
  const output = rowValue(payload, 'gateway.role-map', `contracts.${role}.maxOutputTokens`);
  const context = rowValue(payload, 'gateway.role-map', `contracts.${role}.advertisedContext`);
  const yesNo = (value: ReturnType<typeof rowValue>) => (value.kind === 'value' ? (value.value ? 'yes' : 'no') : '?');
  const inputs = input.kind === 'value' && Array.isArray(input.value) ? input.value.join(' + ') : '?';
  return `Contract: ${inputs} input · tool calling ${yesNo(tools)} · thinking levels ${yesNo(thinking)} · output up to ${output.kind === 'value' ? formatCount(Number(output.value)) : '?'} · advertised ${context.kind === 'value' ? formatCount(Number(context.value)) : '?'} tokens.`;
}

function RolesSection() {
  const readOnly = useSettingsReadOnly();
  const section = useSettingsSection('models');
  const payload = useSettingsView(section, 'gateway.role-map');
  const change = useSettingsChange(section.payload);
  const ready = !readOnly && section.status === 'ready' && viewReady(section.payload, 'gateway.role-map');
  if (!payload) return <SettingsReadNotice state={section} view="gateway.role-map" />;
  const backends = payload.backendChoices ?? rowNames(payload, 'gateway.role-map', 'backends').filter(name => !isOpaqueName(name)).map(id => ({ id, label: id, currentRoles: [] as string[] }));
  const projectedNames = (payload.views?.find(view => view.view === 'gateway.role-map')?.values ?? [])
    .flatMap(entry => entry.path[0] === 'backends' && typeof entry.path[1] === 'string' ? [entry.path[1]] : []);

  return (
    <>
      <SettingsReadNotice state={section} view="gateway.role-map" />
      <div className="group-title">Model roles</div>
      <div className="group models-roles">
        {GATEWAY_ROLES.map((role) => {
          const served = rowValue(payload, 'gateway.role-map', `roles.${role}`);
          const backend = served.kind === 'value' && typeof served.value === 'string' ? served.value : undefined;
          const current = backend ?? backends.find(entry => entry.currentRoles.includes(role))?.id;
          const projectedBackend = backend ?? (served.kind === 'hidden' && current
            ? projectedNames.find(name => isOpaqueName(name) && name.startsWith(`sha256:${current}`))
            : undefined);
          const servedName = backendField(payload, backend, 'servedName');
          const context = backendField(payload, projectedBackend, 'contextLength');
          const unmapped = served.kind === 'absent' || backend === undefined;
          const override = rowValue(payload, 'gateway.state', `state.overrides.${role}.backend`);
          const access = accessForValue(payload, 'gateway.point', 'any');
          const canPoint = access !== 'read-only';
          const live = payload.modelStatus?.find(entry => entry.role === role);
          return (
            <div className="kv" key={role}>
              <Route size={18} />
              <div className="grow">
                <div>
                  <code>{role}</code>
                  &nbsp;<LevelChip level="confirm" />
                </div>
                <div className="muted">{ROLE_HELP[role]}</div>
                <div className="muted">
                  {served.kind === 'hidden' ? <HiddenNote text="The serving backend is shown on the PC." />
                    : served.kind === 'no-data' ? null
                    : unmapped ? 'Unmapped: new requests to this role are refused, as from a stopped engine.'
                    : <>Served by <code>{backend}</code>{servedName.kind === 'value' ? <> → {settingAsText(servedName)}</> : null}</>}
                  {context.kind === 'value' ? <> · window {formatCount(Number(context.value))}</> : null}
                </div>
                {override.kind === 'value' && <div className="muted">A manual change is in place: it lasts until the next model switch.</div>}
                <div className="muted">{contractLine(payload, role)}</div>
                <div className="muted">{live ? `Health: ${live.health} · ${live.inFlight} in flight` : 'Health unavailable · in-flight count unavailable'}</div>
                <TimingNotes timing={opTiming('gateway.point')} />
                <div className="muted">A role change here is labelled “until the next model switch”.</div>
              </div>
              {canPoint ? (
                <PointControl role={role} current={current} choices={backends} change={change} busy={change.busy === `point-${role}`} disabled={!ready} />
              ) : null}
            </div>
          );
        })}
      </div>
      <SettingsConfirmPrompt pending={change.pending} busy={change.busy !== null} disabled={!ready} onConfirm={() => void change.confirmNow()} onCancel={change.dismiss} />
    </>
  );
}

function PointControl({ role, current, choices, change, busy, disabled }: {
  role: string;
  current: string | undefined;
  choices: { id: string; label: string }[];
  change: ReturnType<typeof useSettingsChange>;
  busy: boolean;
  disabled: boolean;
}) {
  const [pick, setPick] = useSettingsDraft(current ?? choices[0]?.id ?? '');
  const available = choices.some(entry => entry.id === pick);
  if (!pick && !choices.length) return null;
  return (
    <div className="setting-inline">
      <select aria-label={`Backend for the ${role} role`} value={pick} disabled={busy || disabled} onChange={(event) => setPick(event.target.value)}>
        {!available && <option value={pick} disabled>Selected backend unavailable</option>}
        {choices.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
      </select>
      <button
        type="button"
        className="btn btn-secondary"
        disabled={busy || disabled || !available || pick === current}
        onClick={() => void change.run(`point-${role}`, { operation: 'gateway.point', params: { role, backend: pick } }, 'gateway.role-map')}
      >
        {busy ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}
        <span>Point {role}</span>
      </button>
    </div>
  );
}

/** One model field: provider and model (and an address when it has one). */
function ModelFields({ title, help, level, timing, access, provider, model, baseUrl, fields, operation, change, busyKey, task, pinned = false }: {
  title: string;
  help: string;
  level: 'anywhere' | 'confirm' | 'pc-only';
  access: 'editable' | 'confirm' | 'read-only';
  timing: ReturnType<typeof opTiming>;
  provider: ReturnType<typeof rowValue>;
  model: ReturnType<typeof rowValue>;
  baseUrl?: ReturnType<typeof rowValue>;
  fields: { provider: string; model: string; baseUrl?: string };
  operation: string;
  change: ReturnType<typeof useSettingsChange>;
  busyKey: string;
  task?: string;
  pinned?: boolean;
}) {
  const [draftProvider, setDraftProvider] = useSettingsDraft(fields.provider);
  const [draftModel, setDraftModel] = useSettingsDraft(fields.model);
  const [draftUrl, setDraftUrl] = useSettingsDraft(fields.baseUrl ?? '');
  const draft = { provider: draftProvider, model: draftModel, baseUrl: draftUrl };
  const [touched, setTouched] = useState(false);
  const hidden = [provider, model, baseUrl].some((value) => value?.kind === 'hidden' || value?.kind === 'no-data');
  const disabled = access === 'read-only' || change.busy !== null || [provider, model, baseUrl].some(value => value?.kind === 'no-data');
  const params = { provider: draft.provider.trim(), model: draft.model.trim(), ...(baseUrl !== undefined ? { baseUrl: draft.baseUrl?.trim() } : {}), ...(task ? { task } : {}) };
  const valid = parseOperation(operation, params, 'server').ok;
  const changed = touched && (draft.provider !== fields.provider || draft.model !== fields.model || (draft.baseUrl ?? '') !== (fields.baseUrl ?? ''));
  return (
    <SettingRow title={title} help={help} level={level} timing={timing}>
      <div className="setting-stack">
        {pinned ? <HiddenNote text={hidden ? 'Pinned by the install; the effective value is unavailable. Read-only here.' : 'Pinned by the install. Read-only here.'} />
          : disabled && [provider, model, baseUrl].some(value => value?.kind === 'no-data') ? <HiddenNote text="The effective value is unavailable. Read-only here." />
            : hidden && <HiddenNote />}
        <label className="field field-tight">
          <span>Provider</span>
          <input aria-label={`${title} provider`} value={draft.provider} disabled={disabled} placeholder="shown on the PC"
            onChange={(event) => { setDraftProvider(event.target.value); setTouched(true); }} />
        </label>
        <label className="field field-tight">
          <span>Model</span>
          <input aria-label={`${title} model`} value={draft.model} disabled={disabled} placeholder="shown on the PC"
            onChange={(event) => { setDraftModel(event.target.value); setTouched(true); }} />
        </label>
        {baseUrl !== undefined && (
          <label className="field field-tight">
            <span>Address</span>
            <input aria-label={`${title} address`} value={draft.baseUrl ?? ''} disabled={disabled} placeholder="http://127.0.0.1:…/v1"
              onChange={(event) => { setDraftUrl(event.target.value); setTouched(true); }} />
          </label>
        )}
        <div>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!changed || disabled || !valid}
            onClick={() => void change.run(busyKey, {
              operation,
              params,
            }, 'hermes.models')}
          >
            {change.busy === busyKey ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />} Save
          </button>
        </div>
      </div>
    </SettingRow>
  );
}

/** A fallback chain: list, add, remove, save. */
function ChainEditor({ title, help, level, timing, operation, chain, change, busyKey, ariaLabel, access, pinned = false }: {
  title: string;
  help: string;
  level: 'confirm' | 'anywhere' |'pc-only';
  timing: ReturnType<typeof opTiming>;
  operation: string;
  chain: ReturnType<typeof rowValue>;
  change: ReturnType<typeof useSettingsChange>;
  busyKey: string;
  ariaLabel?: string;
  access: 'editable' | 'confirm' | 'read-only';
  pinned?: boolean;
}) {
  const stored: { provider: string; model: string }[] = chain.kind === 'value' && Array.isArray(chain.value)
    ? (chain.value as SettingValue[]).flatMap((entry) => (entry && typeof entry === 'object' && !Array.isArray(entry)
      ? [{ provider: String((entry as Record<string, unknown>).provider ?? ''), model: String((entry as Record<string, unknown>).model ?? '') }] : []))
    : [];
  const hidden = chain.kind === 'hidden';
  const disabled = access === 'read-only' || change.busy !== null || chain.kind === 'no-data';
  const [draft, setDraft] = useSettingsDraft(stored);
  const [touched, setTouched] = useState(false);
  const dirty = touched && (hidden || JSON.stringify(draft) !== JSON.stringify(stored));
  return (
    <SettingRow title={title} help={help} level={level} timing={timing}>
      <div className="setting-stack">
        {pinned ? <HiddenNote text={hidden ? 'Pinned by the install; the effective value is unavailable. Read-only here.' : 'Pinned by the install. Read-only here.'} />
          : chain.kind === 'no-data' ? <HiddenNote text="The effective value is unavailable. Read-only here." /> : hidden && <HiddenNote />}
        {draft.map((entry, index) => (
          <div className="setting-inline" key={index}>
            <input aria-label={`${title} provider ${index + 1}`} value={entry.provider} disabled={disabled} placeholder="provider"
              onChange={(event) => { setDraft(draft.map((e, i) => (i === index ? { ...e, provider: event.target.value } : e))); setTouched(true); }} />
            <input aria-label={`${title} model ${index + 1}`} value={entry.model} disabled={disabled} placeholder="model"
              onChange={(event) => { setDraft(draft.map((e, i) => (i === index ? { ...e, model: event.target.value } : e))); setTouched(true); }} />
            <button type="button" className="btn btn-secondary" aria-label={`Remove ${title} step ${index + 1}`} disabled={disabled}
              onClick={() => { setDraft(draft.filter((_, i) => i !== index)); setTouched(true); }}>–</button>
          </div>
        ))}
        <div className="setting-inline">
          <button type="button" className="btn btn-secondary" disabled={draft.length >= 8 || disabled}
            onClick={() => { setDraft([...draft, { provider: '', model: '' }]); setTouched(true); }}>Add a step</button>
          <button type="button" className="btn btn-secondary" disabled={!dirty || disabled || draft.some((entry) => !entry.provider || !entry.model)}
            onClick={() => void change.run(busyKey, { operation, params: { chain: draft.map((entry) => ({ provider: entry.provider.trim(), model: entry.model.trim() })) } }, 'hermes.models')}>
            {change.busy === busyKey ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}
            <span>{ariaLabel ?? 'Save'}</span>
          </button>
          {hidden && <button type="button" className="btn btn-secondary" aria-label={`Clear ${title}`} disabled={disabled}
            onClick={() => void change.run(busyKey, { operation, params: { chain: [] } }, 'hermes.models')}>Clear chain</button>}
        </div>
      </div>
    </SettingRow>
  );
}

function HermesModelsSection() {
  const readOnly = useSettingsReadOnly();
  const section = useSettingsSection('models');
  const managed = useSettingsSection('safety');
  const payload = useSettingsView(section, 'hermes.models');
  const change = useSettingsChange(section.payload);
  const ready = !readOnly && section.status === 'ready' && viewReady(section.payload, 'hermes.models');
  if (!payload) return <SettingsReadNotice state={section} view="hermes.models" />;
  const managedPayload = managed.status === 'ready' ? managed.payload : undefined;
  const setting = (key: string) => hermesSetting(payload, 'hermes.models', key, managedPayload);
  const value = (key: string) => setting(key).value;
  const pinned = (keys: string[]) => keys.some(key => setting(key).pinned);
  const access = (operation: string, keys: string[]) => !ready || keys.some(key => setting(key).pinned || setting(key).overlayUnavailable)
    ? 'read-only' : accessForValue(payload, operation, 'any');
  const asFields = (providerKey: string, modelKey: string, baseUrlKey?: string) => ({
    provider: settingAsText(value(providerKey)),
    model: settingAsText(value(modelKey)),
    ...(baseUrlKey ? { baseUrl: settingAsText(value(baseUrlKey)) } : {}),
  });
  return (
    <>
      <SettingsReadNotice state={section} view="hermes.models" />
      <SettingsReadNotice state={managed} view="hermes.managed" />
      <div className="group-title">Models Hermes runs on</div>
      <div className="group models-hermes">
        <ModelFields
          title="Default model" help="What a Hermes chat runs on. Naming a role here is what keeps every consumer following one switch."
          level="confirm" timing={opTiming('hermes.default-model')} access={access('hermes.default-model', ['model.provider', 'model.default', 'model.base_url'])}
          pinned={pinned(['model.provider', 'model.default', 'model.base_url'])}
          provider={value('model.provider')} model={value('model.default')} baseUrl={value('model.base_url')}
          fields={asFields('model.provider', 'model.default', 'model.base_url')}
          operation="hermes.default-model" change={change} busyKey="default-model"
        />
        <ModelFields
          title="Delegation model" help="The model Hermes hands a sub-task to. Reads the file afresh at every delegation."
          level="confirm" timing={opTiming('hermes.delegation-model')} access={access('hermes.delegation-model', ['delegation.provider', 'delegation.model'])}
          pinned={pinned(['delegation.provider', 'delegation.model'])}
          provider={value('delegation.provider')} model={value('delegation.model')}
          fields={asFields('delegation.provider', 'delegation.model')}
          operation="hermes.delegation-model" change={change} busyKey="delegation-model"
        />
        <ChainEditor
          title="Delegation fallbacks" help="When the delegation model has no capacity, this chain is tried in order."
          level="confirm" timing={opTiming('hermes.delegation-fallbacks')}
          access={access('hermes.delegation-fallbacks', ['delegation.fallback_providers'])} pinned={pinned(['delegation.fallback_providers'])} operation="hermes.delegation-fallbacks" chain={value('delegation.fallback_providers')} change={change} busyKey="delegation-fallbacks" ariaLabel="Save chain for Delegation fallbacks"
        />
        <ChainEditor
          title="Main chat fallbacks" help="The main chat has no fallback chain by default; add one only if you want turns to move on."
          level="confirm" timing={opTiming('hermes.main-fallbacks')}
          access={access('hermes.main-fallbacks', ['fallback_providers'])} pinned={pinned(['fallback_providers'])} operation="hermes.main-fallbacks" chain={value('fallback_providers')} change={change} busyKey="main-fallbacks" ariaLabel="Save chain for Main chat fallbacks"
        />
        <div className="kv">
          <Info size={18} />
          <div className="grow muted">
            A helper task that finds no capacity falls back to the main model on its own; that path is Hermes' and is not edited here.
          </div>
        </div>
        <div className="group-title">Helper models</div>
        <div className="group models-helpers">
          {(() => {
            const slots = [...new Set([...rowNames(payload, 'hermes.models', 'auxiliary'), ...rowNames(managedPayload, 'hermes.managed', 'auxiliary')])];
            const known = slots.filter((slot) => (HERMES_HELPER_TASKS as readonly string[]).includes(slot));
            if (!known.length) {
              return <div className="kv"><div className="grow muted">{setting('model.default').overlayUnavailable ? 'Helper slots unavailable.' : 'No helper slot is set; Hermes uses its defaults.'}</div></div>;
            }
            return known.map((task) => (
              <ModelFields
                key={task}
                title={`Helper: ${task.replaceAll('_', ' ')}`} help="One of Hermes' side tasks (compressing, approving, titling…)."
                level="confirm" timing={opTiming('hermes.helper-model')} access={access('hermes.helper-model', [`auxiliary.${task}.provider`, `auxiliary.${task}.model`])}
                pinned={pinned([`auxiliary.${task}.provider`, `auxiliary.${task}.model`])}
                provider={value(`auxiliary.${task}.provider`)} model={value(`auxiliary.${task}.model`)}
                fields={asFields(`auxiliary.${task}.provider`, `auxiliary.${task}.model`)}
                operation="hermes.helper-model" task={task} change={change} busyKey={`helper-${task}`}
              />
            ));
          })()}
          <div className="kv">
            <Sparkles size={18} />
            <div className="grow muted">A helper slot points at a role or a direct provider; capacity errors still fall back to the main model.</div>
            <HelperAdd change={change} access={ready ? accessForValue(payload, 'hermes.helper-model', 'any') : 'read-only'}
              overlayUnavailable={setting('model.default').overlayUnavailable}
              pinnedTask={task => pinned([`auxiliary.${task}.provider`, `auxiliary.${task}.model`])} />
          </div>
        </div>
      </div>
      <SettingsConfirmPrompt pending={change.pending} busy={change.busy !== null} disabled={!ready} onConfirm={() => void change.confirmNow()} onCancel={change.dismiss} />
    </>
  );
}

function HelperAdd({ change, access, overlayUnavailable, pinnedTask }: { change: ReturnType<typeof useSettingsChange>; access: 'editable' | 'confirm' | 'read-only'; overlayUnavailable: boolean; pinnedTask: (task: string) => boolean }) {
  const [task, setTask] = useState<string>(HERMES_HELPER_TASKS[0]);
  const disabled = access === 'read-only' || change.busy !== null || overlayUnavailable;
  const pinned = pinnedTask(task);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  return (
    <div className="setting-inline">
      <select aria-label="Helper task to set" value={task} disabled={disabled} onChange={(event) => setTask(event.target.value)}>
        {HERMES_HELPER_TASKS.map((entry) => <option key={entry} value={entry}>{entry.replaceAll('_', ' ')}</option>)}
      </select>
      {pinned ? <HiddenNote text="Pinned by the install; the effective value is unavailable. Read-only here." />
        : overlayUnavailable && <HiddenNote text="The effective value is unavailable. Read-only here." />}
      <input aria-label="Helper provider" value={provider} placeholder="provider" disabled={disabled || pinned} onChange={(event) => setProvider(event.target.value)} />
      <input aria-label="Helper model" value={model} placeholder="model" disabled={disabled || pinned} onChange={(event) => setModel(event.target.value)} />
      <button
        type="button"
        className="btn btn-secondary"
        disabled={disabled || pinned || !provider.trim() || !model.trim()}
        onClick={() => void change.run(`helper-add-${task}`, { operation: 'hermes.helper-model', params: { task, provider: provider.trim(), model: model.trim() } }, 'hermes.models', () => { setProvider(''); setModel(''); })}
      >Set helper</button>
    </div>
  );
}

/** The gateway's API keys. PC only, and the field never echoes a key back. */
function ApiKeys() {
  const readOnly = useSettingsReadOnly();
  const section = useSettingsSection('models');
  const payload = useSettingsView(section, 'gateway.role-map');
  const ready = !readOnly && section.status === 'ready' && viewReady(section.payload, 'gateway.role-map');
  const [secrets, setSecrets] = useState(() => new Map<string, string>());
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const rolloutGeneration = useStore(() => getRolloutGeneration('settingsPages'));
  useEffect(() => { setReport(null); setRestartRequired(false); setBusy(null); }, [rolloutGeneration]);
  if (!payload) return <SettingsReadNotice state={section} view="gateway.role-map" />;
  const map = payload.views?.find((view) => view.view === 'gateway.role-map');
  const backends = map?.values ?? [];
  // A phone reads the role map digested: the provider names arrive as hashes, so the key rows can only point at the PC.
  const keysHidden = accessForValue(payload, 'gateway.credential', 'any') === 'read-only';
  const credentials = new Map<string, string[]>();
  for (const entry of backends) {
    if (entry.path.length === 3 && entry.path[2] === 'provider' && entry.exists && typeof entry.value === 'string' && !isOpaqueName(entry.value)) {
      const backend = String(entry.path[1]);
      credentials.set(entry.value, [...(credentials.get(entry.value) ?? []), backend]);
    }
  }
  const access = accessForValue(payload, 'gateway.credential', 'any');
  const editable = access !== 'read-only';

  const act = async (kind: 'set' | 'remove' | 'test', provider: string, backend?: string) => {
    const rollout = captureRollout('settingsPages');
    if (!rollout.still() || !ready) return;
    setBusy(`${kind}-${provider}`);
    setReport(null);
    try {
      if (kind === 'set') {
        const answer = await api.settingsCredentialSet(provider, secrets.get(provider) ?? '');
        if (!rollout.still()) return;
        setReport(answer.status === 'applied' ? `Saved for ${provider}. The field stays empty: the key is never shown back. Restart required: the model gateway. No restart has been scheduled.` : settingsErrorText(answer.code));
        if (answer.status === 'applied') { setSecrets(current => new Map(current).set(provider, '')); setRestartRequired(true); }
      } else if (kind === 'remove') {
        const answer = await api.settingsCredentialRemove(provider);
        if (!rollout.still()) return;
        if (answer.status === 'applied') setRestartRequired(true);
        setReport(answer.status === 'applied' ? `Removed the key for ${provider}. Restart required: the model gateway. No restart has been scheduled.` : settingsErrorText(answer.code));
      } else {
        const answer = await api.settingsCredentialTest(provider, backend ?? '');
        if (!rollout.still()) return;
        setReport(answer.test
          ? answer.test.ok ? `The key worked for ${provider}.` : (CREDENTIAL_TEST_TEXT[answer.test.code] ?? 'The test failed.')
          : 'The test could not run.');
      }
    } catch (error) {
      if (rollout.still()) setReport(error instanceof Error ? error.message : 'This PC did not answer.');
    } finally {
      if (rollout.still()) setBusy(null);
    }
  };

  return (
    <>
      <SettingsReadNotice state={section} view="gateway.role-map" />
      <div className="group-title">API keys for the gateway</div>
      <div className="group models-keys">
        {credentials.size === 0 && <div className="kv"><div className="grow muted">{keysHidden ? 'The keys and the backends that need them are shown on the PC.' : 'No backend in the role map asks for a key.'}</div></div>}
        {[...credentials.entries()].map(([provider, backendIds]) => (
          <SettingRow
            key={provider}
            icon={<KeyRound size={18} />}
            title={`Key: ${provider}`}
            help="The key goes to the model gateway only, never to Hermes' providers or pi's catalog."
            level="pc-only"
            timing={opTiming('gateway.credential')}
          >
            {!editable ? (
              <span className="muted">Manage keys on the PC.</span>
            ) : (
              <div className="setting-stack">
                <label className="field field-tight">
                  <span>New key</span>
                  <input type="password" aria-label={`Key for ${provider}`} value={secrets.get(provider) ?? ''} autoComplete="off"
                    onChange={(event) => setSecrets(new Map(secrets).set(provider, event.target.value))} disabled={!ready || busy !== null} />
                </label>
                <div className="setting-inline">
                  <button type="button" className="btn btn-secondary" aria-label={`Save key for ${provider}`} disabled={!ready || busy !== null || !(secrets.get(provider) ?? '').trim()}
                    onClick={() => void act('set', provider)}>
                    {busy === `set-${provider}` ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />} Save
                  </button>
                  <button type="button" className="btn btn-secondary" disabled={!ready || busy !== null}
                    onClick={() => void act('remove', provider)}>Remove</button>
                  <button type="button" className="btn btn-secondary" disabled={!ready || busy !== null || backendIds.length === 0}
                    onClick={() => void act('test', provider, backendIds[0])}>
                    {busy === `test-${provider}` ? <LoaderCircle size={16} className="spin" /> : <Gauge size={16} />} Test
                  </button>
                </div>
              </div>
            )}
          </SettingRow>
        ))}
        {restartRequired && <div className="kv"><div className="grow"><SettingsRestart component="gateway" disabled={!ready} /></div></div>}
        {report && <div className="kv"><div className="grow muted">{report}</div></div>}
        <div className="kv">
          <Info size={18} />
          <div className="grow muted">
            Saved key changes require a model gateway restart. Saving a key does not schedule that restart.
          </div>
        </div>
      </div>
    </>
  );
}

const SUBSCRIPTION_AGENTS = [
  { id: 'claude', label: 'Claude Code', help: 'Anthropic\u2019s agent', source: 'https://www.anthropic.com/claude' },
  { id: 'codex', label: 'Codex', help: 'OpenAI\u2019s agent', source: 'https://openai.com/codex' },
  { id: 'copilot', label: 'Copilot', help: 'GitHub\u2019s agent', source: 'https://github.com/features/copilot' },
];

function Subscriptions({ availability }: { availability: SettingsStatusState<CloudAgentsStatus> }) {
  const section = useSettingsSection('models');
  const agents = availability.status === 'ready' && !availability.refreshing ? availability.value?.agents : undefined;
  const failed = availability.status === 'error';
  return <>
    <div className="group-title">Subscriptions</div>
    <div className="group models-subscriptions">
      {failed && <div className="kv"><div className="grow muted">Paseo status unavailable.</div></div>}
      {SUBSCRIPTION_AGENTS.map(agent => {
        const metadata = section.payload?.agentAvailability?.find(entry => entry.id === agent.id);
        const cloud = agents?.find(entry => entry.id === agent.id);
        const installed = metadata?.installed === false ? 'Not installed' : metadata?.installed === true ? 'Installed' : 'Installation unknown';
        const auth = metadata?.authenticated === true ? 'Signed in' : metadata?.authenticated === false ? 'Signed out' : 'Sign-in status unknown';
        const ready = cloud ? cloud.state === 'ready' ? 'Available to run' : cloud.state === 'off' ? 'Switched off' : 'Unavailable to run' : failed ? 'Availability unavailable' : agents ? 'Availability unknown' : 'Checking availability…';
        return <div className="kv" key={agent.id}><CreditCard size={18} /><div className="grow">
          <div>{agent.label} · {installed} · {auth}</div><div className="muted">{ready}</div>
          <div className="muted">Signing in opens the official flow in a terminal on this PC. <a href={agent.source} target="_blank" rel="noreferrer">{agent.help}</a></div>
        </div></div>;
      })}
    </div>
  </>;
}

function isSettingsUsage(value: unknown): value is SettingsUsagePayload {
  const result = usageSummaryResultSchema.safeParse(value);
  return result.success && result.data.ok;
}

function usageLines(answer: Extract<UsageSummaryResult, { ok: true }>) {
  const today = answer.windows.find((window) => window.id === 'today')?.rows ?? [];
  const week = answer.windows.find((window) => window.id === 'week')?.rows ?? [];
  const line = (rows: typeof today) => rows.reduce((sum, row) => ({
    requests: sum.requests + row.requests,
    tokens: sum.tokens + row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens + row.outputTokens,
    cost: sum.cost + row.estimatedCostUsd,
  }), { requests: 0, tokens: 0, cost: 0 });
  const byRole = new Map<string, { role: string; backend?: string; backendModel?: string; today: ReturnType<typeof line>; week: ReturnType<typeof line> }>();
  const add = (windowId: 'today' | 'week', rows: typeof today) => {
    for (const row of rows) {
      for (const id of [row.role, JSON.stringify([row.role, row.backend, row.backendModel])]) {
        const currentEntry = byRole.get(id) ?? { role: row.role, ...(id !== row.role ? { backend: row.backend ?? 'Unmapped', backendModel: row.backendModel } : {}), today: line([]), week: line([]) };
        currentEntry[windowId] = { requests: currentEntry[windowId].requests + row.requests, tokens: currentEntry[windowId].tokens + row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens + row.outputTokens, cost: currentEntry[windowId].cost + row.estimatedCostUsd };
        byRole.set(id, currentEntry);
      }
    }
  };
  add('today', today);
  add('week', week);
  for (const role of GATEWAY_ROLES) if (!byRole.has(role)) byRole.set(role, { role, today: line([]), week: line([]) });
  return [...byRole.entries()].map(([id, sums]) => ({
    id, role: sums.role, backend: sums.backend, backendModel: sums.backendModel,
    today: `${sums.today.requests} req · ${formatCount(sums.today.tokens)} tok · ${formatUsd(sums.today.cost)}`,
    week: `${sums.week.requests} req · ${formatCount(sums.week.tokens)} tok · ${formatUsd(sums.week.cost)}`,
  }));
}

/** Usage pills per role and backend, today and this week, with estimated cost. */
export function UsagePills({ usage }: { usage: SettingsStatusState<SettingsUsagePayload> }) {
  const answer = usage.value;
  const lines = usage.status === 'ready' && !usage.refreshing && answer && 'ok' in answer && answer.ok ? usageLines(answer) : undefined;
  return (
    <>
      <div className="group-title">Usage</div>
      <div className="group models-usage">
        {(usage.status === 'loading' || usage.refreshing) && <div className="kv"><LoaderCircle size={16} className="spin" /><div className="grow muted">Reading the gateway’s summary…</div></div>}
        {usage.status === 'error' && <div className="kv"><div className="grow muted">Usage is not reported by this PC yet. {usage.message}</div></div>}
        {lines?.map((line) => (
          <div className="kv" key={line.id}>
            <Activity size={18} />
            <div className="grow">
              <div><code>{line.role}</code>{line.backend !== undefined && <> · <code>{line.backend || 'Unmapped'}</code> · {line.backendModel}</>}</div>
              <div className="muted">Today: {line.today} · This week: {line.week}</div>
            </div>
            <span className="usage-pill" role="img" aria-label={`Today ${line.today}`}>{line.today}</span>
            <span className="usage-pill" role="img" aria-label={`This week ${line.week}`}>{line.week}</span>
          </div>
        ))}
        <div className="kv">
          <Info size={18} />
          <div className="grow muted">Estimated cost: price × usage, with a provider-reported cost taking precedence. Local backends cost nothing.</div>
        </div>
      </div>
    </>
  );
}

/** Settings → Models & accounts. */
export function ModelsSettingsPage() {
  const availability = useSettingsCloudAgents();
  const usageVersion = useStore(s => s.usageVersion);
  const usage = useSettingsStatus(api.settingsUsage, isSettingsUsage, usageVersion);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const update = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = document.visibilityState === 'visible' ? setInterval(() => usage.reload(), 60_000) : undefined;
    };
    update();
    document.addEventListener('visibilitychange', update);
    return () => {
      if (timer !== undefined) clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, [usage.reload]);
  return (
    <Page className="page-models-settings" title="Models & accounts">
      <p className="page-lead">
        What serves each model role right now, what Hermes runs on, the gateway’s keys, the cloud sign-ins, and what it has all used.
      </p>
      <SettingsSectionSource section="models">
        <SettingsSectionSource section="safety">
          <SettingsSectionGuard section="models" views={['gateway.role-map', 'gateway.state']}><RolesSection /></SettingsSectionGuard>
          <SettingsSectionGuard section="models" views={['hermes.models']} dependency={{ section: 'safety', views: ['hermes.managed'] }}><HermesModelsSection /></SettingsSectionGuard>
          <SettingsSectionGuard section="models" views={['gateway.role-map']}><ApiKeys /></SettingsSectionGuard>
          <SettingsReadNotice state={availability} />
          <Subscriptions availability={availability} />
          <SettingsReadNotice state={usage} />
          <UsagePills usage={usage} />
        </SettingsSectionSource>
      </SettingsSectionSource>
    </Page>
  );
}
