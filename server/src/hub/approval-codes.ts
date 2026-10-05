import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type ApprovalDecision = 'approve' | 'deny';
export type ApprovalCodeRefusal =
  | 'invalid-code'
  | 'wrong-action'
  | 'wrong-approver'
  | 'wrong-decision'
  | 'unknown-identity'
  | 'identity-unavailable'
  | 'journal-busy'
  | 'used'
  | 'expired'
  | 'locked';

export interface ApprovalCodeEvent {
  type: 'approval-code-attempt' | 'approval-code-locked' | 'approval-code-expired';
  actionId: string;
  approverId: string | null;
  decision: ApprovalDecision | null;
  success: boolean;
  reason: ApprovalCodeRefusal | 'accepted';
  at: number;
  failedAttempts: number;
}

export interface ApprovalCodesOptions<SessionOrDevice> {
  identityOf: (sessionOrDevice: SessionOrDevice) => string | null | undefined;
  record: (event: ApprovalCodeEvent) => void;
  adminCapability: object;
  approvalsRequired?: boolean;
  now?: () => number;
}

export interface IssueApprovalCode<SessionOrDevice> {
  actionId: string;
  sessionOrDevice: SessionOrDevice;
  decisions: readonly ApprovalDecision[];
  ttlMs: number;
}

export interface RedeemApprovalCode<SessionOrDevice> {
  code: string;
  actionId: string;
  sessionOrDevice: SessionOrDevice;
  decision: string;
}

export interface IssuedApprovalCode {
  code: string;
  actionId: string;
  approverId: string;
  expiresAt: number;
}

export interface ApprovalCodeDecision {
  actionId: string;
  approverId: string;
  decision: ApprovalDecision;
}

export type ApprovalCodeResult =
  | ({ ok: true } & ApprovalCodeDecision)
  | { ok: false; reason: ApprovalCodeRefusal };

interface StoredApprovalCode {
  codeHash: Buffer;
  actionId: string;
  approverId: string;
  decisions: readonly ApprovalDecision[];
  expiresAt: number;
  state: 'pending' | 'used' | 'expired';
  failedAttempts: number;
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const CODE_BYTES = 16;
const CODE_TEXT = /(?:[A-Z2-7]{4}-){6}[A-Z2-7]{2}|[A-Z2-7]{26}/i;
const MAX_FAILED_ATTEMPTS = 5;
const sha256 = (code: string) => createHash('sha256').update(code, 'utf8').digest();
const NO_CODE_HASH = sha256('no approval code');

function groupedBase32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let encoded = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += BASE32[(value >>> bits) & 31];
    }
  }
  if (bits) encoded += BASE32[(value << (5 - bits)) & 31];
  return encoded.match(/.{1,4}/g)!.join('-');
}

function decisionOf(decision: string): ApprovalDecision | null {
  return decision === 'approve' || decision === 'deny' ? decision : null;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && !CODE_TEXT.test(value);
}

/** Codes bind a ledger identity to one action; terminal entries prevent reissue and replay. */
export class ApprovalCodes<SessionOrDevice> {
  private readonly codes = new Map<string, StoredApprovalCode>();
  private readonly pendingEvents: ApprovalCodeEvent[] = [];
  private readonly pendingDenials: ApprovalCodeDecision[] = [];
  private readonly identityOf: ApprovalCodesOptions<SessionOrDevice>['identityOf'];
  private readonly record: ApprovalCodesOptions<SessionOrDevice>['record'];
  private readonly now: () => number;
  #adminCapability: object;
  #approvalsRequired: boolean;
  #recording = false;

  constructor(options: ApprovalCodesOptions<SessionOrDevice>) {
    if (!options.adminCapability || typeof options.adminCapability !== 'object') {
      throw new Error('An admin capability is required.');
    }
    if (options.approvalsRequired !== undefined && typeof options.approvalsRequired !== 'boolean') {
      throw new Error('Approvals required must be a boolean.');
    }
    this.identityOf = options.identityOf;
    this.record = options.record;
    this.#adminCapability = options.adminCapability;
    this.now = options.now ?? Date.now;
    this.#approvalsRequired = options.approvalsRequired ?? true;
  }

  get approvalsRequired(): boolean {
    return this.#approvalsRequired;
  }

