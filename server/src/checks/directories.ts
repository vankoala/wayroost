// The storage rule: every folder on the way to a target, its backups and its
// audit must be owned and writable only by the account that uses them. The
// preflight runs the same walk the executor runs, and names only the targets.
import type { Check } from './engine.js';

export const directoriesChecks: readonly Check[] = [
  {
    id: 'directories.walk',
    requires: ['directoryRule'],
    unknown: 'The storage rule was not run for this PC, so its paths were not checked.',
    run: context => {
      const { passed, refused } = context.directoryRule();
      if (refused.length) {
        return {
          state: 'fail',
          sentence: `The storage rule refuses ${refused.length} target${refused.length === 1 ? '' : 's'}, so writes to ${refused.length === 1 ? 'it' : 'them'} stop there.`,
          details: refused.slice(0, 12),
        };
      }
      if (!passed.length) return { state: 'ok', sentence: 'This PC has no settings targets to walk.' };
      return { state: 'ok', sentence: 'Every path a settings write uses passes the storage rule.', details: [`${passed.length} targets walked`] };
    },
  },
];
