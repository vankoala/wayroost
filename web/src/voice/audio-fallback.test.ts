import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const sources: Array<{ stopped: boolean; at: number; onended: (() => void) | null }> = [];
let decoding: (() => void) | undefined;
class FakeContext {
  state = 'running'; currentTime = 0; destination = {};
  async decodeAudioData(data: ArrayBuffer) {
    if (new Uint8Array(data)[0] === 9) await new Promise<void>(resolve => { decoding = resolve; });
    return { duration: 2 };
  }
  createBufferSource() {
    const source = { stopped: false, at: 0, onended: null as (() => void) | null,
      connect: () => {}, start: (at: number) => { source.at = at; }, stop: () => { source.stopped = true; } };
    sources.push(source); return source;
  }
}
beforeEach(() => { vi.resetModules(); sources.length = 0; decoding = undefined; vi.stubGlobal('AudioContext', FakeContext); });
afterEach(() => vi.unstubAllGlobals());

it('preserves an earlier piece during fallback and schedules the replacement after it', async () => {
  const { Player } = await import('./audio');
  const player = new Player();
  const earlier = Symbol('earlier'); const current = Symbol('current');
  await player.play(new Uint8Array([1]).buffer, earlier);
  await player.play(new Uint8Array([2]).buffer, current);
  player.stopPiece(current);
  await player.play(new Uint8Array([3]).buffer, current);
  expect(sources.map(source => source.stopped)).toEqual([false, true, false]);
  expect(sources[2]!.at).toBe(sources[0]!.at + 2);
  expect(player.pending()).toBe(2);
  expect(player.bufferedSeconds()).toBeCloseTo(4.03);
  player.stop(); expect(player.pending()).toBe(0);
});

it('invalidates only the reset piece while both pieces are decoding', async () => {
  const { Player } = await import('./audio');
  const player = new Player(); const piece = Symbol('current');
  const delayed = player.play(new Uint8Array([9]).buffer, piece);
  await player.play(new Uint8Array([1]).buffer, Symbol('earlier'));
  player.stopPiece(piece);
  decoding!(); await delayed;
  expect(sources).toHaveLength(1);
  expect(sources[0]!.stopped).toBe(false);
  await player.play(new Uint8Array([2]).buffer, piece);
  expect(sources).toHaveLength(2);
});
