import type { ServerResponse } from 'node:http';

export const SSE_BUFFER_BYTES = 262144;
/** write(false) has accepted the frame; queue only later frames until drain. */
export class EventStream {
  private readonly queue: string[] = [];
  private queuedBytes = 0;
  private blocked = false;
  constructor(readonly response: ServerResponse) {
    response.on('drain', this.drain);
    response.once('close', () => { response.off('drain', this.drain); this.queue.length = 0; this.queuedBytes = 0; });
  }
  send(frame: string): void {
    if (this.response.destroyed) return;
    const bytes = Buffer.byteLength(frame);
    if (bytes + this.queuedBytes + this.response.writableLength > SSE_BUFFER_BYTES) { this.response.destroy(); return; }
    if (this.blocked) { this.queue.push(frame); this.queuedBytes += bytes; }
    else this.blocked = !this.response.write(frame);
  }
  private readonly drain = (): void => {
    this.blocked = false;
    while (!this.blocked && this.queue.length) {
      const frame = this.queue.shift()!;
      this.queuedBytes -= Buffer.byteLength(frame);
      this.blocked = !this.response.write(frame);
    }
  };
}
