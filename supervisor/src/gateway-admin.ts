import { request } from 'node:http';

/** The private socket accepts bounded JSON only; no upstream text escapes it. */
export function gatewayAdmin(socketPath: string, path: string, body: unknown, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const client = request({ socketPath, path, method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, response => {
      let bytes = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 65536) { response.destroy(); reject(new Error('unavailable')); }
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('aborted', () => reject(new Error('unavailable')));
      response.once('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error('unavailable');
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch { reject(new Error('unavailable')); }
      });
    });
    client.once('error', reject);
    client.end(payload);
  });
}
