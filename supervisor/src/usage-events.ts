import { request } from 'node:http';
import type { ClientRequest } from 'node:http';

/** Follow invalidations on the private socket; reconnects start with new events only. */
export function gatewayUsageEvents(socketPath: string, publish: () => void): () => void {
  let stopped = false;
  let client: ClientRequest | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const retry = () => {
    if (stopped || timer) return;
    client?.destroy();
    timer = setTimeout(() => { timer = undefined; connect(); }, 1000);
    timer.unref();
  };
  const connect = () => {
    if (stopped) return;
    client = request({ socketPath, path: '/v1/usage/events', method: 'GET', agent: false }, response => {
      if (response.statusCode !== 200) { response.resume(); retry(); return; }
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 4096) { retry(); return; }
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (line === '{"type":"usage_changed"}') publish();
        }
      });
      response.once('end', retry); response.once('error', retry); response.once('aborted', retry);
    });
    client.once('error', retry); client.end();
  };
  connect();
  return () => { stopped = true; clearTimeout(timer); client?.destroy(); };
}
