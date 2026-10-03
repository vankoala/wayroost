// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { PairPage } from './PairPage';

// The pairing page takes its code from the URL fragment. These check that it
// takes every fragment it's given, not just the first one the document saw.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CODE_A = 'a'.repeat(26);
const CODE_B = 'b'.repeat(26);

let root: Root | null = null;
let host: HTMLElement | null = null;
let pair: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Refused every time, so the page never navigates away (jsdom can't).
  pair = vi.spyOn(api, 'pair').mockRejectedValue(new Error("That pairing code isn't valid any more."));
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
  history.replaceState(null, '', '/');
});

function mount(): void {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(createElement(PairPage)));
}

function unmount(): void {
  act(() => root!.unmount());
  root = null;
}

/** A link opened while the page is up: only the fragment changes. */
function openLink(fragment: string): void {
  act(() => {
    history.replaceState(null, '', `/pair#${fragment}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

async function submit(): Promise<void> {
  await act(async () => {
    host!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

const codeInput = () => host!.querySelector('input[autocomplete="one-time-code"]');
const errorText = () => host!.querySelector('[role="alert"]')?.textContent ?? null;

describe('PairPage', () => {
  it("takes the link's code out of the address bar and pairs with it", async () => {
    history.replaceState(null, '', `/pair#${CODE_A}`);
    mount();
    expect(location.hash).toBe('');
    expect(codeInput()).toBeNull();
    await submit();
    expect(pair).toHaveBeenLastCalledWith(CODE_A, expect.any(String));
  });

  it("replaces an expired link's code with a newer link's", async () => {
    history.replaceState(null, '', `/pair#${CODE_A}`);
    mount();
    await submit();
    expect(errorText()).toMatch(/isn't valid/);
    openLink(CODE_B);
    expect(location.hash).toBe('');
    expect(errorText()).toBeNull();
    await submit();
    expect(pair).toHaveBeenLastCalledWith(CODE_B, expect.any(String));
  });

  it('takes a link opened after the page asked for a typed code', async () => {
    history.replaceState(null, '', '/pair');
    mount();
    expect(codeInput()).not.toBeNull();
    openLink(CODE_A);
    expect(location.hash).toBe('');
    expect(codeInput()).toBeNull();
    await submit();
    expect(pair).toHaveBeenLastCalledWith(CODE_A, expect.any(String));
  });

  it('reads the fragment afresh when it mounts again', async () => {
    history.replaceState(null, '', `/pair#${CODE_A}`);
    mount();
    unmount();
    history.replaceState(null, '', `/pair#${CODE_B}`);
    mount();
    expect(location.hash).toBe('');
    await submit();
    expect(pair).toHaveBeenLastCalledWith(CODE_B, expect.any(String));
  });

  it('scrubs a fragment that is not a code and keeps the code it has', async () => {
    history.replaceState(null, '', `/pair#${CODE_A}`);
    mount();
    openLink('not-a-code');
    expect(location.hash).toBe('');
    await submit();
    expect(pair).toHaveBeenLastCalledWith(CODE_A, expect.any(String));
  });
});
