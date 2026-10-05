// Revoked "always" answers. Hermes' gateway loads the list once, so a revoke
// reaches it at a restart or at its next "always" answer; and a Hermes settings
// page that was open before the revoke puts the entry back on its next save.
import { commandAllowlist } from '../../../shared/command-allowlist.js';
import { entryHash } from './common.js';
import type { Check } from './engine.js';

export const allowlistChecks: readonly Check[] = [
  {
    id: 'allowlist.revoke-pending',
    requires: ['revocations', 'hermes.safety'],
    unknown: "The revokes, the gateway's start time or Hermes' list could not be read, so pending revokes were not compared.",
    run: context => {
      const revocations = context.revocations();
      if (!revocations.length) return { state: 'ok', sentence: 'No "always" answer has been revoked.' };
      const latest = Math.max(...revocations.map(entry => entry.revokedAt));
      const startedAt = context.hermesStartedAt();
      if (!startedAt) return { state: 'unknown', sentence: "Nothing says when Hermes' gateway started, so a pending revoke cannot be ruled out." };
      if (latest > startedAt) {
        return {
          state: 'warn',
          sentence: 'A revoke came after the gateway started, so it may still honour that answer until it restarts or answers "always" again.',
          details: ['hermes-gateway', `${revocations.length} revoked`],
          fix: { restart: { component: 'hermes', when: 'idle' } },
        };
      }
      return { state: 'ok', sentence: 'The gateway started after the last revoke, so it reads the list without those answers.', details: [`${revocations.length} revoked`] };
    },
  },
  {
    id: 'allowlist.revoke-back',
    // A revoke removes an entry's text from the file, and what brings it back is a page
    // saving old values into that file, so the file's own list is compared, by the same
    // digest the revoke used. Hermes' effective list (expanded, or overlaid by a managed
    // layer) is a different identity; managed pins have their own row.
    requires: ['revocations', 'hermes.allowlist'],
    unknown: "The revokes or Hermes' list could not be read, so nothing was checked for an entry coming back.",
    run: context => {
      const revocations = context.revocations();
      if (!revocations.length) return { state: 'ok', sentence: 'Nothing revoked can come back.' };
      const hashed = revocations.filter(entry => entry.entrySha256 !== undefined);
      if (hashed.length !== revocations.length) {
        return { state: 'unknown', sentence: 'The revoked answers are recorded here by time only, so the list could not be searched for one coming back.' };
      }
      const list = context.value('hermes.allowlist', ['command_allowlist']);
      const normalized = commandAllowlist(list.value ?? []);
      if (!normalized) {
        return { state: 'unknown', sentence: "Hermes' list could not be normalized, so revoked entries were not compared." };
      }
      const entries = normalized as string[];
      const hashes = new Set(entries.map(entryHash));
      const back = hashed.filter(entry => hashes.has(entry.entrySha256!));
      if (!back.length) {
        return { state: 'ok', sentence: 'Every revoked answer is still out of the list.', details: [`${revocations.length} checked`] };
      }
      // Entries Hermes added itself by answering "always" are not drift; only a
      // revoked one coming back is, and that is a page that saved old values.
      return {
        state: 'fail',
        priority: 'high',
        sentence: `A revoked "always" answer is back in Hermes' list: a settings page saved old values over your revoke. ${back.length} of ${revocations.length} revoked ${back.length === 1 ? 'is' : 'are'} back.`,
        details: [...new Set(back.map(entry => entry.entrySha256!))].slice(0, 12),
        fix: { operation: 'hermes.revoke-always', params: { entrySha256: back[0]!.entrySha256! } },
      };
    },
  },
];
