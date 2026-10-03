import { describe, expect, it } from 'vitest';
import { QR_MAX_BYTES, QrTooLong, encodeQr, formatBits, qrPath, reedSolomonDivisor, reedSolomonRemainder, tryEncodeQr } from './qr';

// The encoder was also checked end to end while it was written: OpenCV's QR
// decoders read back every version 1-10 and every mask it produces.

const LINK = 'https://wayroost.example.com/pair#abcdefghijklmnopqrstuvwxyz';

function finderAt(modules: boolean[][], x0: number, y0: number): boolean {
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
      if (modules[y0 + y]![x0 + x] !== (ring !== 2)) return false;
    }
  }
  return true;
}

describe('QR encoder', () => {
  it('takes up to QR_MAX_BYTES and answers null (not a throw) past it', () => {
    const at = (n: number) => `https://${'a'.repeat(n - 8)}`;
    expect(encodeQr(at(QR_MAX_BYTES)).version).toBe(10);
    expect(() => encodeQr(at(QR_MAX_BYTES + 1))).toThrow(QrTooLong);
    expect(tryEncodeQr(at(QR_MAX_BYTES))?.version).toBe(10);
    expect(tryEncodeQr(at(QR_MAX_BYTES + 1))).toBeNull();
  });

  it('computes Reed-Solomon codewords (the standard "HELLO WORLD" 1-M example)', () => {
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(reedSolomonRemainder(data, reedSolomonDivisor(10))).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it('writes the published format bits for level M', () => {
    expect(formatBits(0).toString(2).padStart(15, '0')).toBe('101010000010010');
    expect(formatBits(2).toString(2).padStart(15, '0')).toBe('101111001111100');
    expect(formatBits(5).toString(2).padStart(15, '0')).toBe('100000011001110');
    expect(formatBits(7).toString(2).padStart(15, '0')).toBe('100101010100000');
  });

  it('picks the smallest version that fits, and refuses what is too long', () => {
    expect(encodeQr('hi').version).toBe(1);
    expect(encodeQr(LINK)).toMatchObject({ version: 4, size: 33 });
    expect(encodeQr('x'.repeat(213)).version).toBe(10);
    expect(() => encodeQr('x'.repeat(214))).toThrow(/Too long/);
  });

  it('draws the finder patterns, timing lines and dark module', () => {
    const { modules, size } = encodeQr(LINK);
    expect(finderAt(modules, 0, 0)).toBe(true);
    expect(finderAt(modules, size - 7, 0)).toBe(true);
    expect(finderAt(modules, 0, size - 7)).toBe(true);
    for (let i = 8; i < size - 8; i++) {
      expect(modules[6]![i]).toBe(i % 2 === 0);
      expect(modules[i]![6]).toBe(i % 2 === 0);
    }
    expect(modules[size - 8]![8]).toBe(true);
  });

  it('is deterministic and draws only dark modules into the path', () => {
    const a = encodeQr(LINK);
    expect(encodeQr(LINK).modules).toEqual(a.modules);
    const dark = a.modules.flat().filter(Boolean).length;
    expect(qrPath(a).match(/M/g)).toHaveLength(dark);
    expect(qrPath(a)).toMatch(/^M4 4h1v1h-1z/); // the top-left finder's corner, after the quiet zone
  });
});
