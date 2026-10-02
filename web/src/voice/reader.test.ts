import { describe, expect, it } from 'vitest';
import type { TimelineItem } from '../../../shared/protocol';
import { MAX_SPOKEN, MORE_ON_SCREEN, ReplyReader, type ReaderOutput } from './reader';

/** Speech is the text itself; "playing" a clip lasts until finish() is called. */
class FakeOut implements ReaderOutput {
  played: string[] = [];
  requested: string[] = [];
  failing = false;
  maxPending = 0;
  private playing: string[] = [];
  private waiters: Array<() => void> = [];

  async speak(text: string) {
    this.requested.push(text);
    if (this.failing) throw new Error('down');
    return new TextEncoder().encode(text).buffer as ArrayBuffer;
  }
  async play(audio: ArrayBuffer) {
    const text = new TextDecoder().decode(audio);
    this.played.push(text);
    this.playing.push(text);
    this.maxPending = Math.max(this.maxPending, this.playing.length);
    this.notify();
  }
  pending() {
    return this.playing.length;
  }
  changed() {
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  /** The oldest clip ends. */
  finish() {
    this.playing.shift();
    this.notify();
  }
  private notify() {
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((w) => w());
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Let every clip queued so far finish, round after round. */
async function drain(out: FakeOut) {
  for (let i = 0; i < 1000; i += 1) {
    await settle();
    if (out.pending() === 0) {
      await settle();
      if (out.pending() === 0) return;
    }
    out.finish();
  }
}

const user = (id: string, text = 'question'): TimelineItem => ({ kind: 'user', id, text });
const reply = (id: string, text: string, streaming = false): TimelineItem => ({
  kind: 'assistant',
  id,
  text,
  ...(streaming ? { streaming: true } : {}),
});

function reader() {
  const out = new FakeOut();
  const done: Array<string | undefined> = [];
  const r = new ReplyReader(out, (error) => done.push(error));
  return { out, done, r };
}

describe('ReplyReader', () => {
  it('reads the new reply sentence by sentence as it streams, then finishes with the turn', async () => {
    const { out, done, r } = reader();
    const before = [reply('a0', 'An older reply.'), user('u1')];
    r.update(before, false);
    r.update(before, true);
    r.update([...before, reply('a1', 'Hello there. How', true)], true);
    await settle();
    expect(out.played).toEqual(['Hello there.']);
    r.update([...before, reply('a1', 'Hello there. How are you? I am', true)], true);
    await drain(out);
    expect(out.played).toEqual(['Hello there.', 'How are you?']);
    expect(done).toEqual([]);
    r.update([...before, reply('a1', 'Hello there. How are you? I am fine.')], false);
    await drain(out);
    expect(out.played).toEqual(['Hello there.', 'How are you?', 'I am fine.']);
    expect(done).toEqual([undefined]);
    expect(r.active).toBe(false);
  });

  it("waits for the agent before calling the turn over, and skips what isn't worth saying", async () => {
    const { out, done, r } = reader();
    r.update([user('u1')], false);
    await drain(out);
    expect(done).toEqual([]);
    r.update([user('u1')], true);
    r.update([user('u1'), reply('a1', 'Running it now.'), reply('a2', '```\nnpm test\n```\n\nAll **12** tests pass.')], false);
    await drain(out);
    expect(out.played).toEqual(['Running it now.', 'All 12 tests pass.']);
    expect(done).toEqual([undefined]);
  });

  it("doesn't read a reply again when a reload gives it a new id", async () => {
    const { out, done, r } = reader();
    r.update([user('u1'), reply('live-1', 'First point. Second', true)], true);
    await settle();
    r.update([user('db-1'), reply('db-2', 'First point. Second point.')], false);
    await drain(out);
    expect(out.played).toEqual(['First point.', 'Second point.']);
    expect(done).toEqual([undefined]);
  });

  it('hands over to the screen after a long reply', async () => {
    const { out, r } = reader();
    const sentence = 'This sentence has some length to it.';
    const long = Array(Math.ceil(MAX_SPOKEN / sentence.length) + 5).fill(sentence).join(' ');
    r.update([user('u1'), reply('a1', long)], false);
    await drain(out);
    expect(out.played.at(-1)).toBe(MORE_ON_SCREEN);
    expect(out.played.slice(0, -1).reduce((n, piece) => n + piece.length, 0)).toBeLessThanOrEqual(MAX_SPOKEN);
  });

  it('keeps only a couple of clips ahead of what is playing', async () => {
    const { out, r } = reader();
    r.update([user('u1'), reply('a1', 'One. Two. Three. Four. Five. Six.')], false);
    await settle();
    await settle();
    expect(out.played.length).toBeLessThanOrEqual(2);
    await drain(out);
    expect(out.played).toEqual(['One.', 'Two.', 'Three.', 'Four.', 'Five.', 'Six.']);
    expect(out.maxPending).toBeLessThanOrEqual(2);
  });

  it('gives up with a message when speech keeps failing', async () => {
    const { out, done, r } = reader();
    out.failing = true;
    r.update([user('u1'), reply('a1', 'One. Two. Three.')], false);
    await drain(out);
    expect(done).toEqual(["Couldn't read the reply aloud."]);
    expect(out.played).toEqual([]);
  });

  it('stops at once and stays stopped', async () => {
    const { out, done, r } = reader();
    r.update([user('u1'), reply('a1', 'One. Two. Three. Four.')], false);
    await settle();
    r.stop();
    r.update([user('u1'), reply('a1', 'One. Two. Three. Four. Five.')], false);
    await drain(out);
    expect(out.played.length).toBeLessThanOrEqual(2);
    expect(done).toEqual([]);
    expect(r.active).toBe(false);
  });

  it('never reads replies that were there before, even while a reload drops your message', async () => {
    const { out, done, r } = reader();
    const before = [user('u0'), reply('a0', 'The previous answer.')];
    r.skip(before);
    // A reload lands before the server has your message: the old reply sits after the last user item.
    r.update(before, true);
    await drain(out);
    expect(out.played).toEqual([]);
    r.update([...before, user('u1'), reply('a1', 'The new answer.')], false);
    await drain(out);
    expect(out.played).toEqual(['The new answer.']);
    expect(done).toEqual([undefined]);
  });

  it("doesn't take a new reply for an old one that starts the same way", async () => {
    const { out, r } = reader();
    const before = [user('u0'), reply('a0', 'Done.')];
    r.skip(before);
    r.update([...before, user('u1'), reply('a1', 'Done. I also tidied the logs.')], false);
    await drain(out);
    expect(out.played).toEqual(['Done.', 'I also tidied the logs.']);
  });

  it('tries a piece again when Signalbox is busy reading for other pages', async () => {
    const { out, done, r } = reader();
    let busy = 2;
    const speak = out.speak.bind(out);
    out.speak = async (text: string) => {
      if (busy-- > 0) throw Object.assign(new Error('busy'), { status: 429 });
      return speak(text);
    };
    r.update([user('u1'), reply('a1', 'Hello.')], false);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    await drain(out);
    expect(out.played).toEqual(['Hello.']);
    expect(done).toEqual([undefined]);
  });

  it('reads a single finished message (the Listen button)', async () => {
    const { out, done, r } = reader();
    r.update([reply('a1', 'Just this. And this.')], false);
    await drain(out);
    expect(out.played).toEqual(['Just this.', 'And this.']);
    expect(done).toEqual([undefined]);
  });
});
