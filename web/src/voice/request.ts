/** Main acknowledges ownership before Chromium sees a deliberate playback abort. */
export async function speechRequest(signal: AbortSignal) {
  const bridge = typeof window === 'undefined' ? undefined : window.wayroostTray;
  if (!bridge?.beginSpeech || !bridge.cancelSpeech || !bridge.endSpeech) {
    return { url: '/api/voice/speak', signal, cancel: async () => {}, dispose: async () => {} };
  }
  const id = await bridge.beginSpeech();
  if (!id) throw new Error('Read-aloud is paused while your sign-in is checked.');
  const work = new AbortController();
  let cancellation: Promise<void> | undefined;
  const cancel = () => cancellation ??= bridge.cancelSpeech!(id).then(() => { work.abort(signal.reason); });
  const abort = () => { void cancel().catch(() => { work.abort(signal.reason); }); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  return {
    url: `/api/voice/speak?speechRequest=${encodeURIComponent(id)}`, signal: work.signal, cancel,
    dispose: async () => {
      signal.removeEventListener('abort', abort);
      try { await cancel(); } finally { bridge.endSpeech!(id); }
    },
  };
}
