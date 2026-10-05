import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { inheritedListeners } from '../src/activation.js';
import { acceptedOwner } from '../src/owner.js';

describe('socket activation', () => {
  it('accepts only descriptors passed to this PID in the three-listener order', () => {
    expect(inheritedListeners({}, 123)).toBeUndefined();
    expect(inheritedListeners({ LISTEN_PID: '123', LISTEN_FDS: '3' }, 123)).toEqual({ main: 3, coder: 4, fast: 5 });
    for (const environment of [{ LISTEN_PID: '456', LISTEN_FDS: '3' }, { LISTEN_PID: '123', LISTEN_FDS: '2' }, { LISTEN_FDS: '3' }]) {
      expect(() => inheritedListeners(environment, 123)).toThrow();
    }
  });
});

describe('backend owner lookup', () => {
  const endpoint = { localAddress: '127.0.0.1', localPort: 45000, remoteAddress: '127.0.0.1', remotePort: 8899 } as Socket;
  const header = 'sl local_address rem_address st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode';
  it('matches the accepted end by both addresses, both ports and established state', () => {
    const table = `${header}\n 0: 0100007F:22C3 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 123\n`
      + '1: 0100007F:AFC8 0100007F:22C3 01 00000000:00000000 00:00000000 00000000 1234 0 124\n'
      + '2: 0100007F:22C3 0100007F:AFC8 01 00000000:00000000 00:00000000 00000000 424242 0 125';
    expect(acceptedOwner(table, endpoint)).toBe(424242);
    expect(acceptedOwner(table, { ...endpoint, localPort: 45001 })).toBeUndefined();
    expect(acceptedOwner(table.replace('2: 0100007F:22C3 0100007F:AFC8 01', '2: 0100007F:22C3 0100007F:AFC8 08'), endpoint)).toBeUndefined();
  });
  it('matches compressed and expanded IPv6 loopback', () => {
    const table = `${header}\n 0: 00000000000000000000000001000000:22C3 00000000000000000000000001000000:AFC8 01 00000000:00000000 00:00000000 00000000 0 0 123`;
    expect(acceptedOwner(table, { ...endpoint, localAddress: '::1', remoteAddress: '0:0:0:0:0:0:0:1' })).toBe(0);
    expect(acceptedOwner(table, { ...endpoint, localAddress: undefined })).toBeUndefined();
  });
});
