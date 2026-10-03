import { chmodSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { CLOUD_FORMATS, CLOUD_ID } from '../shared/voice.js';
import { CloudVoiceError, ElevenLabs } from './cloud-api.js';

const Input = z.object({ text: z.string().trim().min(1).max(1000), voiceId: z.string().regex(CLOUD_ID), modelId: z.string().regex(CLOUD_ID), outputFormat: z.enum(CLOUD_FORMATS) }).strict();
const send = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
function drain(res: ServerResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    const clear = () => { res.off('drain', ready); res.off('close', closed); res.off('error', closed); };
    const ready = () => { clear(); resolve(); };
    const closed = () => { clear(); reject(new CloudVoiceError('unreachable')); };
    res.once('drain', ready); res.once('close', closed); res.once('error', closed);
    if (res.destroyed) closed();
  });
}
async function body(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16_384) throw new CloudVoiceError('invalid');
    parts.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
}

export async function startCloudRpc(socketPath: string, api: ElevenLabs) {
  const server = createServer(async (req, res) => {
    let upstream: IncomingMessage | undefined;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    res.once('close', cancel);
    try {
      if (req.method === 'GET' && req.url === '/catalog') return send(res, 200, await api.catalog(abort.signal));
      if (req.method !== 'POST' || req.url !== '/synthesize') return send(res, 404, { code: 'invalid' });
      const input = Input.parse(await body(req));
      upstream = await api.synthesize(input.text, input.voiceId, input.modelId, input.outputFormat, abort.signal);
      if (res.destroyed) { upstream.destroy(); return; }
      res.writeHead(200, { 'content-type': input.outputFormat === 'pcm_24000' ? 'audio/pcm' : 'audio/mpeg', 'cache-control': 'no-store' });
      for await (const chunk of api.audio(upstream)) {
        if (res.destroyed) throw new CloudVoiceError('unreachable');
        if (!res.write(chunk)) await drain(res);
      }
      res.end();
    } catch (err) {
      upstream?.destroy();
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      const code = err instanceof CloudVoiceError ? err.code : 'invalid';
      send(res, code === 'invalid' ? 400 : 503, { code });
    } finally { res.off('close', cancel); abort.abort(); }
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.timeout = 35_000;
  server.maxConnections = 8;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { chmodSync(socketPath, 0o660); resolve(); }); });
  return server;
}
