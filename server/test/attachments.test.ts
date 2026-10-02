import { describe, expect, it } from 'vitest';
import { MAX_ATTACHMENT_BYTES, decodeAttachment, decodeAttachments, safeFileName } from '../src/attachments.js';
import { UserFacingError } from '../src/sources.js';

const b64 = (bytes: Buffer | string) => Buffer.from(bytes).toString('base64');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

describe('attachments', () => {
  it('trusts the bytes, not the claimed type', () => {
    expect(decodeAttachment({ name: 'shot.png', mimeType: 'application/octet-stream', data: b64(PNG) })).toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
    });
    expect(() => decodeAttachment({ name: 'fake.png', mimeType: 'image/png', data: b64('<svg onload=alert(1)>') })).toThrow(
      UserFacingError,
    );
    expect(() => decodeAttachment({ name: 'x.pdf', mimeType: 'application/pdf', data: b64('not a pdf') })).toThrow(
      UserFacingError,
    );
  });

  it('accepts PDFs and UTF-8 text, rejects binaries', () => {
    expect(decodeAttachment({ name: 'a.pdf', mimeType: 'application/pdf', data: b64('%PDF-1.7\n...') }).kind).toBe('pdf');
    expect(decodeAttachment({ name: 'notes.md', mimeType: 'text/markdown', data: b64('# hi') })).toMatchObject({
      kind: 'text',
      mimeType: 'text/markdown',
    });
    expect(() =>
      decodeAttachment({ name: 'a.exe', mimeType: 'application/octet-stream', data: b64(Buffer.from([0x4d, 0x5a, 0, 1])) }),
    ).toThrow(UserFacingError);
  });

  it('accepts Office documents, archives and data files only when the bytes match the name', () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    const tar = Buffer.concat([Buffer.alloc(257), Buffer.from('ustar\0')]);
    expect(decodeAttachment({ name: 'budget.xlsx', mimeType: 'application/octet-stream', data: b64(zip) })).toMatchObject({
      kind: 'file',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    expect(decodeAttachment({ name: 'Old Report.DOC', mimeType: '', data: b64(ole) })).toMatchObject({
      kind: 'file',
      mimeType: 'application/msword',
    });
    expect(decodeAttachment({ name: 'src.tar', mimeType: 'application/x-tar', data: b64(tar) }).kind).toBe('file');
    expect(decodeAttachment({ name: 'app.sqlite', mimeType: 'x', data: b64('SQLite format 3\0...') }).kind).toBe('file');
    expect(decodeAttachment({ name: 'rows.parquet', mimeType: 'x', data: b64(Buffer.from('PAR1\0\x15')) }).kind).toBe('file');
    // A known signature under the wrong name, or a name with the wrong bytes, is refused.
    expect(() => decodeAttachment({ name: 'tool.exe', mimeType: 'application/zip', data: b64(zip) })).toThrow(UserFacingError);
    expect(() => decodeAttachment({ name: 'budget.xls', mimeType: 'x', data: b64(zip) })).toThrow(UserFacingError);
    expect(() =>
      decodeAttachment({ name: 'renamed.xlsx', mimeType: 'x', data: b64(Buffer.from([0x4d, 0x5a, 0x90, 0])) }),
    ).toThrow(/only photos, PDFs, text, Office files/);
    expect(() => decodeAttachment({ name: 'x.constructor', mimeType: 'x', data: b64(zip) })).toThrow(UserFacingError);
  });

  it('enforces size and count limits', () => {
    const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, 0x61);
    expect(() => decodeAttachment({ name: 'big.txt', mimeType: 'text/plain', data: b64(big) })).toThrow(/10 MB/);
    const one = { name: 'a.txt', mimeType: 'text/plain', data: b64('a') };
    expect(() => decodeAttachments([one, one, one, one, one])).toThrow(/at most 4/);
    expect(() => decodeAttachment({ ...one, data: 'not*base64' })).toThrow(UserFacingError);
  });

  it('strips paths and control characters from names', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('C:\\Users\\me\\..\\evil\u0000.txt')).toBe('evil.txt');
    expect(safeFileName('.hidden')).toBe('hidden');
    expect(safeFileName('\u0007')).toBe('file');
  });
});
