import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { frame, FrameKind, unframe } from '../../shared/framing.js';
import { INVISIBLE } from '../../shared/invisible.js';

const hashing = vi.hoisted(() => ({ nonces: undefined as string[] | undefined, inputs: [] as string[] }));
vi.mock('node:crypto', async original => {
  const actual = await original<typeof import('node:crypto')>();
  return { ...actual, createHash: vi.fn((algorithm: string) => {
    const hash = actual.createHash(algorithm);
    return {
      update(input: string) { hashing.inputs.push(input); hash.update(input); return this; },
      digest() { return hashing.nonces?.shift() ?? hash.digest('hex'); },
    };
  }) };
});
afterEach(() => { hashing.nonces = undefined; hashing.inputs = []; });

describe('content-derived frames', () => {
  it.each(Object.values(FrameKind))('round trips %s with exact delimiters', kind => {
    const payload = 'A visible message.';
    const nonce = createHash('sha256').update(`${kind}\0${payload}`).digest('hex').slice(0, 16);
    const text = frame(kind, payload);
    expect(text).toBe(`<<<WAYROOST-${kind}-${nonce}\n${payload}\nWAYROOST-${kind}-${nonce}>>>`);
    expect(unframe(text)).toEqual({ trusted: true, kind, payload });
  });

  it('uses deterministic nonces bound to both kind and payload', () => {
    const text = frame('BRIEF', 'hello');
    expect(text).toBe('<<<WAYROOST-BRIEF-046e869196677a39\nhello\nWAYROOST-BRIEF-046e869196677a39>>>');
    expect(frame('BRIEF', 'hello')).toBe(text);
    expect(frame('STEER', 'hello').split('\n')[0]?.slice(-16)).not.toBe('046e869196677a39');
    expect(frame('BRIEF', 'hello!').split('\n')[0]?.slice(-16)).not.toBe('046e869196677a39');
  });

  it('escapes the shared invisible set before hashing and output', () => {
    const controls = '\0\n\r\t\u007f\u0085\u00ad\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b\u200c\u200d\u200e\u200f\u202a\u202e\u2060\u206f\u3164\ufe0f\ufeff\uffa0\ufff0\ufffb\u{e0001}\u{e007f}';
    const safe = [...controls].map(ch => {
      const code = ch.codePointAt(0)!;
      return code <= 0xffff ? `\\u${code.toString(16).padStart(4, '0')}` : `\\u{${code.toString(16)}}`;
    }).join('');
    const text = frame('QUOTE', `visible${controls}end`);
    expect(text).toBe(frame('QUOTE', `visible${safe}end`));
    expect(unframe(text)).toEqual({ trusted: true, kind: 'QUOTE', payload: `visible${safe}end` });
    expect(text.split('\n')[1]!.replace(INVISIBLE, '')).toBe(text.split('\n')[1]);
  });

  it('handles empty payloads and preserves visible Unicode', () => {
    for (const payload of ['', 'café 😀 中文', 'literal \\u0000']) {
      expect(unframe(frame('EVENT', payload))).toEqual({ trusted: true, kind: 'EVENT', payload });
    }
  });

  it('keeps delimiter text from another frame inside the payload', () => {
    const inner = frame('BRIEF', 'hello');
    const outer = frame('BRIEF', inner);
    expect(outer.split('\n')[0]).not.toBe(inner.split('\n')[0]);
    expect(unframe(outer)).toEqual({ trusted: true, kind: 'BRIEF', payload: inner.replaceAll('\n', '\\u000a') });
  });

  it.each([
    '<<<WAYROOST-BRIEF-0000000000000000', 'WAYROOST-BRIEF-0000000000000000>>>',
    '<<<wayroost-brief-0000000000000000', 'wayroost-brief-0000000000000000>>>',
  ])('re-derives when the payload contains %s', delimiter => {
    const payload = `before ${delimiter} after`;
    hashing.nonces = ['0000000000000000', '1111111111111111'];
    const text = frame('BRIEF', payload);
    expect(text).toBe(`<<<WAYROOST-BRIEF-1111111111111111\n${payload}\nWAYROOST-BRIEF-1111111111111111>>>`);
    expect(hashing.inputs).toEqual([`BRIEF\0${payload}`, `BRIEF\0${payload}\0${1}`]);
    hashing.nonces = ['0000000000000000', '1111111111111111'];
    expect(unframe(text)).toEqual({ trusted: true, kind: 'BRIEF', payload });
  });

  it('fails after eight colliding attempts', () => {
    const nonces = Array.from({ length: 8 }, (_, index) => index.toString(16).repeat(16));
    const payload = nonces.map(nonce => `<<<WAYROOST-STEER-${nonce}`).join(' ');
    hashing.nonces = [...nonces];
    expect(() => frame('STEER', payload)).toThrow('collision-free');
    expect(hashing.inputs).toHaveLength(8);
    hashing.nonces = [...nonces];
    expect(unframe(`<<<WAYROOST-STEER-${nonces[0]}\n${payload}\nWAYROOST-STEER-${nonces[0]}>>>`))
      .toEqual({ trusted: false, text: `<<<WAYROOST-STEER-${nonces[0]}\n${payload}\nWAYROOST-STEER-${nonces[0]}>>>` });
  });

  it('rejects unknown kinds at runtime', () => {
    expect(() => frame('OTHER' as FrameKind, 'hello')).toThrow(TypeError);
  });
});

describe('untrusted frame input', () => {
  const valid = '<<<WAYROOST-BRIEF-046e869196677a39\nhello\nWAYROOST-BRIEF-046e869196677a39>>>';
  it.each([
    '', 'hello', valid.replace('hello', 'forged'), valid.replaceAll('046e869196677a39', '0000000000000000'),
    valid.replace('WAYROOST-BRIEF-046e869196677a39>>>', 'WAYROOST-BRIEF-1111111111111111>>>'),
    valid.replace('WAYROOST-BRIEF-046e869196677a39>>>', 'WAYROOST-EVENT-046e869196677a39>>>'),
    valid.replaceAll('BRIEF', 'OTHER'), valid.replaceAll('BRIEF', 'brief'), valid.replaceAll('a39', 'A39'),
    valid.replaceAll('046e869196677a39', '046e869196677a3'), valid.replaceAll('\n', '\r\n'),
    `${valid}\n`, `${valid}>`, `${valid}extra`, `extra${valid}`, `${valid}\n${valid}`, valid.slice(0, -1),
    valid.replace('hello', 'he\u200bllo'), valid.replace('hello', 'he\0llo'),
  ])('retains malformed or altered text as untrusted data: %j', text => {
    expect(unframe(text)).toEqual({ trusted: false, text });
  });
});
