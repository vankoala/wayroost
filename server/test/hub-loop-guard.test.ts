import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  LoopGuard,
  callSignature,
  canonicalArgsHash,
  errorClass,
  type LoopGuardDecision as GuardDecision,
  type ToolCallOutcome as ToolOutcome,
} from '../src/hub/loop-guard.js';

// The loop guard: one agent's repeated failing tool calls, and the decision it
// hands back to whoever is running that agent.

const T0 = 1_700_000_000_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const CONSECUTIVE_TRIPS = 3;
const WINDOW_TRIPS = 5;
const ALTERNATION_TRIPS = 3;
const MAX_OUTCOMES_PER_AGENT = 200;
const FORGET_AFTER_MS = 60 * MINUTE;

const argsFor = (path: string) => canonicalArgsHash(JSON.stringify({ path, offset: 1 }));
const fails = (times: number, over: Partial<ToolOutcome> = {}) => Array.from({ length: times }, () => over);

function outcome(over: Partial<ToolOutcome> = {}): ToolOutcome {
  const call = {
    agentId: 'agent-one',
    tool: 'read_file',
    argsHash: argsFor('/home/me/project/app.ts'),
    ok: false,
    errorClass: errorClass('ENOENT: no such file or directory, open /home/me/project/app.ts:12:5'),
    at: T0,
    ...over,
  };
  return call.ok ? { ...call, ok: true } : { ...call, ok: false, errorClass: call.errorClass ?? '' };
}

/** Feed calls in order, each later than the last, and return what the guard said. */
function feed(guard: LoopGuard, calls: Partial<ToolOutcome>[], stepMs = 10 * SECOND, from = T0): (GuardDecision | null)[] {
  return calls.map((call, i) => guard.record(outcome({ ...call, at: from + i * stepMs })));
}

const kinds = (decisions: (GuardDecision | null)[]) => decisions.map((decision) => decision?.kind ?? null);
const read = { tool: 'read_file', argsHash: argsFor('/home/me/notes.md'), errorClass: errorClass('no such file or directory') };
const write = { tool: 'write_file', argsHash: canonicalArgsHash(JSON.stringify({ path: '/home/me/notes.md' })), errorClass: errorClass('read only file system') };
const swing = (trips: number) => Array.from({ length: trips }, () => [read, write]).flat();

describe('content-free outcomes', () => {
  const call = {
    agentId: 'agent-one',
    tool: 'read_file',
    argsHash: 'a'.repeat(64),
    ok: false as const,
    errorClass: 'not_found',
    at: T0,
  };

  it('exports the helpers callers use before recording outcomes', () => {
    expect(canonicalArgsHash('{}')).toMatch(/^[0-9a-f]{64}$/);
    expect(errorClass('Failure 12\nDetails')).toBe('failure <value>');
  });

  it('requires prepared fields in the outcome type', () => {
    expectTypeOf<ToolOutcome>().not.toHaveProperty('argsJson');
    expectTypeOf<ToolOutcome>().not.toHaveProperty('errorText');
    expectTypeOf<ToolOutcome>().toHaveProperty('argsHash').toEqualTypeOf<string>();
    expectTypeOf<Extract<ToolOutcome, { ok: false }>>().toHaveProperty('errorClass').toEqualTypeOf<string>();
  });

  it('counts supplied hashes separately without argument JSON', () => {
    const guard = new LoopGuard();
    const hashes = ['a', 'b', 'c', 'a', 'b', 'c'];
    expect(kinds(hashes.map((hash) => guard.record({ ...call, argsHash: hash.repeat(64) })))).toEqual([
      null, null, null, null, null, null,
    ]);
  });

  it('counts supplied classes separately without error text', () => {
    const guard = new LoopGuard();
    const classes = ['not_found', 'denied', 'unavailable', 'not_found', 'denied', 'unavailable'];
    expect(kinds(classes.map((errorClass) => guard.record({ ...call, errorClass })))).toEqual([
      null, null, null, null, null, null,
    ]);
  });

  it('uses supplied error classes verbatim', () => {
    const guard = new LoopGuard();
    const classes = ['Failure 12', 'failure 12', 'failure 99', 'Failure 12', 'failure 12', 'failure 99'];
    expect(kinds(classes.map((errorClass) => guard.record({ ...call, errorClass })))).toEqual([
      null, null, null, null, null, null,
    ]);
  });

  it('does not inspect raw argument or error fields', () => {
    const guard = new LoopGuard();
    const contentFree = Object.defineProperties({ ...call }, {
      argsJson: { enumerable: true, get() { throw new Error('Argument JSON must be processed by the caller.'); } },
      errorText: { enumerable: true, get() { throw new Error('Error text must be processed by the caller.'); } },
    });
    expect(kinds(Array.from({ length: 6 }, () => guard.record(contentFree)))).toEqual([
      null, null, 'steer', null, null, 'stop',
    ]);
    expect(() => JSON.stringify(guard, (_key, value: unknown) =>
      value instanceof Map || value instanceof Set ? [...value] : value)).not.toThrow();
  });

  it('resets all classes when a call with the same supplied hash succeeds', () => {
    const guard = new LoopGuard();
    const record = (errorClass: string) => kinds(Array.from({ length: 3 }, () => guard.record({ ...call, errorClass })));
    expect(record('not_found')).toEqual([null, null, 'steer']);
    expect(record('denied')).toEqual([null, null, 'steer']);
    const { errorClass: _errorClass, ...success } = call;
    expect(guard.record({ ...success, ok: true })).toBeNull();
    expect(record('not_found')).toEqual([null, null, 'steer']);
    expect(record('denied')).toEqual([null, null, 'steer']);
  });
});

