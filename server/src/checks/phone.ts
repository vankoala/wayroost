// The phone line: what its bridge is pinned to, whether a call is up, and whether
// the bridge's own count of calls agrees with the phone server's. The server's
// active_calls rises and falls with each live call; the bridge keeps its call
// records for hours, so its count alone is never trusted.
import { consumerRecord } from './common.js';
import type { Check } from './engine.js';

/** A bridge count above the server's for longer than this names a hung wrap-up. */
export const PHONE_QUIET_WINDOW_MS = 2 * 60_000;
export const STALE_BRIDGE_COUNT_MS = 10 * 60_000;

export const phoneChecks: readonly Check[] = [
  {
    id: 'phone.address',
    requires: ['gateway.state'],
    unknown: "The gateway's migration record could not be read, so the phone's address was not compared.",
    run: context => {
      const record = consumerRecord(context.view('gateway.state').document, 'phone', 'phone-bridge-dropin');
      if (!record?.moved) return { state: 'ok', sentence: 'The phone follows Hermes, so it has no pinned address of its own.' };
      const main = context.deployment.roleAddresses?.main;
      if (!main) return { state: 'unknown', sentence: 'This PC states no address for the main role, so the phone pin was not compared.' };
      const pin = context.phone().pin;
      if (!pin?.ok) return { state: 'unknown', sentence: "The phone's effective pin could not be read, so its address and model were not compared." };
      if (pin.value.address.replace(/\/+$/, '') !== main.replace(/\/+$/, '')) return {
        state: 'fail', sentence: 'The phone is pinned to an address that is not the main role.', details: ['phone-bridge-dropin'],
      };
      if (pin.value.model !== 'main') return {
        state: 'warn', sentence: 'The phone is pinned to a model name other than the main role.', details: ['phone-bridge-dropin'],
      };
      return { state: 'ok', sentence: 'The phone is pinned to the main role.', details: ['phone-bridge-dropin'] };
    },
  },
  {
    id: 'phone.quiet',
    requires: ['phone'],
    unknown: "The phone's health answer could not be read, so whether it is quiet is unknown.",
    run: context => {
      const { server, bridge, quietForMs } = context.phone();
      if (!server.ok) return { state: 'unknown', sentence: "The phone server isn't answering its health check, so a restart that would cut a call waits." };
      if (!bridge.ok) return { state: 'unknown', sentence: "The phone bridge did not answer, so whether it is quiet is unknown." };
      const calls = Math.max(server.value.activeCalls, bridge.value.activeCalls);
      if (calls === 0) {
        if (quietForMs === undefined || quietForMs === null) return { state: 'unknown', sentence: 'The phone counters have no stable observation yet.' };
        if (quietForMs < PHONE_QUIET_WINDOW_MS) return { state: 'warn', sentence: 'The phone counters have not stayed quiet for two minutes yet.' };
        return { state: 'ok', sentence: 'The phone is quiet.' };
      }
      return { state: 'warn', sentence: 'A call is up or arriving, so a restart of the bridge waits for it.', details: [`${calls} counted`] };
    },
  },
  {
    id: 'phone.stale-count',
    requires: ['phone'],
    unknown: "The phone server's and the bridge's counts could not be read, so they were not compared.",
    run: context => {
      const { server, bridge, excessForMs } = context.phone();
      if (!server.ok || !bridge.ok) return { state: 'unknown', sentence: 'Either the phone server or its bridge did not answer, so their counts were not compared.' };
      const above = bridge.value.activeCalls - server.value.activeCalls;
      if (above <= 0) return { state: 'ok', sentence: 'The bridge counts no more calls than the phone server does.' };
      if (excessForMs === undefined || excessForMs === null) return { state: 'unknown', sentence: 'The excess bridge count has no timing observation, so its duration is unknown.' };
      if (excessForMs <= STALE_BRIDGE_COUNT_MS) {
        return { state: 'ok', sentence: 'The bridge counts more calls, but the excess has not been observed for over ten minutes here.', details: [`${above} above`] };
      }
      return {
        state: 'warn',
        sentence: 'The bridge still holds more calls than the phone server counts, for over ten minutes; a wrap-up may have hung.',
        details: [`${above} above`, `held for ${Math.round(excessForMs / 60_000)} min`],
      };
    },
  },
];