  setApprovalsRequired(required: boolean, capability: object): void {
    if (capability !== this.#adminCapability) throw new Error('Admin capability required.');
    if (typeof required !== 'boolean') throw new Error('Approvals required must be a boolean.');
    this.#approvalsRequired = required;
  }

  issue(request: IssueApprovalCode<SessionOrDevice>): IssuedApprovalCode {
    if (!isIdentifier(request.actionId)) throw new Error('An action id without approval code text is required.');
    if (this.codes.has(request.actionId)) throw new Error('This action already has an approval code.');
    if (!request.decisions.length || request.decisions.some(decision => decisionOf(decision) === null)) {
      throw new Error('At least one valid decision is required.');
    }
    const expiresAt = this.now() + request.ttlMs;
    if (!Number.isSafeInteger(request.ttlMs) || request.ttlMs <= 0 || !Number.isSafeInteger(expiresAt)) {
      throw new Error('A positive finite lifetime is required.');
    }
    const approverId = this.identityOf(request.sessionOrDevice);
    if (!isIdentifier(approverId)) throw new Error('A ledger identity without approval code text is required.');
    const code = groupedBase32(randomBytes(CODE_BYTES));
    this.codes.set(request.actionId, {
      codeHash: sha256(code),
      actionId: request.actionId,
      approverId,
      decisions: Object.freeze([...request.decisions]),
      expiresAt,
      state: 'pending',
      failedAttempts: 0,
    });
    return { code, actionId: request.actionId, approverId, expiresAt };
  }

  redeem(request: RedeemApprovalCode<SessionOrDevice>): ApprovalCodeResult {
    const at = this.now();
    const hash = sha256(typeof request.code === 'string' ? request.code : '');
    let matching: StoredApprovalCode | undefined;
    // Compare every digest without stopping at a match, including terminal entries.
    for (const stored of this.codes.values()) {
      if (timingSafeEqual(hash, stored.codeHash)) matching = stored;
    }
    if (!this.codes.size) timingSafeEqual(hash, NO_CODE_HASH);

    const action = this.codes.get(request.actionId);
    const target = action ?? matching;
    const decision = decisionOf(request.decision);
    let approverId: string | null = null;
    let identityFailure: ApprovalCodeRefusal | undefined;
    try {
      const identity = this.identityOf(request.sessionOrDevice);
      if (isIdentifier(identity)) approverId = identity;
      else identityFailure = 'unknown-identity';
    } catch {
      identityFailure = 'identity-unavailable';
    }

    let reason: ApprovalCodeRefusal | undefined;
    if (target?.state === 'used') reason = 'used';
    else if (target && (target.state === 'expired' || at >= target.expiresAt)) reason = 'expired';
    else if (target && target.failedAttempts >= MAX_FAILED_ATTEMPTS) reason = 'locked';
    else if (!matching) reason = 'invalid-code';
    else if (matching.actionId !== request.actionId) reason = 'wrong-action';
    else if (identityFailure) reason = identityFailure;
    else if (matching.approverId !== approverId) reason = 'wrong-approver';
    else if (!decision || !matching.decisions.includes(decision)) reason = 'wrong-decision';
    else if (this.#recording) reason = 'journal-busy';

    if (reason) {
      const active = target?.state === 'pending' && at < target.expiresAt;
      const justLocked = active && target.failedAttempts === MAX_FAILED_ATTEMPTS - 1;
      if (active && target.failedAttempts < MAX_FAILED_ATTEMPTS) target.failedAttempts++;
      this.pendingEvents.push({
        type: 'approval-code-attempt', actionId: target?.actionId ?? 'unknown-action', approverId, decision,
        success: false, reason, at, failedAttempts: target?.failedAttempts ?? 0,
      });
      if (justLocked) {
        this.pendingEvents.push({
          type: 'approval-code-locked', actionId: target.actionId, approverId: target.approverId,
          decision: null, success: false, reason: 'locked', at, failedAttempts: target.failedAttempts,
        });
      }
      this.flushEvents();
      return { ok: false, reason };
    }

    const stored = matching!;
    stored.state = 'used';
    const result = { actionId: stored.actionId, approverId: stored.approverId, decision: decision! };
    this.pendingEvents.push({
      type: 'approval-code-attempt', ...result, success: true, reason: 'accepted', at,
      failedAttempts: stored.failedAttempts,
    });
    this.flushEvents();
    return { ok: true, ...result };
  }

  expire(now: number): ApprovalCodeDecision[] {
    if (!Number.isSafeInteger(now)) throw new Error('A finite expiry time is required.');
    for (const stored of this.codes.values()) {
      if (stored.state !== 'pending' || now < stored.expiresAt) continue;
      stored.state = 'expired';
      const result: ApprovalCodeDecision = { actionId: stored.actionId, approverId: stored.approverId, decision: 'deny' };
      this.pendingDenials.push(result);
      this.pendingEvents.push({
        type: 'approval-code-expired', ...result, success: false, reason: 'expired', at: now,
        failedAttempts: stored.failedAttempts,
      });
    }
    if (!this.flushEvents()) return [];
    return this.pendingDenials.splice(0);
  }

  private flushEvents(): boolean {
    if (this.#recording) return false;
    this.#recording = true;
    try {
      // Keep events queued until recording returns, including when callbacks reenter.
      while (this.pendingEvents.length) {
        this.record(this.pendingEvents[0]!);
        this.pendingEvents.shift();
      }
    } finally {
      this.#recording = false;
    }
    return true;
  }
}