describe('the same failing call over and over', () => {
  it('says nothing until the failure has repeated three times in a row', () => {
    const guard = new LoopGuard();
    expect(kinds(feed(guard, fails(CONSECUTIVE_TRIPS - 1)))).toEqual([null, null]);
    const [decision] = feed(guard, [{}], 10 * SECOND, T0 + 30 * SECOND);
    expect(decision?.kind).toBe('steer');
    if (decision?.kind !== 'steer') return;
    expect(decision.message).toContain('read_file');
    expect(decision.message).toMatch(/keeps failing/i);
    expect(decision.message).toMatch(/change your approach.*report/i);
  });

  it('counts the same arguments however they are written', () => {
    const guard = new LoopGuard();
    const written = [
      JSON.stringify({ path: '/home/me/project/app.ts', offset: 1 }),
      JSON.stringify({ offset: 1, path: '/home/me/project/app.ts' }),
      `{\n  "path" :  "/home/me/project/app.ts",\n   "offset" : 1\n}\n`,
    ];
    expect(kinds(feed(guard, written.map((argsJson) => ({ argsHash: canonicalArgsHash(argsJson) }))))).toEqual([null, null, 'steer']);
  });

  it('counts arguments that are not JSON however they are spaced', () => {
    const guard = new LoopGuard();
    const written = ['cd   /home/me  &&   ls', '  cd /home/me &&\n  ls ', 'cd /home/me  &&\t\tls'];
    expect(kinds(feed(guard, written.map((argsJson) => ({ tool: 'run_command', argsHash: canonicalArgsHash(argsJson) }))))).toEqual([null, null, 'steer']);
  });

  it('counts another tool or other arguments as another call', () => {
    const guard = new LoopGuard();
    const calls = [
      { tool: 'read_file', argsHash: argsFor('/home/me/a.ts') },
      { tool: 'read_file', argsHash: argsFor('/home/me/b.ts') },
      { tool: 'write_file', argsHash: argsFor('/home/me/a.ts') },
      { tool: 'read_file', argsHash: argsFor('/home/me/c.ts') },
      { tool: 'read_file', argsHash: argsFor('/home/me/d.ts') },
    ];
    expect(kinds(feed(guard, calls))).toEqual([null, null, null, null, null]);
  });

  it('counts repeated failures with changing line numbers', () => {
    const errors = [12, 481, 7].map((line) => `ENOENT: open /home/me/project/app.ts:${line}:5`);
    expect(kinds(feed(new LoopGuard(), errors.map((errorText) => ({ errorClass: errorClass(errorText) }))))).toEqual([null, null, 'steer']);
  });

  it('says nothing about calls that worked', () => {
    const guard = new LoopGuard();
    expect(kinds(feed(guard, fails(10, { ok: true, errorClass: undefined })))).toEqual(fails(10).map(() => null));
  });
});

