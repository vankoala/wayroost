// Hermes' own config: whether its file parses at all, its default model against
// the provider entry it names, the approval mode that is in force, and what a
// managed Hermes layer pins.
import { settingValuesEqual } from '../../../shared/settings.js';
import { APPROVAL_MODES } from '../../../shared/settings-ops.js';
import type { Check } from './engine.js';
import { hermesWritesPath, keyName } from './common.js';

const PARSE_UNKNOWN = "Hermes' config could not be read, so whether its file parses is unknown.";

export const hermesChecks: readonly Check[] = [
  {
    // A file Hermes' reader can't parse is its own row: a running Hermes keeps the
    // last copy it could read, so what is in the file is not what is running.
    id: 'hermes.reader-parse',
    unknown: PARSE_UNKNOWN,
    run: context => {
      const refusal = context.refusal('hermes.models');
      if (!refusal && !context.view('hermes.models').present) return { state: 'fail', sentence: "Hermes' config file is missing, so it cannot be parsed." };
      if (!refusal) return { state: 'ok', sentence: "Hermes' config file parses, so what it holds is what Hermes runs." };
      if (refusal.code === 'parse_failed') return {
        state: 'fail', priority: 'high',
        sentence: "Hermes' config file can't be parsed by Hermes' own reader. A running Hermes keeps the last copy it could read, "
          + 'so the settings in that file are not in force.',
        details: ['hermes-config'],
      };
      return { state: 'unknown', sentence: PARSE_UNKNOWN };
    },
  },
  {
    id: 'hermes.model-provider',
    requires: ['hermes.models'],
    unknown: "Hermes' config could not be read, so its default model was not compared to its provider entry.",
    // Judged on what Hermes' loader returns, whether or not its user file exists.
    run: context => {
      const model = context.value('hermes.models', ['model', 'default']);
      const provider = context.value('hermes.models', ['model', 'provider']);
      const named = (value: typeof model): value is { exists: true; value: string } =>
        value.exists && typeof value.value === 'string' && value.value !== '';
      if (!named(model)) return { state: 'fail', sentence: 'Hermes has no default model set.', details: [keyName(['model', 'default'])] };
      if (!named(provider)) {
        return { state: 'fail', sentence: "Hermes' default model names no provider.", details: [keyName(['model', 'provider'])] };
      }
      const entry = context.value('hermes.models', ['providers', provider.value, 'base_url']);
      if (!entry.exists || entry.value === null || entry.value === '') {
        return {
          state: 'fail',
          sentence: "Hermes' default model names a provider its config has no entry for.",
          details: [keyName(['model', 'provider']), keyName(['providers', '*', 'base_url'])],
        };
      }
      const baseUrl = context.value('hermes.models', ['model', 'base_url']);
      if (!baseUrl.exists || baseUrl.value === null || baseUrl.value === '') {
        return {
          state: 'ok',
          sentence: "Hermes' default model takes its address from its provider entry.",
          details: [keyName(['model', 'base_url'])],
        };
      }
      if (!settingValuesEqual(baseUrl.value, entry.value)) {
        return {
          state: 'fail',
          sentence: "Hermes' default model addresses a different server than its own provider entry does.",
          details: [keyName(['model', 'base_url']), keyName(['providers', '*', 'base_url'])],
        };
      }
      return { state: 'ok', sentence: "Hermes' default model and its provider entry address the same server." };
    },
  },
  {
    id: 'hermes.approval-mode',
    requires: ['hermes.safety'],
    unknown: "Hermes' config could not be read, so its approval mode is unknown.",
    run: context => {
      const configuredMode = context.value('hermes.safety', ['approvals', 'mode']);
      const mode = !configuredMode.exists || configuredMode.value === null || configuredMode.value === ''
        ? { exists: true, value: 'smart' } : configuredMode;
      // Scheduled jobs follow their own mode: 'approve' runs their guarded commands without asking.
      const cron = context.value('hermes.safety', ['approvals', 'cron_mode']);
      const cronApproves = cron.exists && cron.value === 'approve';
      const details = cronApproves ? [keyName(['approvals', 'cron_mode'])] : [];
      const cronNote = cronApproves ? ' Scheduled jobs are an exception: they run guarded commands without asking.' : '';
      if (!APPROVAL_MODES.includes(mode.value as typeof APPROVAL_MODES[number])) {
        return { state: 'warn', sentence: "Hermes' approval mode is not one Wayroost knows.", details: [keyName(['approvals', 'mode'])] };
      }
      if (mode.value === 'manual') return cronApproves
        ? { state: 'warn', sentence: `Hermes asks before every guarded command in chats.${cronNote}`, details }
        : { state: 'ok', sentence: 'Hermes asks before every guarded command.', details };
      if (mode.value === 'smart') return {
        state: 'warn',
        sentence: `Hermes' approval mode is smart: a model guardian decides which commands still need your answer.${cronNote}`,
        details,
        fix: { operation: 'hermes.approval-mode', params: { mode: 'manual' } },
      };
      return {
        state: 'warn',
        sentence: 'Hermes runs every guarded command without asking anyone.',
        details,
        fix: { operation: 'hermes.approval-mode', params: { mode: 'manual' } },
      };
    },
  },
  {
    id: 'hermes.managed-pins',
    requires: ['hermes.managed'],
    unknown: "The managed Hermes layer could not be read, so nothing was checked against it.",
    run: context => {
      const view = context.view('hermes.managed');
      if (!view.present) return { state: 'ok', sentence: 'There is no managed Hermes layer on this PC.' };
      const present = view.values.filter(entry => entry.exists);
      const pinned = present.map(entry => keyName(entry.path));
      const written = present.filter(entry => hermesWritesPath(entry.path)).map(entry => keyName(entry.path));
      if (written.length) {
        return {
          state: 'fail',
          sentence: `The managed Hermes file pins ${written.length} key${written.length === 1 ? '' : 's'} Wayroost writes, so those settings cannot take effect from the pages.`,
          details: [...written.slice(0, 11), 'hermes-managed'],
        };
      }
      return { state: 'ok', sentence: 'The managed Hermes layer pins no key Wayroost writes.', details: [...new Set(pinned)].slice(0, 12) };
    },
  },
];
