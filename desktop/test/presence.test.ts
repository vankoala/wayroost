import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PowerMonitor, Session } from 'electron';
import { monitorPresence } from '../src/presence.js';
import { ServerClient } from '../src/server-client.js';

const monitor = { getSystemIdleTime: vi.fn(() => 0), on: vi.fn((_event: string, _listener: () => void) => {}), removeListener: vi.fn() };
const powerMonitor = monitor as unknown as Pick<PowerMonitor, 'on' | 'removeListener' | 'getSystemIdleTime'>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); vi.mocked(monitor.getSystemIdleTime).mockReturnValue(0); });

describe('presence recovery', () => {
  it('resends unchanged presence after server recovery', async () => {
    vi.useFakeTimers();
    const presence = new Map<string, string>();
    const send = vi.fn(async (state: string) => { presence.set('demo-device', state); });
    const stop = monitorPresence(send, powerMonitor);
    await vi.advanceTimersByTimeAsync(500);
    expect(presence.get('demo-device')).toBe('active');
    presence.clear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(presence.get('demo-device')).toBe('active');
    expect(send.mock.calls.length).toBeGreaterThan(1);
    stop();
    const calls = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(calls);
  });

  it('resends for the new device after pairing and makes no requests while unpaired', async () => {
    vi.useFakeTimers();
    const presence = new Map<string, string>();
    let device = 'demo-old-device';
    const fetch = vi.fn(async (url: string, options?: RequestInit) => {
      if (url.endsWith('/api/presence')) presence.set(device, (JSON.parse(options!.body as string) as { state: string }).state);
      if (url.endsWith('/api/me')) return json({ device: { id: device, kind: 'desktop' } });
      return json({ conversations: [], approvals: [], statuses: [] });
    });
    const client = new ServerClient('http://127.0.0.1:8896', { fetch } as unknown as Session, { notify: vi.fn(), removed: vi.fn(), changed: vi.fn() });
    await client.revalidateAuthentication(0);
    const stop = monitorPresence((state) => client.presence(state), powerMonitor);
    await vi.advanceTimersByTimeAsync(500);
    expect(presence.get(device)).toBe('active');
    fetch.mockResolvedValueOnce(json({ error: 'unpaired' }, 401));
    await expect(client.request('/api/me')).rejects.toThrow();
    fetch.mockResolvedValueOnce(json({ error: 'unpaired' }, 401));
    await client.revalidateAuthentication(0);
    presence.clear();
    const calls = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(calls);
    device = 'demo-new-device';
    await client.pair('demo-code', 'Demo desktop');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(presence.get(device)).toBe('active');
    expect(presence.size).toBe(1);
    stop(); client.stop();
  });

  it.each(['idle', 'locked'] as const)('resends unchanged %s presence and removes listeners on stop', async (state) => {
    vi.useFakeTimers();
    vi.mocked(monitor.getSystemIdleTime).mockReturnValue(state === 'idle' ? 60 : 0);
    const send = vi.fn(async () => {});
    const stop = monitorPresence(send, powerMonitor);
    const lock = monitor.on.mock.calls.find(([event]) => event === 'lock-screen')![1];
    const unlock = monitor.on.mock.calls.find(([event]) => event === 'unlock-screen')![1];
    if (state === 'locked') lock();
    await vi.advanceTimersByTimeAsync(500);
    expect(send).toHaveBeenCalledExactlyOnceWith(state);
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(2); expect(send).toHaveBeenLastCalledWith(state);
    if (state === 'locked') { unlock(); await vi.advanceTimersByTimeAsync(500); expect(send).toHaveBeenLastCalledWith('active'); }
    stop();
    expect(monitor.removeListener).toHaveBeenCalledWith('lock-screen', lock);
    expect(monitor.removeListener).toHaveBeenCalledWith('unlock-screen', unlock);
  });
});
