import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApprovalCodes,
  type ApprovalCodeEvent,
  type ApprovalDecision,
  type IssueApprovalCode,
  type RedeemApprovalCode,
} from '../src/hub/approval-codes.js';

vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    randomBytes: vi.fn(actual.randomBytes),
    timingSafeEqual: vi.fn(actual.timingSafeEqual),
  };
});

interface Session {
  deviceId: string;
}

const APPROVER: Session = { deviceId: 'device-example-1' };
const OTHER: Session = { deviceId: 'device-example-2' };
const UNKNOWN: Session = { deviceId: 'device-example-unknown' };
const ACTION = 'action-example-1';
const IDENTITY = 'approver-example-1';

function fixture(options: { approvalsRequired?: boolean; record?: (event: ApprovalCodeEvent) => void } = {}) {
  let time = 1_000;
  const events: ApprovalCodeEvent[] = [];
  const ledger = new Map<Session, string>([[APPROVER, IDENTITY], [OTHER, 'approver-example-2']]);
  const identityOf = vi.fn((session: Session) => ledger.get(session));
  const adminCapability = Object.freeze({});
  const hub = new ApprovalCodes({
    identityOf,
    record: event => { options.record?.(event); events.push(event); },
    adminCapability,
    ...(options.approvalsRequired === undefined ? {} : { approvalsRequired: options.approvalsRequired }),
    now: () => time,
  });
  const issue = (overrides: Partial<IssueApprovalCode<Session>> = {}) => hub.issue({
    actionId: ACTION, sessionOrDevice: APPROVER, decisions: ['approve', 'deny'], ttlMs: 500, ...overrides,
  });
  const redeem = (code: string, overrides: Partial<RedeemApprovalCode<Session>> = {}) => hub.redeem({
    code, actionId: ACTION, sessionOrDevice: APPROVER, decision: 'approve', ...overrides,
  });
  return { hub, events, ledger, identityOf, adminCapability, issue, redeem, setTime: (now: number) => { time = now; } };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('ApprovalCodes', () => {
  it('issues grouped base32 codes with at least 128 bits from randomBytes', () => {
    const { issue, identityOf } = fixture();
    const issued = issue();
    expect(vi.mocked(randomBytes).mock.calls[0]?.[0]).toBeGreaterThanOrEqual(16);
    expect(issued.code).toMatch(/^(?:[A-Z2-7]{4}-){6}[A-Z2-7]{2}$/);
    expect(issued).toMatchObject({ actionId: ACTION, approverId: IDENTITY, expiresAt: 1_500 });
    expect(identityOf).toHaveBeenCalledWith(APPROVER);
    expect(issue({ actionId: 'action-example-2' }).code).not.toBe(issued.code);
  });

  it.each(['approve', 'deny'] as const)('selects %s at redemption and refuses replay after success', decision => {
    const { issue, redeem, events } = fixture();
    const { code } = issue();
    expect(redeem(code, { decision })).toEqual({ ok: true, actionId: ACTION, approverId: IDENTITY, decision });
    expect(redeem(code, { decision })).toEqual({ ok: false, reason: 'used' });
    expect(redeem(code, { decision: decision === 'approve' ? 'deny' : 'approve' })).toEqual({ ok: false, reason: 'used' });
    expect(events.map(event => [event.success, event.reason])).toEqual([
      [true, 'accepted'], [false, 'used'], [false, 'used'],
    ]);
  });

  it('refuses a valid code for a different action without consuming it', () => {
    const { issue, redeem, events } = fixture();
    const { code } = issue();
    issue({ actionId: 'action-example-2' });
    expect(redeem(code, { actionId: 'action-example-2' })).toEqual({ ok: false, reason: 'wrong-action' });
    expect(events[0]).toMatchObject({ actionId: 'action-example-2', success: false, reason: 'wrong-action' });
    expect(redeem(code).ok).toBe(true);
  });

  it('refuses a different ledger approver even with a claimed approverId', () => {
    const { hub, issue, redeem, events, identityOf } = fixture();
    const { code } = issue();
    const forged = { code, actionId: ACTION, sessionOrDevice: OTHER, decision: 'approve', approverId: IDENTITY };
    expect(hub.redeem(forged)).toEqual({ ok: false, reason: 'wrong-approver' });
    expect(identityOf).toHaveBeenLastCalledWith(OTHER);
    expect(events[0]).toMatchObject({ approverId: 'approver-example-2', reason: 'wrong-approver' });
    expect(redeem(code).ok).toBe(true);
  });

  it('uses the ledger identity when issuing, regardless of a claimed approverId', () => {
    const { hub } = fixture();
    const forged = {
      actionId: ACTION, sessionOrDevice: APPROVER, approverId: 'approver-example-forged',
      decisions: ['approve', 'deny'] as const, ttlMs: 500,
    };
    expect(hub.issue(forged).approverId).toBe(IDENTITY);
  });

  it('refuses identities absent from the ledger and notices revocation before redemption', () => {
    const { issue, redeem, ledger, events } = fixture();
    expect(() => issue({ sessionOrDevice: UNKNOWN })).toThrow('ledger identity');
    const { code } = issue();
    ledger.delete(APPROVER);
    expect(redeem(code)).toEqual({ ok: false, reason: 'unknown-identity' });
    expect(events[0]).toMatchObject({ approverId: null, success: false, reason: 'unknown-identity' });
  });

  it('records a failed attempt when the identity lookup throws, without recording its error', () => {
    const { issue, redeem, identityOf, events } = fixture();
    const { code } = issue();
    identityOf.mockImplementationOnce(() => { throw new Error(code); });
    expect(redeem(code)).toEqual({ ok: false, reason: 'identity-unavailable' });
    expect(events[0]).toMatchObject({ approverId: null, reason: 'identity-unavailable' });
    expect(JSON.stringify(events)).not.toContain(code);
    expect(redeem(code).ok).toBe(true);
  });

  it.each(['approve', 'defer'])('refuses the disallowed decision %s without consuming the code', decision => {
    const { issue, redeem, events } = fixture();
    const { code } = issue({ decisions: ['deny'] });
    expect(redeem(code, { decision })).toEqual({ ok: false, reason: 'wrong-decision' });
    expect(events[0]).toMatchObject({ success: false, reason: 'wrong-decision' });
    expect(redeem(code, { decision: 'deny' }).ok).toBe(true);
  });

  it('copies the allowed decisions so later caller changes cannot widen the binding', () => {
    const { issue, redeem } = fixture();
    const decisions: ApprovalDecision[] = ['deny'];
    const { code } = issue({ decisions });
    decisions.push('approve');
    expect(redeem(code)).toEqual({ ok: false, reason: 'wrong-decision' });
  });

  it('expires unanswered actions once as explicit denies, including approve-only codes', () => {
    const { hub, issue, redeem, setTime, events } = fixture();
    const { code } = issue({ decisions: ['approve'] });
    issue({ actionId: 'action-example-later', ttlMs: 1_000 });
    const used = issue({ actionId: 'action-example-used' });
    expect(redeem(used.code, { actionId: used.actionId }).ok).toBe(true);
    expect(hub.expire(1_499)).toEqual([]);
    setTime(1_500);
    expect(redeem(code)).toEqual({ ok: false, reason: 'expired' });
    expect(hub.expire(1_500)).toEqual([{ actionId: ACTION, approverId: IDENTITY, decision: 'deny' }]);
    expect(hub.expire(1_500)).toEqual([]);
    expect(redeem(code)).toEqual({ ok: false, reason: 'expired' });
    expect(hub.expire(2_000)).toEqual([{ actionId: 'action-example-later', approverId: IDENTITY, decision: 'deny' }]);
    expect(events.filter(event => event.type === 'approval-code-expired')).toHaveLength(2);
    expect(events.find(event => event.type === 'approval-code-expired')).toMatchObject({ decision: 'deny', reason: 'expired' });
  });

  it('accepts a code immediately before expiry', () => {
    const { issue, redeem, setTime, hub } = fixture();
    const { code } = issue();
    setTime(1_499);
    expect(redeem(code).ok).toBe(true);
    expect(hub.expire(1_500)).toEqual([]);
  });

  it('retains an expiry denial and its journal event until recording succeeds', () => {
    const record = vi.fn<(event: ApprovalCodeEvent) => void>()
      .mockImplementationOnce(() => { throw new Error('Journal unavailable.'); });
    const { hub, issue, redeem, events } = fixture({ record });
    const { code } = issue();
    expect(() => hub.expire(1_500)).toThrow('Journal unavailable');
    expect(events).toEqual([]);
    expect(redeem(code)).toEqual({ ok: false, reason: 'expired' });
    expect(hub.expire(1_600)).toEqual([{ actionId: ACTION, approverId: IDENTITY, decision: 'deny' }]);
    expect(hub.expire(1_600)).toEqual([]);
    expect(events.filter(event => event.type === 'approval-code-expired')).toEqual([
      expect.objectContaining({ actionId: ACTION, decision: 'deny', reason: 'expired', at: 1_500 }),
    ]);
  });

  it.each([1, 2, 3])('retains every batch denial when expiry journal write %i fails', failedWrite => {
    let writes = 0;
    const { hub, issue, events } = fixture({ record: () => {
      if (++writes === failedWrite) throw new Error('Journal unavailable.');
    } });
    const actions = [ACTION, 'action-example-2', 'action-example-3'];
    for (const actionId of actions) issue({ actionId });
    issue({ actionId: 'action-example-later', ttlMs: 1_000 });
    expect(() => hub.expire(1_500)).toThrow('Journal unavailable');
    expect(events).toHaveLength(failedWrite - 1);
    expect(hub.expire(1_600)).toEqual(actions.map(actionId => ({ actionId, approverId: IDENTITY, decision: 'deny' })));
    expect(hub.expire(1_600)).toEqual([]);
    expect(events).toEqual(actions.map(actionId => expect.objectContaining({
      type: 'approval-code-expired', actionId, decision: 'deny', at: 1_500,
    })));
    expect(hub.expire(2_000)).toEqual([{ actionId: 'action-example-later', approverId: IDENTITY, decision: 'deny' }]);
  });

  it('delivers expiry denials once when recording calls expire again', () => {
    let retry: () => unknown = () => undefined;
    const { hub, issue, events } = fixture({ record: event => {
      if (event.type === 'approval-code-expired') expect(retry()).toEqual([]);
    } });
    issue();
    retry = () => hub.expire(1_500);
    expect(hub.expire(1_500)).toEqual([{ actionId: ACTION, approverId: IDENTITY, decision: 'deny' }]);
    expect(hub.expire(1_500)).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it('uses timingSafeEqual on all stored SHA-256 hashes for both success and failure', () => {
    const { issue, redeem } = fixture();
    const { code } = issue();
    issue({ actionId: 'action-example-2' });
    expect(redeem('invalid-example-code')).toEqual({ ok: false, reason: 'invalid-code' });
    expect(redeem(code).ok).toBe(true);
    expect(redeem(code)).toEqual({ ok: false, reason: 'used' });
    expect(timingSafeEqual).toHaveBeenCalledTimes(6);
    for (const [presented, stored] of vi.mocked(timingSafeEqual).mock.calls) {
      expect(presented.byteLength).toBe(32);
      expect(stored.byteLength).toBe(32);
    }
    expect(vi.mocked(timingSafeEqual).mock.calls[2]?.[0]).toEqual(createHash('sha256').update(code).digest());
  });

  it('also compares a hash and records a reason when no code has been issued', () => {
    const { redeem, events } = fixture();
    expect(redeem('invalid-example-code')).toEqual({ ok: false, reason: 'invalid-code' });
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
    expect(events).toEqual([expect.objectContaining({ type: 'approval-code-attempt', success: false, reason: 'invalid-code' })]);
  });

  it('stores only a SHA-256 hash and binding and never records caller text containing a code', () => {
    const { hub, issue, redeem, events, identityOf } = fixture();
    const { code } = issue();
    const codes = (hub as unknown as { codes: Map<string, Record<string, unknown>> }).codes;
    const stored = codes.get(ACTION)!;
    expect(Object.keys(stored).sort()).toEqual([
      'actionId', 'approverId', 'codeHash', 'decisions', 'expiresAt', 'failedAttempts', 'state',
    ]);
    expect(stored.codeHash).toEqual(createHash('sha256').update(code).digest());
    expect(inspect(hub, { depth: null })).not.toContain(code);
    expect(redeem(code, { decision: code })).toEqual({ ok: false, reason: 'wrong-decision' });
    expect(redeem(code, { actionId: code })).toEqual({ ok: false, reason: 'wrong-action' });
    expect(redeem(code, { actionId: `action-example-${code}` })).toEqual({ ok: false, reason: 'wrong-action' });
    expect(redeem(code, { sessionOrDevice: { deviceId: code } })).toEqual({ ok: false, reason: 'unknown-identity' });
    expect(redeem(code).ok).toBe(true);
    expect(JSON.stringify(events)).not.toContain(code);
    expect(JSON.stringify(events)).not.toContain(code.replaceAll('-', ''));
    expect(events[0]?.decision).toBeNull();
    expect(events.every(event => event.actionId === ACTION)).toBe(true);
    identityOf.mockClear();
    expect(inspect(hub, { depth: null })).not.toContain(code);
    expect(events.every(event => !('code' in event) && !('codeHash' in event))).toBe(true);
  });

  it('omits unknown action text from attempt events when no code matches', () => {
    const { hub, redeem, events } = fixture();
    const code = 'ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ';
    expect(redeem(code, { actionId: code })).toEqual({ ok: false, reason: 'invalid-code' });
    expect(redeem(code, { actionId: `action-example-${code}` })).toEqual({ ok: false, reason: 'invalid-code' });
    expect(events).toEqual([
      expect.objectContaining({ actionId: 'unknown-action', reason: 'invalid-code' }),
      expect.objectContaining({ actionId: 'unknown-action', reason: 'invalid-code' }),
    ]);
    expect(JSON.stringify(events)).not.toContain(code);
    expect(inspect(hub, { depth: null })).not.toContain(code);
  });

  it('keeps caller code text out of queued audit events during a journal outage', () => {
    const record = vi.fn<(event: ApprovalCodeEvent) => void>()
      .mockImplementationOnce(() => { throw new Error('Journal unavailable.'); });
    const { hub, issue, redeem, events } = fixture({ record });
    const { code } = issue();
    expect(() => redeem(code, { actionId: code })).toThrow('Journal unavailable');
    expect(inspect(hub, { depth: null })).not.toContain(code);
    expect(redeem(code).ok).toBe(true);
    expect(events[0]).toMatchObject({ actionId: ACTION, reason: 'wrong-action' });
    expect(JSON.stringify(events)).not.toContain(code);
  });

  it.each(['grouped', 'compact', 'lowercase'] as const)(
    'rejects an action binding containing another action\'s %s code before storing it', format => {
      const { hub, issue, redeem, events, identityOf } = fixture();
      const { code } = issue();
      const text = format === 'compact' ? code.replaceAll('-', '') : format === 'lowercase' ? code.toLowerCase() : code;
      const actionId = `action-example-${text}`;
      expect(() => issue({ actionId })).toThrow('action id');
      expect(redeem(code, { actionId })).toEqual({ ok: false, reason: 'wrong-action' });
      expect(events[0]).toMatchObject({ actionId: ACTION, reason: 'wrong-action' });
      issue({ actionId: 'action-example-2' });
      expect(redeem(code).ok).toBe(true);
      identityOf.mockClear();
      expect(inspect(hub, { depth: null })).not.toContain(text);
      expect(JSON.stringify(events)).not.toContain(text);
    },
  );

  it('rejects code-bearing ledger identities before storing or recording them', () => {
    const { hub, issue, redeem, ledger, events, identityOf } = fixture();
    const { code } = issue();
    ledger.set(OTHER, `approver-example-${code}`);
    expect(() => issue({ actionId: 'action-example-2', sessionOrDevice: OTHER })).toThrow('ledger identity');
    expect(redeem(code, { sessionOrDevice: OTHER })).toEqual({ ok: false, reason: 'unknown-identity' });
    expect(events[0]).toMatchObject({ approverId: null, reason: 'unknown-identity' });
    expect(redeem(code).ok).toBe(true);
    identityOf.mockClear();
    expect(inspect(hub, { depth: null })).not.toContain(code);
    expect(JSON.stringify(events)).not.toContain(code);
  });

  it('keeps enforcement enabled despite env vars, working directory, request body and headers', () => {
    vi.stubEnv('APPROVALS_REQUIRED', 'false');
    vi.stubEnv('WAYROOST_APPROVALS_REQUIRED', 'false');
    vi.stubEnv('APPROVALS_OFF', 'true');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/home/me');
    const { hub, issue } = fixture();
    const { code } = issue();
    const forged = {
      code: 'invalid-example-code', actionId: ACTION, sessionOrDevice: APPROVER, decision: 'approve',
      approvalsRequired: false, body: { approvalsRequired: false }, headers: { 'x-approvals-required': 'false' },
    };
    expect(hub.approvalsRequired).toBe(true);
    expect(hub.redeem(forged)).toEqual({ ok: false, reason: 'invalid-code' });
    expect(hub.approvalsRequired).toBe(true);
    expect(() => Object.assign(hub, { approvalsRequired: false })).toThrow();
    expect(cwd).not.toHaveBeenCalled();
    expect(hub.redeem({ ...forged, code, decision: 'deny' })).toMatchObject({ ok: true, decision: 'deny' });
  });

  it('sets enforcement only at construction or with the exact injected admin capability', () => {
    const { hub, adminCapability } = fixture({ approvalsRequired: false });
    expect(hub.approvalsRequired).toBe(false);
    expect(() => hub.setApprovalsRequired(true, {})).toThrow('Admin capability');
    expect(hub.approvalsRequired).toBe(false);
    hub.setApprovalsRequired(true, adminCapability);
    expect(hub.approvalsRequired).toBe(true);
    expect(() => hub.setApprovalsRequired(false, { admin: true })).toThrow('Admin capability');
    expect(hub.approvalsRequired).toBe(true);
    hub.setApprovalsRequired(false, adminCapability);
    expect(hub.approvalsRequired).toBe(false);
  });

  it('locks an action after five failed guesses, records the lock, and preserves other actions', () => {
    const { hub, issue, redeem, events } = fixture();
    const { code } = issue();
    const other = issue({ actionId: 'action-example-2' });
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(redeem(`invalid-example-${attempt}`)).toEqual({ ok: false, reason: 'invalid-code' });
      expect(events.filter(event => event.type === 'approval-code-attempt').at(-1)?.failedAttempts).toBe(attempt);
      expect(events.filter(event => event.type === 'approval-code-locked')).toHaveLength(attempt === 5 ? 1 : 0);
    }
    expect(events.at(-1)).toMatchObject({ type: 'approval-code-locked', actionId: ACTION, reason: 'locked', failedAttempts: 5 });
    expect(redeem(code)).toEqual({ ok: false, reason: 'locked' });
    expect(redeem('invalid-example-again')).toEqual({ ok: false, reason: 'locked' });
    expect(redeem(other.code, { actionId: other.actionId }).ok).toBe(true);
    expect(() => issue()).toThrow('already has');
    expect(hub.expire(1_500)).toEqual([{ actionId: ACTION, approverId: IDENTITY, decision: 'deny' }]);
    expect(events.filter(event => event.type === 'approval-code-locked')).toHaveLength(1);
    expect(events.filter(event => event.type === 'approval-code-attempt')).toHaveLength(8);
  });

  it('counts binding and identity failures toward the same action lock', () => {
    const { issue, redeem, events } = fixture();
    const { code } = issue({ decisions: ['deny'] });
    expect(redeem(code, { sessionOrDevice: OTHER }).ok).toBe(false);
    expect(redeem(code, { sessionOrDevice: UNKNOWN }).ok).toBe(false);
    expect(redeem(code, { decision: 'approve' }).ok).toBe(false);
    expect(redeem(code, { actionId: 'action-example-missing' }).ok).toBe(false);
    expect(redeem('invalid-example-code').ok).toBe(false);
    expect(redeem(code, { decision: 'deny' })).toEqual({ ok: false, reason: 'locked' });
    expect(events.filter(event => event.type === 'approval-code-locked')).toHaveLength(1);
  });

  it.each(['approval-code-attempt', 'approval-code-locked'] as const)(
    'retains the lock event when the fifth failure cannot record %s', failedType => {
      let unavailable = true;
      const { hub, issue, redeem, events, setTime } = fixture({ record: event => {
        if (unavailable && event.type === failedType && event.failedAttempts === 5) {
          throw new Error('Journal unavailable.');
        }
      } });
      const { code } = issue();
      for (let attempt = 1; attempt < 5; attempt++) {
        expect(redeem(`invalid-example-${attempt}`)).toEqual({ ok: false, reason: 'invalid-code' });
      }
      expect(() => redeem('invalid-example-5')).toThrow('Journal unavailable');
      expect(events.filter(event => event.type === 'approval-code-locked')).toHaveLength(0);
      unavailable = false;
      setTime(1_100);
      expect(redeem(code)).toEqual({ ok: false, reason: 'locked' });
      expect(events.filter(event => event.type === 'approval-code-attempt').map(event => event.failedAttempts))
        .toEqual([1, 2, 3, 4, 5, 5]);
      expect(events[4]).toMatchObject({ type: 'approval-code-attempt', reason: 'invalid-code', at: 1_000 });
      expect(events[5]).toMatchObject({ type: 'approval-code-locked', reason: 'locked', at: 1_000, failedAttempts: 5 });
      expect(events[6]).toMatchObject({ type: 'approval-code-attempt', reason: 'locked', at: 1_100 });
      expect(hub.expire(1_500)).toEqual([{ actionId: ACTION, approverId: IDENTITY, decision: 'deny' }]);
      expect(events.filter(event => event.type === 'approval-code-locked')).toHaveLength(1);
    },
  );

  it('consumes the code before invoking a reentrant journal callback', () => {
    let replay: unknown;
    let retry: () => unknown = () => undefined;
    const { issue, redeem } = fixture({ record: event => { if (event.success) replay = retry(); } });
    const { code } = issue();
    retry = () => redeem(code);
    expect(redeem(code).ok).toBe(true);
    expect(replay).toEqual({ ok: false, reason: 'used' });
  });

  it.each([false, true])('refuses a reentrant redemption before consuming its code when the journal throws: %s', throws => {
    let nested: unknown;
    let retry: () => unknown = () => undefined;
    let reentered = false;
    const { hub, issue, redeem, events } = fixture({ record: event => {
      if (event.actionId !== ACTION || !event.success || reentered) return;
      reentered = true;
      nested = retry();
      expect(events.filter(recorded => recorded.success)).toEqual([]);
      if (throws) throw new Error('Journal unavailable.');
    } });
    const first = issue();
    const second = issue({ actionId: 'action-example-2' });
    retry = () => redeem(second.code, { actionId: second.actionId });
    if (throws) expect(() => redeem(first.code)).toThrow('Journal unavailable');
    else expect(redeem(first.code).ok).toBe(true);
    expect(nested).toEqual({ ok: false, reason: 'journal-busy' });
    expect(events.filter(event => event.actionId === second.actionId && event.success)).toEqual([]);
    expect(inspect(hub, { depth: null })).not.toContain(second.code);
    expect(redeem(second.code, { actionId: second.actionId })).toEqual({
      ok: true, actionId: second.actionId, approverId: IDENTITY, decision: 'approve',
    });
    expect(events.map(event => [event.actionId, event.reason, event.failedAttempts])).toEqual([
      [ACTION, 'accepted', 0], [second.actionId, 'journal-busy', 1], [second.actionId, 'accepted', 1],
    ]);
    expect(redeem(second.code, { actionId: second.actionId })).toEqual({ ok: false, reason: 'used' });
  });

  it('keeps a consumed code unusable if the journal callback throws', () => {
    let unavailable = true;
    const { issue, redeem, events } = fixture({ record: event => {
      if (unavailable && event.success) throw new Error('Journal unavailable.');
    } });
    const { code } = issue();
    expect(() => redeem(code)).toThrow('Journal unavailable');
    expect(() => redeem(code)).toThrow('Journal unavailable');
    unavailable = false;
    expect(redeem(code)).toEqual({ ok: false, reason: 'used' });
    expect(events.map(event => event.reason)).toEqual(['accepted', 'used', 'used']);
  });

  it('refuses duplicate actions after success or expiry so state cannot be reset', () => {
    const { hub, issue, redeem } = fixture();
    const { code } = issue();
    expect(() => issue()).toThrow('already has');
    expect(redeem(code).ok).toBe(true);
    expect(() => issue()).toThrow('already has');
    issue({ actionId: 'action-example-expired' });
    hub.expire(1_500);
    expect(() => issue({ actionId: 'action-example-expired' })).toThrow('already has');
  });

  it.each([0, -1, Infinity, NaN, 0.5, Number.MAX_SAFE_INTEGER])('refuses the invalid lifetime %s', ttlMs => {
    expect(() => fixture().issue({ ttlMs })).toThrow('lifetime');
  });

  it('refuses empty or unsupported decision sets and invalid expiry times', () => {
    const { hub, issue } = fixture();
    expect(() => issue({ decisions: [] })).toThrow('valid decision');
    expect(() => issue({ decisions: ['defer' as ApprovalDecision] })).toThrow('valid decision');
    expect(() => issue({ actionId: ' ' })).toThrow('action id');
    expect(() => hub.expire(Infinity)).toThrow('expiry time');
  });
});
