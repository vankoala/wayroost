import { contextBridge, ipcRenderer } from 'electron';
// Main fixes this document's generation; the page cannot substitute a newer one.
const argument = '--wayroost-pairing-generation=';
const generation = Number(process.argv.find((value) => value.startsWith(argument))?.slice(argument.length));
type AuthenticationState = 'verified' | 'unverified' | 'unpaired';
let state: AuthenticationState = 'unverified';
const listeners = new Set<(state: AuthenticationState) => void>();
ipcRenderer.on('pairing:state', (_event, next, owner) => {
  if (typeof owner !== 'number' || owner < generation || (owner !== generation && next === 'verified') || !['verified', 'unverified', 'unpaired'].includes(next)) return;
  state = next;
  for (const listener of listeners) listener(state);
});
contextBridge.exposeInMainWorld('wayroostTray', {
  update: (event: unknown) => ipcRenderer.send('tray:update', generation, event),
  anomaly: () => ipcRenderer.send('pairing:anomaly', generation),
  socketClosed: (code: number) => ipcRenderer.send('pairing:socket-closed', generation, code),
  beginSpeech: (): Promise<string | undefined> => ipcRenderer.invoke('speech:begin', generation),
  cancelSpeech: (id: string): Promise<boolean> => ipcRenderer.invoke('speech:cancel', generation, id),
  endSpeech: (id: string) => ipcRenderer.send('speech:end', generation, id),
  onAuthentication: (listener: (state: 'verified' | 'unverified' | 'unpaired') => void) => {
    listeners.add(listener); listener(state);
  },
});