describe('the same failing call many times in a window', () => {
  /** Another failing call between each repeat, so only the window rule can fire. */
  const between = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
  const surrounded = (repeats: number) =>
    Array.from({ length: repeats }, (_, i) => [{}, { tool: 'run_command', argsHash: canonicalArgsHash('{"cmd":"ls"}'), errorClass: between[i % between.length] }]).flat();

  it('trips on the fifth failure in ten minutes even with other failures between', () => {
    const guard = new LoopGuard();
    expect(kinds(feed(guard, surrounded(WINDOW_TRIPS - 1), MINUTE))).toEqual(fails(2 * (WINDOW_TRIPS - 1)).map(() => null));
    const [decision] = feed(guard, [{}], MINUTE, T0 + 8 * MINUTE);
    expect(decision?.kind).toBe('steer');
    if (decision?.kind !== 'steer') return;
    expect(decision.message).toMatch(/keeps failing/i);
  });

  it('lets failures that fell out of the window go', () => {
    const guard = new LoopGuard({ consecutiveThreshold: 100 });
    const spread = fails(8).map((call, i) => ({ ...call, at: T0 + i * 3 * MINUTE }));
    expect(spread.every((call) => guard.record(outcome(call)) === null)).toBe(true);
    // Closer together than that, the same failures do trip.
    expect(kinds(feed(guard, fails(WINDOW_TRIPS), MINUTE, T0 + 30 * MINUTE)).at(-1)).toBe('steer');
  });
});

describe('two failing calls taking turns', () => {
  it('trips after three round trips between the same two failures', () => {
    const guard = new LoopGuard();
    expect(kinds(feed(guard, [...swing(ALTERNATION_TRIPS - 1), read]))).toEqual(fails(2 * ALTERNATION_TRIPS - 1).map(() => null));
    const [decision] = feed(guard, [write], 10 * SECOND, T0 + (2 * ALTERNATION_TRIPS) * 10 * SECOND);
    expect(decision?.kind).toBe('steer');
    if (decision?.kind !== 'steer') return;
    expect(decision.message).toContain('read_file');
    expect(decision.message).toContain('write_file');
    expect(decision.message).toMatch(/keeps failing/i);
  });

  it('does not trip when one of the two starts working', () => {
    const guard = new LoopGuard();
    const calls = [...swing(2), { ...read, ok: true, errorClass: undefined }, ...swing(2)];
    expect(kinds(feed(guard, calls))).toEqual(fails(4 + 1 + 4).map(() => null));
  });

  it('does not trip when the failures do not alternate', () => {
    const guard = new LoopGuard({ consecutiveThreshold: 100, windowThreshold: 100 });
    const calls = [read, read, write, write, read, write, write, write];
    expect(kinds(feed(guard, calls))).toEqual(fails(8).map(() => null));
  });
});

describe('a call that starts working again', () => {
  it('resets the failures of that call and nothing else', () => {
    const guard = new LoopGuard();
    const calls = [...fails(2), { ok: true, errorClass: undefined }, ...fails(3)];
    expect(kinds(feed(guard, calls))).toEqual([null, null, null, null, null, 'steer']);
  });

  it('resets the count of that call inside the window', () => {
    const guard = new LoopGuard();
    const calls = [...surroundReset(4), { ok: true, errorClass: undefined }, ...surroundReset(4), {}];
    expect(kinds(feed(guard, calls, MINUTE))).toEqual([...fails(8).map(() => null), null, ...fails(8).map(() => null), 'steer']);
  });

  it('is not reset by another call that worked', () => {
    const guard = new LoopGuard({ consecutiveThreshold: 100, windowThreshold: 3 });
    const calls = [...fails(2), { tool: 'list_dir', argsHash: canonicalArgsHash('{}'), ok: true, errorClass: undefined }, {}];
    expect(kinds(feed(guard, calls))).toEqual([null, null, null, 'steer']);
  });
});

/** Repeats of the failing call with a different failing call between each one. */
function surroundReset(repeats: number) {
  return Array.from({ length: repeats }, (_, i) => [{}, { tool: 'run_command', argsHash: canonicalArgsHash(JSON.stringify({ cmd: `echo demo-${i}` })), errorClass: errorClass('Command failed') }]).flat();
}

