// The supervisor itself: does it have the settings verbs, are writes switched on,
// does it run actions or only report, and did the last change's own record stick.
import { CONFIG_VERBS, gatewayPersistenceSchema } from '../../../shared/supervisor-config.js';
import { settingsErrorCodeSchema } from '../../../shared/settings.js';
import { CATALOGUE_VERSION } from '../../../shared/settings-ops.js';
import { consumerRecord, keyName, movedKeyCount } from './common.js';
import { GATEWAY_CONSUMERS } from '../../../shared/gateway.js';
import type { Check } from './engine.js';


/** Every file a move records keys for. */
const RECORDED_TARGETS = ['hermes-config', 'pi-mcp', 'pi-models', 'pi-settings', 'paseo-config', 'phone-bridge-dropin'] as const;



export const supervisorChecks: readonly Check[] = [
  {
    id: 'supervisor.config-verbs',
    requires: ['supervisor'],
    unknown: 'The supervisor is not answering, so its settings verbs are unknown.',
    run: context => {
      const verbs = context.supervisor().configVerbs;
      if (!verbs) {
        return { state: 'fail', sentence: 'This supervisor has no settings verbs, so the settings pages cannot write anything.' };
      }
      const expected = context.deployment.supervisor;
      const problems: string[] = [];
      const details: string[] = [];
      if (!CONFIG_VERBS.every(verb => verbs.verbs.includes(verb))) problems.push('It does not advertise every required settings verb.');
      if (verbs.catalogue !== CATALOGUE_VERSION) {
        problems.push(`Its operation catalogue is version ${verbs.catalogue}, not ${CATALOGUE_VERSION}.`);
        details.push(`catalogue ${verbs.catalogue}`);
      }
      if (!verbs.configWrites && expected?.configWrites !== false) {
        problems.push('Settings writes are switched off in the site file.');
        details.push('configWrites off');
      }
      const components = context.supervisor().components;
      const reportsOnly = components.length > 0 && components.every(component => component.actions.length === 0);
      if (expected && expected.statusOnly === false && reportsOnly) {
        problems.push('It reports status only, so nothing can be started or restarted from here.');
        details.push('statusOnly');
      }
      if (problems.length) return { state: 'warn', sentence: problems.join(' '), details: details.slice(0, 12) };
      return { state: 'ok', sentence: 'The supervisor takes settings changes and reports which verbs it has.', details };
    },
  },
  {
    id: 'supervisor.executor-run',
    requires: ['changes', 'supervisor'],
    unknown: 'The supervisor and the recent changes could not be read, so the last run was not checked.',
    run: context => {
      const running = context.supervisor().running;
      const unresolved = context.changes().filter(change => change.result === 'outcome_unknown');
      if (unresolved.length) {
        return {
          state: 'warn',
          sentence: `${unresolved.length} recent change${unresolved.length === 1 ? '' : 's'} could not be confirmed after it was sent; the files were read again instead.`,
          details: unresolved.map(change => change.id).slice(0, 12),
        };
      }
      if (running) {
        return { state: 'ok', sentence: 'The supervisor is running one action now; settings writes wait their turn.', details: [running.target] };
      }
      const last = context.changes()[0];
      if (last && last.result !== 'ok') return { state: 'fail', sentence: 'The last settings change did not finish successfully.',
        details: [last.id, settingsErrorCodeSchema.safeParse(last.result).success ? last.result : 'failed'] };
      return last
        ? { state: 'ok', sentence: 'The last settings change finished and was confirmed.', details: [last.id] }
        : { state: 'ok', sentence: 'No settings change has been made from here yet.' };
    },
  },
  {
    id: 'supervisor.gateway-state',
    requires: ['supervisor', 'gateway.state'],
    unknown: "The recent changes and the gateway's state could not be read, so its records were not checked.",
    run: context => {
      const state = context.view('gateway.state').document;
      const broken = GATEWAY_CONSUMERS.filter(consumer => RECORDED_TARGETS
        .some(target => movedKeyCount(state, consumer, target) === 0));
      if (broken.length) {
        return {
          state: 'fail',
          sentence: `${broken.length} consumer${broken.length === 1 ? ' is' : 's are'} recorded as moved with no key recorded, so a move back cannot be planned from it.`,
          details: broken.slice(0, 12),
        };
      }
      const persistence = gatewayPersistenceSchema.safeParse(context.supervisor().configVerbs?.gatewayPersistence);
      if (!persistence.success || !persistence.data.ok) return { state: 'unknown', sentence: "The supervisor's gateway record outcomes could not be read, so persistence was not checked." };
      const mismatched = persistence.data.failedChanges;
      if (mismatched.length) {
        return {
          state: 'warn',
          sentence: `A change to Wayroost's own record of a moved key did not verify; the intended values may not match what was written (${keyName(['migration', 'consumers', '*', '*'])}).`,
          details: mismatched.slice(0, 12),
        };
      }
      return { state: 'ok', sentence: 'The gateway state records every move it was asked to record.' };
    },
  },
];
