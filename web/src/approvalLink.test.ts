import { describe, expect, it } from 'vitest';
import type { Approval } from '../../shared/protocol';
import { linkedApprovalId, orderForLink } from './approvalLink';

const pending = (id: string, createdAt: number): Approval => ({
  id,
  source: 'paseo',
  conversationId: 'demo-agent',
  kind: 'permission',
  title: `Demo request ${id}`,
  options: [{ id: 'allow', label: 'Allow', kind: 'allow' }],
  createdAt,
});

describe('approval links', () => {
  it('reads the id the desktop app encodes into the fragment', () => {
    expect(linkedApprovalId(`#approval-${encodeURIComponent('demo-req.q0')}`)).toBe('demo-req.q0');
    expect(linkedApprovalId(`#approval-${encodeURIComponent('demo:req@host+1')}`)).toBe('demo:req@host+1');
    for (const hash of ['', '#', '#approval-', '#for-you', '#approval-%E0%A4%A']) expect(linkedApprovalId(hash)).toBeUndefined();
  });

  it('shows the linked approval first, not the oldest', () => {
    const [a, b, c] = [pending('demo-1', 1), pending('demo-2', 2), pending('demo-3', 3)];
    expect(orderForLink([a!, b!, c!], '#approval-demo-2').map((x) => x.id)).toEqual(['demo-2', 'demo-1', 'demo-3']);
    expect(orderForLink([a!, b!, c!], '#approval-demo-3')[0]).toBe(c);
    // No link, a link to the oldest, or one that is no longer pending: the usual oldest-first order.
    for (const hash of ['', '#approval-demo-1', '#approval-demo-9', '#for-you']) expect(orderForLink([a!, b!, c!], hash)).toEqual([a, b, c]);
  });
});
