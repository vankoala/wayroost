import { Menu, Tray, nativeImage } from 'electron';
import type { SupervisorStatus } from '../../shared/supervisor.js';
import { trayState } from './tray-state.js';
export interface NeedItem { label: string; open(): void }
export function createTray(markPath: string, open: () => void, quit: () => void, setup: () => void) {
  const mark = nativeImage.createFromPath(markPath).resize({ width: 32, height: 32 });
  const tray = new Tray(mark);
  tray.on('double-click', open);
  return { tray, update(status: SupervisorStatus, needs: NeedItem[]) {
    const state = trayState(status, needs.length);
    const bitmap = Buffer.from(mark.toBitmap());
    if (state.badge) {
      const rgb = state.color.slice(1).match(/../g)!.map((hex) => parseInt(hex, 16));
      for (let y = 20; y < 32; y++) for (let x = 20; x < 32; x++) {
        if ((x - 25.5) ** 2 + (y - 25.5) ** 2 > 36) continue;
        const i = (y * 32 + x) * 4;
        const glyph = state.badge === '×' ? Math.abs(x - y) <= 1 || Math.abs(x + y - 51) <= 1 : x >= 25 && x <= 26 && (y <= 26 || y >= 29);
        bitmap[i] = glyph ? 243 : rgb[2]!; bitmap[i + 1] = glyph ? 250 : rgb[1]!;
        bitmap[i + 2] = glyph ? 255 : rgb[0]!; bitmap[i + 3] = 255;
      }
    }
    tray.setImage(nativeImage.createFromBitmap(bitmap, { width: 32, height: 32 }));
    tray.setToolTip(`Wayroost · ${state.sentence}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: state.sentence, enabled: false }, { label: 'Open Wayroost', click: open },
      { label: 'Set up recovery', click: setup },
      ...needs.slice(0, 3).map((item) => ({ label: item.label, click: item.open })),
      { type: 'separator' }, { label: 'Pause all agents', enabled: false }, { label: 'Quit', click: quit },
    ]));
  } };
}