describe('nudging an agent, then stopping it', () => {
  it('steers the first trip and stops every trip after it', () => {
    const guard = new LoopGuard();
    const calls = [...fails(9), { ok: true, errorClass: undefined }, ...fails(3)];
    expect(kinds(feed(guard, calls))).toEqual([
      null, null, 'steer', // the third failure in a row
      null, null, 'stop', // the loop formed again after the nudge
      null, null, 'stop',
      null, // the call worked, so its failures are forgotten
      null, null, 'steer', // a new loop gets a new nudge
    ]);
  });

  it('never kills anything, it only says stop', () => {
    const guard = new LoopGuard();
    const decisions = feed(guard, fails(30));
    expect(decisions.some((decision) => decision?.kind === 'steer')).toBe(true);
    expect(decisions.filter((decision) => decision?.kind === 'stop').length).toBeGreaterThan(3);
    expect(decisions.every((decision) => decision === null || decision.kind === 'steer' || decision.kind === 'stop')).toBe(true);
    const [stop] = decisions.filter((decision) => decision?.kind === 'stop');
    if (stop?.kind !== 'stop') return;
    expect(stop.reason).toContain('read_file');
    expect(stop.reason).toMatch(/keeps failing.*change approach.*report/i);
  });

  it('escalates an alternating pair the same way', () => {
    const guard = new LoopGuard();
    const calls = [...swing(3), ...swing(3), ...swing(3)];
    expect(kinds(feed(guard, calls))).toEqual([
      null, null, null, null, null, 'steer',
      null, null, null, null, null, 'stop',
      null, null, null, null, null, 'stop',
    ]);
  });
});

describe('agents apart from each other', () => {
  it('counts each agent on its own', () => {
    const guard = new LoopGuard();
    expect(kinds(feed(guard, fails(CONSECUTIVE_TRIPS, { agentId: 'agent-one' })))).toEqual([null, null, 'steer']);
    expect(kinds(feed(guard, fails(CONSECUTIVE_TRIPS, { agentId: 'agent-two' })))).toEqual([null, null, 'steer']);
  });

  it('does not let one agent reset another', () => {
    const guard = new LoopGuard();
    feed(guard, fails(2, { agentId: 'agent-one' }));
    feed(guard, fails(2, { agentId: 'agent-two' }));
    expect(guard.record(outcome({ agentId: 'agent-one', ok: true, errorClass: undefined, at: T0 + 30 * SECOND }))).toBeNull();
    expect(guard.record(outcome({ agentId: 'agent-one', at: T0 + 40 * SECOND }))).toBeNull();
    expect(guard.record(outcome({ agentId: 'agent-two', at: T0 + 40 * SECOND }))?.kind).toBe('steer');
  });
});

describe('what it remembers', () => {
  it('keeps at most the most recent outcomes per agent', () => {
    const guard = new LoopGuard();
    expect(kinds(feed(guard, fails(3))).at(-1)).toBe('steer');
    const distinct = Array.from({ length: 200 }, (_, i) => ({ argsHash: argsFor(`/home/me/f${i}.ts`) }));
    feed(guard, distinct, SECOND, T0 + MINUTE);
    expect(kinds(feed(guard, fails(3), SECOND, T0 + 5 * MINUTE))).toEqual([null, null, 'steer']);
  });

  it('keeps the default history inside its limit', () => {
    for (const fillers of [MAX_OUTCOMES_PER_AGENT - 2, MAX_OUTCOMES_PER_AGENT - 1]) {
      const guard = new LoopGuard({ consecutiveThreshold: 1000, windowThreshold: 2 });
      guard.record(outcome());
      feed(guard, Array.from({ length: fillers }, (_, i) => ({ argsHash: argsFor(`/home/me/f${i}.ts`), ok: true })), SECOND, T0 + SECOND);
      const decision = guard.record(outcome({ at: T0 + 4 * MINUTE }));
      expect(decision?.kind ?? null).toBe(fillers === MAX_OUTCOMES_PER_AGENT - 2 ? 'steer' : null);
    }
  });

  it('forgets an agent that has gone quiet for an hour', () => {
    for (const idle of [FORGET_AFTER_MS - 1, FORGET_AFTER_MS]) {
      const guard = new LoopGuard();
      feed(guard, fails(2), 0);
      guard.sweep(T0 + idle);
      expect(guard.record(outcome({ at: T0 + idle }))?.kind ?? null).toBe(idle < FORGET_AFTER_MS ? 'steer' : null);
    }
  });

  it('forgets idle escalation when another agent reports an outcome', () => {
    const guard = new LoopGuard();
    feed(guard, fails(3), 0);
    guard.record(outcome({ agentId: 'agent-two', ok: true, at: T0 + FORGET_AFTER_MS }));
    expect(kinds(feed(guard, fails(3), SECOND, T0 + FORGET_AFTER_MS + SECOND))).toEqual([null, null, 'steer']);
  });
});

