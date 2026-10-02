import { describe, expect, it } from 'vitest';
import { attachableBytes, attachmentKind, prepareFile } from './attach';

const bytes = (...b: number[]) => new Uint8Array(b);
const text = (s: string) => new TextEncoder().encode(s);

describe('what can be attached', () => {
  it('takes images and PDFs by their signature, and UTF-8 text, like the server', () => {
    expect(attachableBytes(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe(true);
    expect(attachableBytes(bytes(0xff, 0xd8, 0xff, 0xe0, 0))).toBe(true);
    expect(attachableBytes(text('%PDF-1.7\n\0binary'))).toBe(true);
    expect(attachableBytes(text('RIFF\0\0\0\0WEBPVP8 '))).toBe(true);
    expect(attachableBytes(text('# notes: ünïcode ✓\n'))).toBe(true);
  });

  it('takes Office documents, archives and data files when the bytes match the name', () => {
    expect(attachableBytes(bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00), 'budget.xlsx')).toBe(true);
    expect(attachableBytes(bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0), 'old.XLS')).toBe(true);
    expect(attachableBytes(text('SQLite format 3\0rest'), 'app.db')).toBe(true);
    expect(attachableBytes(bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00), 'tool.exe')).toBe(false);
    expect(attachableBytes(bytes(0x4d, 0x5a, 0x90, 0x00), 'renamed.xlsx')).toBe(false);
    expect(attachmentKind('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'budget.xlsx')).toBe('file');
  });

  it('refuses other files', () => {
    expect(attachableBytes(bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00))).toBe(false); // a zip with no name
    expect(attachableBytes(bytes(0xff, 0xfe, 0x68, 0x00))).toBe(false); // UTF-16 text
    expect(attachableBytes(bytes(0xc3, 0x28))).toBe(false); // not UTF-8
  });

  it('says so as soon as such a file is picked or dropped, not when the message is sent', async () => {
    const exe = new File([bytes(0x4d, 0x5a, 0x90, 0)], 'setup.exe', { type: 'application/x-msdownload' });
    await expect(prepareFile(exe)).rejects.toThrow(
      'setup.exe: only photos, PDFs, text, Office files, archives and SQLite or Parquet data can be attached.',
    );
    await expect(prepareFile(new File([], 'empty.txt', { type: 'text/plain' }))).rejects.toThrow('empty.txt is empty.');
  });
});
