// The Windows Hermes app beside the WSL one. Its settings block is frozen: it is
// read only, never edited from here, so a difference is information, not a fault.
import { settingValuesEqual, type KeyPath } from '../../../shared/settings.js';
import { keyName } from './common.js';
import type { Check } from './engine.js';

const COMPARED: readonly KeyPath[] = [
  ['model', 'provider'], ['model', 'default'], ['model', 'base_url'],
  ['delegation', 'provider'], ['delegation', 'model'], ['agent', 'reasoning_effort'],
];

export const windowsChecks: readonly Check[] = [
  {
    id: 'windows-hermes.models',
    requires: ['windows-hermes.models', 'hermes.models', 'hermes.agents'],
    unknown: 'The Windows Hermes file or the WSL one could not be read, so the two were not compared.',
    run: context => {
      if (!context.view('windows-hermes.models').present) {
        return { state: 'ok', sentence: 'There is no Windows Hermes file to compare with this PC.' };
      }
      const different = COMPARED.filter(path => {
        const here = context.value(['hermes.models', 'hermes.agents'], path);
        const there = context.value('windows-hermes.models', path);
        return here.exists !== there.exists || here.exists && !settingValuesEqual(here.value ?? null, there.value ?? null);
      }).map(keyName);
      if (!different.length) {
        return { state: 'ok', sentence: 'The Windows Hermes app follows the same model as this PC.', details: [COMPARED.length + ' keys compared'] };
      }
      return {
        state: 'warn',
        sentence: 'The Windows Hermes app is set differently from this PC. Its block is frozen and Wayroost never edits it, so this is only information.',
        details: [...different.slice(0, 11), 'windows-hermes'],
      };
    },
  },
];
