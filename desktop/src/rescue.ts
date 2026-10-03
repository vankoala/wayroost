import { ipcRenderer } from 'electron';
// 'down': the server isn't answering. 'setup': first run, saving the rescue key while the app works.
const MODES = {
  down: ['Wayroost can’t be reached', 'The server isn’t answering. Check its status below, then restart Wayroost.'],
  setup: ['Set up recovery', 'Save the rescue key so this desktop can check on Wayroost and restart it if the server stops answering.'],
} as const;
let mode: keyof typeof MODES = 'down';
const request = async (action: string) => {
  const result = await ipcRenderer.invoke('rescue:request', action) as { sentence: string };
  document.getElementById('status')!.textContent = result.sentence;
};
const render = () => {
  const title = document.getElementById('title');
  if (!title) return;
  title.textContent = MODES[mode][0];
  document.getElementById('intro')!.textContent = MODES[mode][1];
  document.getElementById('down')!.hidden = mode !== 'down';
  if (mode === 'down') void request('status');
};
ipcRenderer.on('rescue:error', (_event, value: unknown) => { if (typeof value === 'string') document.getElementById('status')!.textContent = value; });
ipcRenderer.on('rescue:mode', (_event, value: unknown) => { if (value === 'down' || value === 'setup') { mode = value; render(); } });
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('restart')!.addEventListener('click', () => { void request('restart'); });
  document.getElementById('retry')!.addEventListener('click', () => { void request('open'); });
  document.getElementById('pair')!.addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = document.getElementById('code') as HTMLInputElement;
    const key = document.getElementById('key') as HTMLInputElement;
    const result = await ipcRenderer.invoke('rescue:request', 'setup', { code: code.value, key: key.value, rescuePin: (document.getElementById('rescue-pin') as HTMLInputElement).value }) as { sentence: string };
    code.value = ''; key.value = ''; document.getElementById('saved')!.textContent = result.sentence;
  });
  render();
});
