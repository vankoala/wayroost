import { describe, expect, it } from 'vitest';
import type { ActionSummary, ComponentStatus, SupervisorStatus } from '../../shared/supervisor';
import {
  actionLabel,
  mainAction,
  offersTiming,
  overallTone,
  powerDetailLines,
  runningLine,
  STATE_CHIP,
  switchProfiles,
  UNAVAILABLE_LINE,
} from './power';

// Plain names: nothing in these strings may name a daemon, a unit or a port.

const component = (id: string, extra: Partial<ComponentStatus> = {}): ComponentStatus => ({
  id,
  name: id,
  state: 'up',
  sentence: 'It is answering.',
  actions: ['restart'],
  ...extra,
});

const running = (verb: ActionSummary['verb'], target: string, profile?: string): ActionSummary => ({
  id: 'demo-action-1',
  verb,
  target,
  state: 'running',
  caller: 'demo',
  startedAt: 1,
});

const status = (components: ComponentStatus[], running?: SupervisorStatus['running']): SupervisorStatus => ({
  overall: 'ok',
  sentence: 'Everything is running.',
  components,
  ...(running ? { running } : {}),
  at: 1,
});

describe('the words the status block uses', () => {
  it('names each state the way the app names it elsewhere', () => {
    expect(Object.fromEntries(Object.entries(STATE_CHIP).map(([k, v]) => [k, v.label]))).toEqual({
      up: 'Running',
      starting: 'Starting',
      down: 'Stopped',
      held: 'Held',
      failing: 'Keeps failing',
    });
    expect(STATE_CHIP.up.tone).toBe('ok');
    expect(STATE_CHIP.held.tone).toBe('need');
    expect(STATE_CHIP.down.tone).toBe('bad');
  });

  it('picks the block colour from the worst thing on the PC', () => {
    expect(overallTone('ok')).toBe('ok');
    expect(overallTone('attention')).toBe('need');
    expect(overallTone('down')).toBe('bad');
  });

  it('says the same thing about a running action wherever it appears', () => {
    expect(runningLine(running('restart', 'paseo'))).toBe('Restart…');
    expect(runningLine({ ...running('restart', 'paseo'), state: 'queued' })).toBe('Restart queued…');
    expect(runningLine({ ...running('restart', 'paseo'), state: 'waiting-for-idle' })).toBe(
      'Restart: waiting for a quiet moment…',
    );
    expect(runningLine({ ...running('restart', 'paseo'), state: 'failed' })).toBe('Restart didn’t finish.');
  });

  it('never leaks an id into the running line', () => {
    expect(runningLine(running('restart', 'wayroost-server'))).toBe('Restart…');
  });

  it('lists the models you could switch to, without the live one', () => {
    const model = component('main-model', {
      actions: ['switch-model'],
      model: {
        live: 'main-model',
        profiles: [
          { id: 'main-model', name: 'Main model', loadSeconds: 420, gpus: [0] },
          { id: 'balanced', name: 'Balanced model', loadSeconds: 240, gpus: [0] },
          { id: 'large', name: 'Large model', loadSeconds: 300, gpus: [0] },
        ],
      },
    });
    expect(switchProfiles(model).map((p) => p.id)).toEqual(['balanced', 'large']);
    expect(switchProfiles(component('coder', { actions: ['switch-model'] }))).toEqual([]);
  });

  it('takes the main action from what the supervisor offered first', () => {
    const card = component('paseo', { actions: ['switch-model', 'restart', 'hold'] });
    expect(mainAction(card)).toBe('switch-model');
    expect(card.actions.filter((a) => a !== mainAction(card))).toEqual(['restart', 'hold']);
    expect(mainAction(component('helper'))).toBe('restart');
    expect(mainAction(component('speech', { actions: [] }))).toBeNull();
  });

  it('only asks now-or-when for the things that wait', () => {
    expect(offersTiming('restart')).toBe(true);
    expect(offersTiming('switch-model')).toBe(true);
    expect(offersTiming('hold')).toBe(false);
    expect(offersTiming('release')).toBe(false);
  });

  it('calls the verbs by their plain names', () => {
    expect(actionLabel('switch-model')).toBe('Switch model');
    expect(actionLabel('hold')).toBe('Hold');
    expect(actionLabel('release')).toBe('Release');
    expect(actionLabel('diagnostics')).toBe('Run diagnostics');
    for (const verb of ['start', 'stop', 'restart'] as const) {
      expect(actionLabel(verb)).toBe(verb[0]!.toUpperCase() + verb.slice(1));
    }
  });
});

describe('what a service costs, one level down', () => {
  it('names the model and how to reach this PC from outside', () => {
    const components = [
      component('main-model', {
        name: 'Main model',
        model: {
          live: 'balanced',
          profiles: [
            { id: 'main-model', name: 'Main model', loadSeconds: 420, gpus: [0] },
            { id: 'balanced', name: 'Balanced model', loadSeconds: 240, gpus: [0] },
          ],
        },
      }),
      component('signalbox-tunnel', { name: 'Remote access' }),
      component('paseo', { name: 'Coding agents', details: { Port: '19007' } }),
    ];
    expect(powerDetailLines(status(components))).toEqual([
      'Main model: Balanced model',
      'Remote access: on',
    ]);
  });

  it('has nothing to add before the supervisor answers', () => {
    expect(powerDetailLines(status([]))).toEqual([]);
    expect(UNAVAILABLE_LINE).toMatch(/isn.t available yet/);
  });

  it('falls back to what the supervisor says is live, in its plain words', () => {
    const components = [component('main-model', { name: 'Main model', model: { live: 'mystery', profiles: [] } })];
    expect(powerDetailLines(status(components))).toEqual(['Main model: mystery']);
  });

  it('says what it means when nothing is answering and the tunnel is down', () => {
    const components = [
      component('main-model', { name: 'Main model', model: { live: null, profiles: [{ id: 'a', name: 'A', gpus: [0] }] } }),
      component('signalbox-tunnel', { name: 'Remote access', state: 'down' }),
    ];
    expect(powerDetailLines(status(components))).toEqual(['Main model: not answering', 'Remote access: off']);
  });
});