describe('signatures', () => {
  it('take no notice of key order or spacing', () => {
    expect(canonicalArgsHash('{"b":1,"a":{"d":[1,2],"c":3}}')).toBe(canonicalArgsHash('{ "a" : { "c" : 3,\n "d": [1, 2] },\n"b": 1 }'));
    expect(canonicalArgsHash('{"a":[1,2]}')).not.toBe(canonicalArgsHash('{"a":[2,1]}'));
    expect(canonicalArgsHash('  bad json  ')).toBe(canonicalArgsHash('bad json'));
    expect(canonicalArgsHash('cd   /home/me  &&   ls')).toBe(canonicalArgsHash('  cd /home/me &&\n  ls '));
    expect(canonicalArgsHash('cd /home/me && ls')).not.toBe(canonicalArgsHash('cd /home/me/other && ls'));
    expect(canonicalArgsHash('bad json')).not.toBe(canonicalArgsHash('"bad json"'));
  });

  it('match a call with itself and not with another one', () => {
    const one = outcome({ argsHash: canonicalArgsHash('{"path":"/a.ts"}'), errorClass: errorClass('ENOENT at /home/me/project/app.ts:12:5 (id 0xabc123def)') });
    const same = outcome({ argsHash: canonicalArgsHash('{ "path" : "/a.ts" }'), errorClass: errorClass('ENOENT at /home/me/project/app.ts:341:2 (id 0x9999888877)') });
    expect(callSignature(one)).toBe(callSignature(same));
    expect(callSignature({ ...one, tool: 'write_file' })).not.toBe(callSignature(one));
    expect(callSignature({ ...one, argsHash: canonicalArgsHash('{"path":"/b.ts"}') })).not.toBe(callSignature(one));
    expect(callSignature({ ...one, errorClass: errorClass('permission denied, open /a.ts:1') })).not.toBe(callSignature(one));
  });
});

