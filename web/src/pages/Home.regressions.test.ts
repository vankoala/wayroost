// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { HomePage } from './Home';

it('distinguishes local storage from cloud-provider processing in the trust banner', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    await act(async () => root.render(h(HomePage, { phone: false, onNewTask: () => {} })));
    const banner = container.querySelector('.trust-banner')!.textContent!;
    expect(banner).toContain('stored on this PC');
    expect(banner).toMatch(/Cloud agents send .*configured providers/);
    expect(banner).not.toContain('Nothing is sent anywhere');
    expect(banner).not.toContain('models stay on this computer');
  } finally {
    await act(async () => root.unmount());
  }
});
