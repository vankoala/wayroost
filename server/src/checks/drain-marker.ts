// Hermes' drain marker. While it is present Hermes refuses turns, so a marker
// outside a running drain-restart holds the gateway; the supervisor's start-up
// sweep removes only Wayroost's own marker and leaves anyone else's alone.
import type { Check } from './engine.js';

const minutes = (ms: number): number => Math.max(0, Math.round(ms / 60_000));

export const drainMarkerChecks: readonly Check[] = [
  {
    id: 'hermes.drain-marker',
    requires: ['drainMarker'],
    unknown: "Hermes' drain marker could not be read, so its state is unknown.",
    run: context => {
      const marker = context.drainMarker();
      if (marker.unreadable) {
        return {
          state: 'warn',
          sentence: "Something stands where Hermes' drain marker goes that can't be read as one, so a drain cannot be checked.",
        };
      }
      if (!marker.present) return { state: 'ok', sentence: 'No drain marker is in place.' };
      if (!marker.ours) return { state: 'ok', sentence: 'Something else is draining Hermes right now.' };
      if (marker.drainRunning === null) return { state: 'unknown', sentence: 'The executor unit could not be checked, so the drain marker cannot be called leftover.' };
      if (marker.drainRunning) {
        return { state: 'ok', sentence: 'A drain-restart of Hermes is running now.', details: [`requested ${minutes(context.at - marker.requestedAt)} min ago`] };
      }
      return {
        state: 'fail',
        priority: 'high',
        sentence: "A drain marker Wayroost left is still in place with no drain running; Hermes can refuse turns because of it.",
        details: [`requested ${minutes(context.at - marker.requestedAt)} min ago`],
        fix: { operation: 'hermes.drain-marker-remove', params: {} },
      };
    },
  },
];