describe('failure pattern boundaries', () => {
  it('breaks a consecutive run on another signature or any successful call', () => {
    for (const between of [{ tool: 'write_file' }, { tool: 'list_files', ok: true }]) {
      const guard = new LoopGuard({ windowThreshold: 1000 });
      expect(kinds(feed(guard, [...fails(2), between, ...fails(3)]))).toEqual([null, null, null, null, null, 'steer']);
    }
  });

  it('does not join old runs when a different call succeeds', () => {
    const guard = new LoopGuard({ windowThreshold: 1000 });
    expect(kinds(feed(guard, [{}, write, {}, { ...write, ok: true }, {}]))).toEqual(fails(5).map(() => null));
  });

  it('excludes failures exactly ten minutes old from the window', () => {
    const guard = new LoopGuard();
    for (let i = 0; i < 4; i++) {
      expect(guard.record(outcome({ at: T0 + i * 2 * MINUTE }))).toBeNull();
      guard.record(outcome({ tool: 'list_files', ok: true, at: T0 + i * 2 * MINUTE + 1 }));
    }
    expect(guard.record(outcome({ at: T0 + 10 * MINUTE }))).toBeNull();
    guard.record(outcome({ tool: 'list_files', ok: true, at: T0 + 10 * MINUTE + 1 }));
    expect(guard.record(outcome({ at: T0 + 10 * MINUTE + 2 }))?.kind).toBe('steer');
  });

  it('uses custom thresholds and a custom window duration', () => {
    const consecutive = new LoopGuard({ consecutiveThreshold: 2 });
    expect(kinds(feed(consecutive, fails(2)))).toEqual([null, 'steer']);
    const window = new LoopGuard({ consecutiveThreshold: 1000, windowThreshold: 2, windowMs: MINUTE });
    expect(window.record(outcome())).toBeNull();
    window.record(outcome({ tool: 'list_files', ok: true, at: T0 + 1 }));
    expect(window.record(outcome({ at: T0 + MINUTE }))).toBeNull();
    window.record(outcome({ tool: 'list_files', ok: true, at: T0 + MINUTE + 1 }));
    expect(window.record(outcome({ at: T0 + MINUTE + 2 }))?.kind).toBe('steer');
  });

  it('does not match a single signature or three distinct signatures as alternating pairs', () => {
    for (const tools of [
      ['read_file', 'read_file', 'read_file', 'read_file', 'read_file', 'read_file'],
      ['read_file', 'write_file', 'read_file', 'list_files', 'read_file', 'write_file'],
    ]) {
      const guard = new LoopGuard({ consecutiveThreshold: 1000, windowThreshold: 1000 });
      expect(kinds(feed(guard, tools.map((tool) => ({ tool }))))).toEqual(fails(6).map(() => null));
    }
  });

  it('requires fresh alternating pairs after a steer, even when their order reverses', () => {
    const guard = new LoopGuard();
    expect(kinds(feed(guard, [...swing(3), write, read, write, read, write, read]))).toEqual([
      null, null, null, null, null, 'steer',
      null, null, null, null, null, 'stop',
    ]);
  });

  it('breaks alternating pairs on a successful unrelated call', () => {
    const guard = new LoopGuard();
    expect(kinds(feed(guard, [...swing(2), { tool: 'list_files', ok: true }, read, write]))).toEqual(fails(7).map(() => null));
  });

  it('consumes a window trip and stops only after a fresh window trip', () => {
    const guard = new LoopGuard();
    for (let trip = 0; trip < 2; trip++) {
      const calls = Array.from({ length: 5 }, () => [{}, { tool: 'list_files', ok: true }]).flat();
      expect(kinds(feed(guard, calls, SECOND, T0 + trip * MINUTE))).toEqual([
        null, null, null, null, null, null, null, null, trip === 0 ? 'steer' : 'stop', null,
      ]);
    }
  });

  it('resets window counts and escalation for every error class of a successful call', () => {
    const guard = new LoopGuard();
    for (const errorText of ['Permission denied', 'File missing']) {
      expect(kinds(feed(guard, fails(3, { errorClass: errorClass(errorText) })))).toEqual([null, null, 'steer']);
    }
    guard.record(outcome({ ok: true, argsHash: canonicalArgsHash(` { "offset": 1, "path": "/home/me/project/app.ts" } `) }));
    for (const errorText of ['Permission denied', 'File missing']) {
      expect(kinds(feed(guard, fails(3, { errorClass: errorClass(errorText) })))).toEqual([null, null, 'steer']);
    }

    const window = new LoopGuard({ consecutiveThreshold: 1000, windowThreshold: 2 });
    window.record(outcome());
    window.record(outcome({ errorClass: errorClass('File missing') }));
    window.record(outcome({ ok: true }));
    expect(window.record(outcome())).toBeNull();
    expect(window.record(outcome({ errorClass: errorClass('File missing') }))).toBeNull();
  });

  it('keeps escalation independent for different error classes', () => {
    const guard = new LoopGuard();
    for (const [errorText, kind] of [['Permission denied', 'steer'], ['File missing', 'steer'], ['Permission denied', 'stop']]) {
      expect(kinds(feed(guard, fails(3, { errorClass: errorClass(errorText) })))).toEqual([null, null, kind]);
    }
  });

  it.each([{ tool: 'write_file' }, { argsHash: argsFor('/home/me/other.txt') }])('does not reset another call on success: %j', (other) => {
    const guard = new LoopGuard({ consecutiveThreshold: 1000, windowThreshold: 2 });
    guard.record(outcome());
    guard.record(outcome({ ...other, ok: true }));
    expect(guard.record(outcome())?.kind).toBe('steer');
  });

  it('keeps active agents and their escalation when idle agents are swept', () => {
    const guard = new LoopGuard();
    feed(guard, fails(3), 0);
    feed(guard, fails(3, { agentId: 'agent-two' }), 0);
    guard.record(outcome({ agentId: 'agent-two', tool: 'list_files', ok: true, at: T0 + FORGET_AFTER_MS - 1 }));
    guard.sweep(T0 + FORGET_AFTER_MS);
    expect(kinds(feed(guard, fails(3, { agentId: 'agent-two' }), SECOND, T0 + FORGET_AFTER_MS))).toEqual([null, null, 'stop']);
    expect(kinds(feed(guard, fails(3), SECOND, T0 + FORGET_AFTER_MS))).toEqual([null, null, 'steer']);
  });

  it('keeps the latest activity time when an older outcome arrives late', () => {
    const guard = new LoopGuard({ consecutiveThreshold: 1000, windowThreshold: 3 });
    feed(guard, fails(2), 1, T0 + FORGET_AFTER_MS - 2);
    guard.record(outcome({ tool: 'list_files', ok: true }));
    guard.sweep(T0 + FORGET_AFTER_MS);
    expect(guard.record(outcome({ at: T0 + FORGET_AFTER_MS }))?.kind).toBe('steer');
  });
});

