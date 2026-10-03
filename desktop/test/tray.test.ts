import { afterEach, expect, it, vi } from 'vitest';
import type { SupervisorStatus } from '../../shared/supervisor.js';

const mocks = vi.hoisted(() => {
  const mark = { resize: vi.fn(), toBitmap: () => Buffer.alloc(32 * 32 * 4) };
  mark.resize.mockReturnValue(mark);
  return { mark, menu: { buildFromTemplate: vi.fn() }, tray: { on: vi.fn(), setImage: vi.fn(), setToolTip: vi.fn(), setContextMenu: vi.fn() } };
});
vi.mock('electron', () => ({
  Menu: mocks.menu, Tray: class { constructor() { return mocks.tray; } },
  nativeImage: { createFromPath: () => mocks.mark, createFromBitmap: vi.fn() },
}));
import { createTray } from '../src/tray.js';

afterEach(() => { vi.clearAllMocks(); });

it('keeps recovery setup available across tray refreshes alongside app and approval actions', () => {
  const open = vi.fn(); const quit = vi.fn(); const setup = vi.fn(); const approval = vi.fn();
  const tray = createTray('demo-mark.png', open, quit, setup);
  const status: SupervisorStatus = { overall: 'ok', sentence: 'Demo is running.', components: [], at: 0 };
  for (const overall of ['ok', 'attention', 'down'] as const) {
    tray.update({ ...status, overall }, [{ label: 'Demo approval', open: approval }]);
    const menu = mocks.menu.buildFromTemplate.mock.calls.at(-1)![0] as Array<{ label?: string; enabled?: boolean; click?: () => void }>;
    for (const label of ['Open Wayroost', 'Set up recovery', 'Demo approval', 'Quit']) {
      const item = menu.find(item => item.label === label);
      expect(item).toBeDefined(); expect(item!.enabled).not.toBe(false); expect(item!.click).toBeTypeOf('function'); item!.click!();
    }
  }
  for (const action of [open, quit, setup, approval]) expect(action).toHaveBeenCalledTimes(3);
});
