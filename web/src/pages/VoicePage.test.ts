// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VoiceStatus } from '../../../shared/protocol';
import { VoicePage } from './Settings';

const fixture = vi.hoisted(() => ({ status: {} as VoiceStatus, catalog: vi.fn(), save: vi.fn(), local: vi.fn(), toast: vi.fn() }));
vi.mock('../voice', () => ({ useVoiceStatus: () => fixture.status, useVoiceSettings: () => ({ speed: 1, autoSend: false, readReplies: true }), SPEEDS: [1], setVoiceSettings: vi.fn(), setVoiceStatus: vi.fn(), readMessage: vi.fn() }));
vi.mock('../api', () => ({ api: { voiceCatalog: fixture.catalog, setAppVoice: fixture.save, setVoice: fixture.local } }));
vi.mock('../store', async importOriginal => ({ ...await importOriginal<typeof import('../store')>(), toast: fixture.toast }));
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.status = { enabled: true, available: true, voices: ['af_heart', 'bm_george'], defaultVoice: 'af_heart', canChange: true, appReadAloud: { provider: 'elevenlabs', voiceId: 'fake-deleted-voice', modelId: 'fake-retired-model' } };
  fixture.catalog.mockReset().mockResolvedValue({ available: true, voices: [{ id: 'fake-live-voice', name: 'Demo', category: 'cloned', preview: true }], models: [{ id: 'fake-live-model', name: 'Demo model' }] });
  fixture.save.mockReset().mockResolvedValue(fixture.status);
  fixture.local.mockReset().mockResolvedValue({ ...fixture.status, calls: 'failed', callsMessage: 'Demo phone unavailable.' });
  fixture.toast.mockReset();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it('shows selected placeholders for deleted voices and retired models', async () => {
  await act(async () => root.render(h(VoicePage)));
  const voice = container.querySelector<HTMLSelectElement>('[aria-label="ElevenLabs voice"]')!;
  const model = container.querySelector<HTMLSelectElement>('[aria-label="ElevenLabs model"]')!;
  expect(voice?.selectedOptions[0]?.textContent).toContain('Saved voice is no longer in your account');
  expect(model?.selectedOptions[0]?.textContent).toContain('Saved model is no longer available');
  await act(async () => { voice.value = 'fake-live-voice'; voice.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(fixture.save).toHaveBeenCalledWith({ provider: 'elevenlabs', voiceId: 'fake-live-voice', modelId: 'fake-live-model' });
});

it('a phone renders read-only saved selections without fetching the cloud picker', async () => {
  fixture.status.canChange = false;
  await act(async () => root.render(h(VoicePage)));
  expect(fixture.catalog).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLSelectElement>('[aria-label="App read-aloud provider"]')?.disabled).toBe(true);
});

it('local voice saves report phone synchronization failures', async () => {
  await act(async () => root.render(h(VoicePage)));
  const voice = container.querySelector<HTMLSelectElement>('select[aria-label="Voice"]')!;
  await act(async () => { voice.value = 'bm_george'; voice.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(fixture.local).toHaveBeenCalledWith('bm_george');
  expect(fixture.toast).toHaveBeenCalledWith('Demo phone unavailable.');
});

it('shows a loading message until local status is known', async () => {
  fixture.status = null as unknown as VoiceStatus;
  await act(async () => root.render(h(VoicePage)));
  expect(container.textContent).toContain('Checking local voice');
  expect(container.textContent).not.toContain('Local voice mode is off');
});