describe('simple error classes', () => {
  const normalised = errorClass;

  it.each([
    ['Error 12 at 345', 'error <value> at <value>'],
    ['Error at app.ts:12:5', 'error at app.ts:<value>:<value>'],
    ['Exit -12 after +34.56 seconds', 'exit -<value> after +<value>.<value> seconds'],
    ['Job deadbeef failed', 'job <value> failed'],
    ['Job ABCDEF123456 failed', 'job <value> failed'],
    ['Socket 0xDEADBEEF reset', 'socket <value> reset'],
    ['Job 12345678 failed', 'job <value> failed'],
    ['Job abcdef1 or 0xabcdef1 failed', 'job abcdef1 or 0xabcdef1 failed'],
    ['Job prefix_deadbeef or deadbeef_suffix failed', 'job prefix_deadbeef or deadbeef_suffix failed'],
    ['TS2304 E1234 SQLSTATE_23505', 'ts2304 e1234 sqlstate_23505'],
    ['  ENOENT:\t open \'src/a.ts\'  ', '  enoent:\t open \'src/a.ts\'  '],
  ])('only replaces numeric tokens and long hex ids: %s', (text, expected) => {
    expect(normalised(text)).toBe(expected);
  });

  it.each(['\n', '\r\n', '\r'])('uses only the first line: %j', (newline) => {
    expect(normalised(`Failure 12${newline}at /home/me/project/a.ts:7`)).toBe('failure <value>');
    expect(errorClass(`FAILURE 12${newline}first detail`)).toBe(errorClass(`Failure 99${newline}second detail`));
    expect(normalised(`${newline}Failure 12`)).toBe('');
    expect(kinds(feed(new LoopGuard(), [12, 99, 3].map((line) => ({ errorClass: errorClass(`Failure ${line}${newline}detail ${line}`) }))))).toEqual([
      null, null, 'steer',
    ]);
  });

  it.each([
    'ENOENT: open "src/a.ts"',
    "ENOENT: open 'alpha project/README'",
    String.raw`ENOENT: open "C:\new\test.ts"`,
    String.raw`ENOENT: open "D:\test\new.ts"`,
    String.raw`ENOENT: open "E:\test\test.ts"`,
    JSON.stringify({ message: String.raw`ENOENT: open "C:\new\test.ts"` }),
    JSON.stringify({ message: String.raw`ENOENT: open "D:\test\new.ts"` }),
    JSON.stringify({ message: String.raw`ENOENT: open "E:\test\test.ts"` }),
    String.raw`ENOENT: open "src/one\"a.ts"`,
  ])('keeps paths, quotes and backslashes as literal text: %s', (text) => {
    expect(normalised(text)).toBe(text.toLowerCase());
  });

  it.each([
    ['/tmp/a.ts', '/home/me/b.ts', 'src/c.ts'],
    ['alpha project/README', 'beta project/LICENSE', 'gamma project/Makefile'],
  ])('counts failures with different paths as different signatures: %s', (...paths) => {
    const errors = paths.map((path) => `ENOENT: open '${path}'`);
    expect(new Set(errors.map(errorClass)).size).toBe(paths.length);
    expect(kinds(feed(new LoopGuard(), [...errors, ...errors].map((errorText) => ({ errorClass: errorClass(errorText) }))))).toEqual([
      null, null, null, null, null, null,
    ]);
    expect(kinds(feed(new LoopGuard(), fails(6, { errorClass: errorClass(errors[0]) })))).toEqual([
      null, null, 'steer', null, null, 'stop',
    ]);
  });

  it.each([
    (code: string) => JSON.stringify({ message: `/tmp/a.ts:${code}` }),
    (code: string) => `ENOENT: open "src/a.ts:${code}"`,
    (code: string) => `src/a.ts:12:5: error ${code}: Failed`,
  ])('keeps error codes attached to paths distinct: %#', (diagnostic) => {
    for (const codes of [
      ['ENOENT', 'EACCES', 'EIO', 'ENOSPC', 'EROFS', 'EBUSY'],
      ['TS2304', 'TS2345', 'TS2322', 'TS2554', 'TS2339', 'TS1005'],
    ]) {
      const errors = codes.map(diagnostic);
      expect(new Set(errors.map(errorClass)).size).toBe(codes.length);
      expect(kinds(feed(new LoopGuard(), errors.map((errorText) => ({ errorClass: errorClass(errorText) })))).every((kind) => kind === null)).toBe(true);
      for (const [i, code] of codes.entries()) expect(normalised(errors[i]!)).toContain(code.toLowerCase());
    }
  });

  it('matches changing numbers and long hex ids without removing other text', () => {
    const errors = [
      'Request deadbeef failed at /home/me/app.ts:12:5',
      'REQUEST ABCDEF123456 FAILED AT /home/me/app.ts:98:45',
      'Request 0x12345678 failed at /home/me/app.ts:7:1',
    ];
    expect(new Set(errors.map(errorClass)).size).toBe(1);
    expect(kinds(feed(new LoopGuard(), [...errors, ...errors].map((errorText) => ({ errorClass: errorClass(errorText) }))))).toEqual([
      null, null, 'steer', null, null, 'stop',
    ]);
  });

  it('preserves spacing, quotes, punctuation and short ids', () => {
    for (const [first, second] of [
      ['Error: failed', 'Error:  failed'],
      ['Error: failed', ' Error: failed'],
      ['Error: failed', 'Error: failed '],
      ['Error: failed', 'Error:\tfailed'],
      ["ENOENT: open 'src/a.ts'", 'ENOENT: open "src/a.ts"'],
      ['Exit +12', 'Exit -12'],
      ['Job abcdef1 failed', 'Job abcdef2 failed'],
    ]) expect(errorClass(first!)).not.toBe(errorClass(second!));
  });

  it('preserves the complete first line of a long error', () => {
    const prefix = 'failed '.repeat(10_000);
    expect(normalised(`${prefix}ENOENT`)).toBe(`${prefix}enoent`);
    expect(errorClass(`${prefix}ENOENT`)).not.toBe(errorClass(`${prefix}EACCES`));
  });

  it('matches absent and empty errors while retaining whitespace', () => {
    expect(callSignature(outcome({ errorClass: errorClass() }))).toBe(callSignature(outcome({ errorClass: errorClass('') })));
    expect(errorClass(' ')).not.toBe(errorClass(''));
    expect(kinds(feed(new LoopGuard(), [{ errorClass: errorClass() }, { errorClass: errorClass('') }, { errorClass: errorClass() }]))).toEqual([null, null, 'steer']);
  });
});

describe('argument edge cases', () => {
  it('canonicalises nested keys and preserves string whitespace, value types and special keys', () => {
    expect(canonicalArgsHash('{"z":[{"b":2,"a":1}],"a":true}')).toBe(canonicalArgsHash(' { "a": true, "z": [ { "a": 1, "b": 2 } ] } '));
    for (const [first, second] of [
      ['{"text":"a b"}', '{"text":"ab"}'],
      ['{"n":1}', '{"n":"1"}'],
      ['{"__proto__":{"a":1}}', '{}'],
    ]) expect(canonicalArgsHash(first!)).not.toBe(canonicalArgsHash(second!));
    expect(canonicalArgsHash('{"__proto__":{"b":2,"a":1},"x":0}')).toBe(canonicalArgsHash('{"x":0,"__proto__":{"a":1,"b":2}}'));
  });

  it.each(['null', 'true', '42', '"hello"', '[]', '{}'])('accepts a JSON root value: %s', (argsJson) => {
    expect(canonicalArgsHash(argsJson)).toBe(canonicalArgsHash(` ${argsJson}\n`));
  });
});
