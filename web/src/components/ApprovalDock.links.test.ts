// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Approval } from '../../../shared/protocol';
import { ApprovalDock } from './Approvals';
import { navigate } from '../router';

// A desktop toast's Open loads the chat with #approval-<id>: the dock shows that card first, follows the
// hash as it changes (same chat, in-app links, back and forward), and falls back to the usual order once
// the linked request is answered.

const pending = (id: string, createdAt: number): Approval => ({
  id, source: 'paseo', conversationId: 'demo-agent', kind: 'permission', title: `Demo request ${id}`,
  options: [{ id: 'allow', label: 'Allow', kind: 'allow' }, { id: 'deny', label: 'Deny', kind: 'deny' }], createdAt,
});
const all = [pending('demo-1', 1), pending('demo-2', 2), pending('demo-3', 3)];

let root: Root;
let container: HTMLDivElement;
const shown = () => container.querySelector('.approval-card')?.textContent ?? '';
const render = (approvals: Approval[]) => act(async () => root.render(h(ApprovalDock, { approvals })));
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  history.replaceState(null, '', '/c/paseo/demo-agent');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await render(all);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('approval links in the dock', () => {
  it('shows the oldest request without a link', () => {
    expect(shown()).toContain('Demo request demo-1');
  });

  it('follows a hash change in the same chat', async () => {
    await act(async () => {
      location.hash = '#approval-demo-2';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(shown()).toContain('Demo request demo-2');
  });

  it('follows an in-app link from another page, and back and forward', async () => {
    await act(async () => navigate('/c/paseo/demo-agent#approval-demo-3'));
    expect(shown()).toContain('Demo request demo-3');
    history.back();
    await settle();
    expect(shown()).toContain('Demo request demo-1');
    history.forward();
    await settle();
    expect(shown()).toContain('Demo request demo-3');
  });

  it('falls back to the usual order once the linked request is answered, or for a stale link', async () => {
    await act(async () => navigate('/c/paseo/demo-agent#approval-demo-2'));
    expect(shown()).toContain('Demo request demo-2');
    await render([all[0]!, all[2]!]);
    expect(shown()).toContain('Demo request demo-1');
    await act(async () => navigate('/c/paseo/demo-agent#approval-not-pending'));
    expect(shown()).toContain('Demo request demo-1');
  });
});
