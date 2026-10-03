import { describe, expect, it } from 'vitest';
import { codeFromHash, countdown, groupCode, guessDeviceName, normalizeCode } from './pairing';

const CODE = 'abcdefghijklmnopqrstuvwxyz';

describe('pairing helpers', () => {
  it('reads only a well-formed code from the fragment', () => {
    expect(codeFromHash(`#${CODE}`)).toBe(CODE);
    expect(codeFromHash(`#${groupCode(CODE).toUpperCase()}`)).toBe(CODE);
    expect(codeFromHash('#for-you')).toBeNull();
    expect(codeFromHash(`#${CODE}1`)).toBeNull(); // 1 isn't base32
    expect(codeFromHash('')).toBeNull();
  });

  it('groups and normalizes typed codes like the server', () => {
    expect(groupCode(CODE)).toBe('abcd-efgh-ijkl-mnop-qrst-uvwx-yz');
    expect(normalizeCode(' ABCD-efgh ijkl ')).toBe('abcdefghijkl');
  });

  it('guesses a readable device name', () => {
    expect(guessDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('iPhone');
    expect(guessDeviceName('Mozilla/5.0 (Linux; Android 15; Pixel) Mobile Safari')).toBe('Android phone');
    expect(guessDeviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140')).toBe('Windows PC');
    expect(guessDeviceName('')).toBe('Browser');
  });

  it('counts down in minutes and seconds', () => {
    expect(countdown(600_000)).toBe('10:00');
    expect(countdown(61_500)).toBe('1:02');
    expect(countdown(-5)).toBe('0:00');
  });
});
