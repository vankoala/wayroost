import { open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import type { ActionDetail } from '../../shared/supervisor.js';

export const OUTPUT_LINES = 200;
export const LINE_LENGTH = 4096;
export const HISTORY_SIZE = 100;
export function retainLine(action: ActionDetail, line: string): string {
  line = line.slice(0, LINE_LENGTH);
  action.lines.push(line);
  if (action.lines.length > OUTPUT_LINES) action.lines.splice(0, action.lines.length - OUTPUT_LINES);
  return line;
}

/** Read at most one chunk per poll; even an unterminated line has bounded memory. */
export class OutputTail {
  private offset = 0;
  private pending = '';
  private readonly decoder = new StringDecoder('utf8');
  constructor(readonly path: string, readonly line: (line: string) => void) {}
  async read(final = false): Promise<boolean> {
    const file = await open(this.path, 'r');
    let bytesRead: number;
    try {
      const buffer = Buffer.alloc(65536);
      ({ bytesRead } = await file.read(buffer, 0, buffer.length, this.offset));
      this.offset += bytesRead;
      this.pending += this.decoder.write(buffer.subarray(0, bytesRead));
    } finally { await file.close(); }
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) >= 0) {
      this.line(this.pending.slice(0, newline).replace(/\r$/, ''));
      this.pending = this.pending.slice(newline + 1);
    }
    while (this.pending.length > LINE_LENGTH) {
      this.line(this.pending.slice(0, LINE_LENGTH));
      this.pending = this.pending.slice(LINE_LENGTH);
    }
    if (final && bytesRead === 0) {
      this.pending += this.decoder.end();
      if (this.pending) this.line(this.pending);
      this.pending = '';
    }
    return bytesRead > 0;
  }
}
