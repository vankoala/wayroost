import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { configSchema } from '../src/config.js';
import { createSupervisor } from '../src/server.js';
import type { ConfigVerbs } from '../src/config-verbs.js';
import { hashKey } from '../src/keys.js';
import { currentConfigVerbs } from '../../shared/supervisor-config.js';

it.each([false, true])('advertises and enforces idle-restart certification: %s', async certified => {
  const config = configSchema.parse({ development: true, restartWhenIdleCertified: certified });
  const drainRestart = vi.fn(async () => ({ ok: false, code: 'not_configured' }));
  const verbs = { status: async () => currentConfigVerbs(true), drainRestart } as unknown as ConfigVerbs;
  const http = createSupervisor({ config, registry: [], keys: [{ name: 'server', scope: 'server', sha256: hashKey('fake-server-key') }],
    exec: { async run() { return 0; } }, configVerbs: verbs });
  const call = (path: string, body?: unknown) => {
    const req = Readable.from(body ? [JSON.stringify(body)] : []) as IncomingMessage;
    req.method = body ? 'POST' : 'GET'; req.url = path; req.headers = { authorization: 'Bearer fake-server-key' };
    return new Promise<{ status: number; body: any }>(resolve => {
      const res = Object.assign(new EventEmitter(), { status: 0, headersSent: false, destroyed: false,
        writeHead(status: number) { this.status = status; return this; },
        end(text: string) { resolve({ status: this.status, body: JSON.parse(text) }); }, destroy() {} });
      http.socket.emit('request', req, res as unknown as ServerResponse);
    });
  };
  expect((await call('/v1/status')).body.configVerbs.restartWhenIdleCertified).toBe(certified);
  const idle = await call('/v1/config/drain-restart', { requestId: '00000000-0000-4000-8000-000000000001', protocol: 1, component: 'hermes', when: 'idle' });
  expect(idle.body.code).toBe(certified ? 'not_configured' : 'not_rolled_out');
  expect(drainRestart).toHaveBeenCalledTimes(certified ? 1 : 0);
  await call('/v1/config/drain-restart', { requestId: '00000000-0000-4000-8000-000000000002', protocol: 1, component: 'hermes', when: 'now' });
  expect(drainRestart).toHaveBeenCalledTimes(certified ? 2 : 1);
});

it('defaults idle-restart certification off', () => {
  expect(configSchema.parse({}).restartWhenIdleCertified).toBe(false);
});
