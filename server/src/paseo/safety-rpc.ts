import { checkDeviceSignal, deviceSignal } from '../security/device-signal.js';
import { z } from 'zod';
import { CLOUD_AGENT_IDS, type CloudAgentId } from '../../../shared/protocol.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { WorkerApprovalsStatus, WorkerApprovalsWrite, pendingWorkerApprovals, type PaseoConfigWriter, type WorkerApprovalsApi } from '../../../shared/safety.js';
import { UserFacingError } from '../sources.js';

const hash = (key: string) => createHash('sha256').update(key).digest();

const CloudWrite = z.object({ id: z.enum(CLOUD_AGENT_IDS), enabled: z.boolean() }).strict();

/** Fixed-target setting and cloud-provider writes; no paths or arbitrary config are accepted. */
export async function startSafetyRpc(path: string, key: string, setting: WorkerApprovalsApi & Partial<PaseoConfigWriter>): Promise<Server> {
  if (!key.trim()) throw new Error('The Safety helper credential is missing.');
  try {
    if (!lstatSync(path).isSocket()) throw new Error('The Safety helper path is occupied.');
    unlinkSync(path);
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    const provided = req.headers.authorization;
    if (!provided || !timingSafeEqual(hash(provided), hash(`Bearer ${key}`))) {
      res.writeHead(401).end('{}');
      req.resume();
      return;
    }
    try {
      if (req.method === 'GET' && req.url === '/status') {
        res.end(JSON.stringify(await setting.status()));
      } else if (req.method === 'PUT' && (req.url === '/setting' || req.url === '/cloud-agent')) {
        let body = '';
        for await (const chunk of req) {
          body += String(chunk);
          if (body.length > 128) { res.writeHead(413).end('{}'); return; }
        }
        if (req.url === '/cloud-agent') {
          const parsed = CloudWrite.safeParse(JSON.parse(body));
          if (!parsed.success) { res.writeHead(400).end('{}'); return; }
          if (!setting.setCloudAgentEnabled) { res.writeHead(404).end('{}'); return; }
          await setting.setCloudAgentEnabled(parsed.data.id, parsed.data.enabled);
          res.end('{}');
        } else {
          const parsed = WorkerApprovalsWrite.safeParse(JSON.parse(body));
          if (!parsed.success) { res.writeHead(400).end('{}'); return; }
          res.end(JSON.stringify(await setting.setEnabled(parsed.data.enabled)));
        }
      } else {
        req.resume();
        res.writeHead(404).end('{}');
      }
    } catch {
      res.writeHead(503).end('{}');
    }
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.on('connection', socket => socket.setTimeout(15_000, () => socket.destroy()));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); resolve(); });
  });
  chmodSync(path, 0o660);
  return server;
}

export class SafetyHelperClient implements WorkerApprovalsApi, PaseoConfigWriter {
  private last = pendingWorkerApprovals();
  constructor(private readonly path: string, private readonly key: string) {}

  async status(): Promise<WorkerApprovalsStatus> {
    try { this.last = WorkerApprovalsStatus.parse(await this.call()); return this.last; }
    // A cached choice may predate a committed write whose response was lost.
    catch { return { ...this.last, choiceConfirmed: false, config: 'pending', application: 'pending', reload: 'pending', message: 'The Safety helper is unavailable; its saved policy has not been confirmed.' }; }
  }

  async setEnabled(enabled: boolean): Promise<WorkerApprovalsStatus> {
    try { this.last = WorkerApprovalsStatus.parse(await this.call(enabled)); return this.last; }
    catch { throw new UserFacingError('The Safety helper could not save the setting. Check its status and retry.', 424); }
  }

  async setCloudAgentEnabled(id: CloudAgentId, enabled: boolean): Promise<void> {
    this.last = { ...this.last, config: 'pending', reload: 'pending', application: 'pending' };
    try { z.object({}).strict().parse(await this.call(undefined, { id, enabled })); }
    catch { throw new UserFacingError('The Safety helper could not verify the cloud agent switch. Check its status and retry.', 424); }
  }

  private call(enabled?: boolean, cloud?: { id: CloudAgentId; enabled: boolean }, signal = deviceSignal()): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const body = cloud ? JSON.stringify(cloud) : enabled === undefined ? undefined : JSON.stringify({ enabled });
      checkDeviceSignal(signal);
      const req = request({
        signal,
        socketPath: this.path, path: cloud ? '/cloud-agent' : body ? '/setting' : '/status', method: body ? 'PUT' : 'GET',
        headers: { authorization: `Bearer ${this.key}`, ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) },
      }, res => {
        let output = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { output += chunk; if (output.length > 64 * 1024) req.destroy(new Error('Safety helper response too large.')); });
        res.on('error', reject);
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) throw new Error('Safety helper refused the request.');
            resolve(JSON.parse(output));
          } catch (err) { reject(err); }
        });
      });
      const timeout = setTimeout(() => req.destroy(new Error('Safety helper timed out.')), 12_000);
      req.once('close', () => clearTimeout(timeout));
      req.on('error', reject);
      req.end(body);
    });
  }
}
