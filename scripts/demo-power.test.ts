import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionDetail, ActionRequest, ActionSummary, BusyError } from '../shared/supervisor.js';
import { DemoSupervisor } from './demo-power.js';
import { PHONE_COOKIE, apiHeaders, makeApp, makeKeys, makeToken, postHeaders, type Keys } from '../server/test/helpers.js';

// The demo's pretend supervisor, alone and behind the production power routes
//: the server does the confirm taps, the demo only plays the PC.

const isBusy = (result: ActionSummary | BusyError): result is BusyError => 'error' in result;

describe('the demo supervisor', () => {
  let demo: DemoSupervisor;
  const component = (id: string) => demo.snapshot().components.find((c) => c.id === id)!;
  const act = async (request: Omit<ActionRequest, 'target'> & { target: string }) => {
    const result = await demo.act(request as ActionRequest);
    if (isBusy(result)) throw new Error(result.message);
    return result;
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date('2000-01-01T00:00:00Z'));
    demo = new DemoSupervisor({ runMs: 9_000, lines: (verb, target) => [`${verb} ${target}`, 'Done.'] });
  });
  afterEach(() => {
    demo.stop();
    vi.useRealTimers();
  });

  it.each(['paseo', 'main-model'])('offers Release after holding %s and restores its actions after release', async (target) => {
    const before = component(target).actions;
    await act({ verb: 'hold', target });
    await vi.advanceTimersByTimeAsync(9_000);
    const held = component(target);
    expect(held.state).toBe('held');
    expect(held.actions[0]).toBe('release');
    expect(held.actions).not.toContain('hold');
    await act({ verb: 'release', target });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(component(target).actions).toEqual(before);
  });

  it('offers Restart as the main action after releasing the initially held speech service', async () => {
    await act({ verb: 'release', target: 'speech' });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(component('speech').state).toBe('up');
    expect(component('speech').actions).toEqual(['restart', 'hold']);
  });

  it.each(['coder', 'keepalive'])('offers Start after stopping %s and restores its actions after start', async (target) => {
    const before = component(target).actions;
    await act({ verb: 'stop', target });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(component(target).state).toBe('down');
    expect(component(target).actions).toEqual(['start']);
    await act({ verb: 'start', target });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(component(target).actions).toEqual(before);
    expect(component(target).state).toBe('up');
    expect(component(target).sentence).toContain('running');
  });

  it('answers busy, with the running action, while one runs, as the supervisor does', async () => {
    const first = await act({ verb: 'restart', target: 'coder' });
    const second = await demo.act({ verb: 'restart', target: 'paseo' });
    expect(isBusy(second) && second.running.id).toBe(first.id);
  });

  it('does not let a completed action clear its successor', async () => {
    await act({ verb: 'restart', target: 'coder' });
    await vi.advanceTimersByTimeAsync(9_000);
    const next = await act({ verb: 'hold', target: 'speech' });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(demo.snapshot().running?.id).toBe(next.id);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(component('speech').state).toBe('held');
    expect((await demo.action(next.id))?.state).toBe('done');
  });

  it('keeps each completed action’s own lines while another runs and finishes', async () => {
    const first = await act({ verb: 'restart', target: 'coder' });
    await vi.advanceTimersByTimeAsync(9_000);
    const second = await act({ verb: 'release', target: 'speech' });
    const lines = async (id: string) => ((await demo.action(id)) as ActionDetail).lines;
    expect(await lines(first.id)).toEqual(['restart coder', 'Done.']);
    await vi.advanceTimersByTimeAsync(900);
    expect(await lines(first.id)).toEqual(['restart coder', 'Done.']);
    expect(await lines(second.id)).toEqual(['release speech']);
    await vi.advanceTimersByTimeAsync(8_100);
    expect(await lines(second.id)).toEqual(['release speech', 'Done.']);
  });

  it('reports on its event stream: a snapshot first, then actions and lines', async () => {
    const events: string[] = [];
    const stop = demo.events({ event: (event) => events.push(event.type), lost: () => events.push('lost') });
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(['status']);
    await act({ verb: 'restart', target: 'coder' });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(events).toContain('action');
    expect(events).toContain('line');
    expect(events.at(-1)).toBe('status');
    stop();
  });

  it('cancels all callbacks on reset, including callbacks with the same fake time', async () => {
    await act({ verb: 'stop', target: 'coder', when: 'idle' });
    demo.reset();
    await act({ verb: 'release', target: 'speech', when: 'idle' });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(component('coder').state).toBe('up');
    expect(component('speech').state).toBe('up');
  });
});

describe('the demo supervisor behind the production power routes', () => {
  let keys: Keys;
  let token: string;
  const cleanups: Array<() => Promise<unknown>> = [];
  beforeAll(async () => {
    keys = await makeKeys();
    token = await makeToken(keys);
  });
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  const build = async () => {
    const demo = new DemoSupervisor();
    const ctx = await makeApp(keys, { supervisor: demo });
    cleanups.push(async () => {
      demo.stop();
      await ctx.app.close();
    });
    await new Promise((resolve) => setTimeout(resolve, 5)); // its first snapshot
    const post = (body: object, cookie?: string) =>
      ctx.app.inject({
        method: 'POST',
        url: '/api/power/actions',
        headers: postHeaders(token, cookie ? { cookie } : {}),
        payload: JSON.stringify(body),
      });
    return { ...ctx, demo, post };
  };

  it('serves the status envelope without registering any routes of its own', async () => {
    const { app } = await build();
    const res = await app.inject({ url: '/api/power', headers: apiHeaders(token) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ running: true, status: { overall: 'attention' }, presence: [] });
  });

  it('lets the paired desktop act at once', async () => {
    const { post, demo } = await build();
    const res = await post({ verb: 'restart', target: 'coder' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ action: expect.objectContaining({ verb: 'restart', target: 'coder' }) });
    expect(demo.snapshot().running?.target).toBe('coder');
  });

  it('asks the paired phone for a confirm tap, then runs the exact request once', async () => {
    const { post, demo } = await build();
    const request = { verb: 'switch-model', target: 'main-model', profile: 'balanced', when: 'idle' };
    const asked = await post(request, PHONE_COOKIE);
    expect(asked.statusCode).toBe(202);
    const { confirm, summary } = asked.json();
    expect(summary).toMatch(/^Switch to Balanced model when things go idle\?/);
    expect(demo.snapshot().running).toBeUndefined();

    // Bound to every field of the request: a changed one is refused, and the token is spent.
    expect((await post({ ...request, profile: 'large', confirm }, PHONE_COOKIE)).statusCode).toBe(403);
    expect(demo.snapshot().running).toBeUndefined();
    const again = (await post(request, PHONE_COOKIE)).json().confirm;
    const run = await post({ ...request, confirm: again }, PHONE_COOKIE);
    expect(run.statusCode).toBe(202);
    expect(run.json().action).toMatchObject({ verb: 'switch-model', profile: 'balanced' });
    expect((await post({ ...request, confirm: again }, PHONE_COOKIE)).statusCode).toBe(403);
  });

  it('refuses a wrong confirmation without starting anything', async () => {
    const { post, demo } = await build();
    await post({ verb: 'restart', target: 'coder' }, PHONE_COOKIE);
    const res = await post({ verb: 'restart', target: 'coder', confirm: 'f'.repeat(32) }, PHONE_COOKIE);
    expect(res.statusCode).toBe(403);
    expect(demo.snapshot().running).toBeUndefined();
  });
});
