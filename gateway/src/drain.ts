import type { Socket } from 'node:net';
import type { GatewayRole } from '../../shared/gateway.js';

/** Accept-to-close accounting includes idle consumers and incomplete uploads. */
export class ConsumerDrain {
  private readonly connections = new Map<Socket, GatewayRole>();
  private pending?: { resolve: (value: boolean) => void; timer: NodeJS.Timeout };
  stopped = false;

  constructor(private readonly stopAccepting: () => void) {}

  accept(socket: Socket, role: GatewayRole): void {
    if (this.stopped) { socket.destroy(); return; }
    this.connections.set(socket, role);
    socket.once('close', () => { this.connections.delete(socket); this.check(); });
  }

  count(role: GatewayRole): number { return [...this.connections.values()].filter(value => value === role).length; }
  get draining(): boolean { return this.pending !== undefined; }

  private check(): void {
    if (!this.pending || this.connections.size !== 0) return;
    const pending = this.pending;
    this.pending = undefined;
    clearTimeout(pending.timer);
    // Closing the accepting handles in this step leaves future connections in PID 1's backlog.
    this.stopped = true;
    this.stopAccepting();
    pending.resolve(true);
  }

  wait(timeoutMs: number): Promise<boolean> {
    if (this.pending || this.stopped) throw new Error('A drain is already active.');
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending = undefined; resolve(false); }, timeoutMs);
      timer.unref();
      this.pending = { resolve, timer };
      this.check();
    });
  }

  cancel(): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timer); this.pending.resolve(false); this.pending = undefined;
  }
}
