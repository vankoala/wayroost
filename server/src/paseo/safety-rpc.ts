import { actionSignal, checkDeviceSignal, deviceSignal } from '../security/device-signal.js';
import { z } from 'zod';
import { CLOUD_AGENT_IDS, type CloudAgentId } from '../../../shared/protocol.js';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { WorkerApprovalsStatus, WorkerApprovalsWrite, pendingWorkerApprovals, type PaseoConfigWriter, type WorkerApprovalsApi } from '../../../shared/safety.js';
import { UserFacingError } from '../sources.js';
import { waitWithAbort } from './abort.js';

const hash = (key: string) => createHash('sha256').update(key).digest();

const CloudWrite = z.object({ id: z.enum(CLOUD_AGENT_IDS), enabled: z.boolean() }).strict();
const WriteId = z.object({ id: z.uuid() }).strict();
const TIMEOUT_MS = 12_000;

interface PendingWrite {
  controller: AbortController;
  started: boolean;
  ready: boolean;
  authorized: Promise<void>;
  authorize(): void;
  settled: Promise<void>;
  finish(): void;
  timer: ReturnType<typeof setTimeout>;
}

/** Fixed-target setting and cloud-provider writes; no paths or arbitrary config are accepted. */
export async function startSafetyRpc(path: string, key: string, setting: WorkerApprovalsApi & Partial<PaseoConfigWriter>): Promise<Server> {
  if (!key.trim()) throw new Error('The Safety helper credential is missing.');
  try {
    if (!lstatSync(path).isSocket()) throw new Error('The Safety helper path is occupied.');
    unlinkSync(path);
  } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  const writes = new Map<string, PendingWrite>();
  const server = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    const provided = req.headers.authorization;
    if (!provided || !timingSafeEqual(hash(provided), hash(`Bearer ${key}`))) {
      res.writeHead(401).end('{}');
      req.resume();
      return;
    }
    let controller = new AbortController();
    let writeId: string | undefined;
    const abort = () => controller.abort();
    const disconnected = () => { if (!res.writableFinished) abort(); };
    req.once('aborted', abort);
    res.once('close', disconnected);
    try {
      if (req.method === 'GET' && req.url === '/status') {
        res.end(JSON.stringify(await setting.status()));
      } else if (req.method === 'POST' && req.url === '/begin') {
        req.resume();
        if (writes.size >= 128) { res.writeHead(503).end('{}'); return; }
        const id = randomUUID();
        let authorize!: () => void;
        let finish!: () => void;
        const authorized = new Promise<void>(resolve => { authorize = resolve; });
        const settled = new Promise<void>(resolve => { finish = resolve; });
        const pending: PendingWrite = {
          controller, started: false, ready: false, authorized, authorize, settled, finish,
          timer: setTimeout(() => {
            controller.abort();
            if (!pending.started) { writes.delete(id); finish(); }
          }, TIMEOUT_MS),
        };
        writes.set(id, pending);
        res.end(JSON.stringify({ id }));
      } else if (req.method === 'POST' && (req.url === '/authorize' || req.url === '/cancel')) {
        let body = '';
        for await (const chunk of req) {
          body += String(chunk);
          if (body.length > 128) { res.writeHead(413).end('{}'); return; }
        }
        const parsed = WriteId.safeParse(JSON.parse(body));
        if (!parsed.success) { res.writeHead(400).end('{}'); return; }
        const pending = writes.get(parsed.data.id);
        if (req.url === '/cancel') {
          if (pending) {
            pending.controller.abort();
            if (!pending.started) {
              clearTimeout(pending.timer);
              writes.delete(parsed.data.id);
              pending.finish();
            }
            // Acknowledge only after the write handler has stopped using its signal.
            await pending.settled;
          }
        } else {
          if (!pending?.ready || pending.controller.signal.aborted) { res.writeHead(409).end('{}'); return; }
          pending.authorize();
        }
        res.end('{}');
      } else if (req.method === 'PUT' && (req.url === '/setting' || req.url === '/cloud-agent')) {
        let body = '';
        for await (const chunk of req) {
          body += String(chunk);
          if (body.length > 128) { res.writeHead(413).end('{}'); return; }
        }
        const beginWrite = () => {
          const id = WriteId.shape.id.parse(req.headers['x-wayroost-write']);
          const pending = writes.get(id);
          if (!pending || pending.started) throw new Error('Unknown Safety write.');
          writeId = id;
          pending.started = true;
          controller = pending.controller;
          controller.signal.throwIfAborted();
          return async () => {
            pending.ready = true;
            res.writeProcessing();
            await waitWithAbort(pending.authorized, controller.signal);
            controller.signal.throwIfAborted();
          };
        };
        if (req.url === '/cloud-agent') {
          const parsed = CloudWrite.safeParse(JSON.parse(body));
          if (!parsed.success) { res.writeHead(400).end('{}'); return; }
          if (!setting.setCloudAgentEnabled) { res.writeHead(404).end('{}'); return; }
          const authorize = beginWrite();
          await setting.setCloudAgentEnabled(parsed.data.id, parsed.data.enabled, controller.signal, authorize);
          res.end('{}');
        } else {
          const parsed = WorkerApprovalsWrite.safeParse(JSON.parse(body));
          if (!parsed.success) { res.writeHead(400).end('{}'); return; }
          const authorize = beginWrite();
          res.end(JSON.stringify(await setting.setEnabled(parsed.data.enabled, controller.signal, authorize)));
        }
      } else {
        req.resume();
        res.writeHead(404).end('{}');
      }
    } catch {
      if (!res.destroyed) res.writeHead(503).end('{}');
    } finally {
      req.off('aborted', abort);
      res.off('close', disconnected);
      if (writeId) {
        const pending = writes.get(writeId);
        if (pending) {
          clearTimeout(pending.timer);
          writes.delete(writeId);
          pending.finish();
        }
      }
    }
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  server.on('connection', socket => socket.setTimeout(15_000, () => socket.destroy()));
  server.on('close', () => {
    for (const pending of writes.values()) { clearTimeout(pending.timer); pending.controller.abort(); pending.finish(); }
    writes.clear();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); resolve(); });
  });
  chmodSync(path, 0o660);
  return server;
}

export class SafetyHelperClient implements WorkerApprovalsApi, PaseoConfigWriter {
  private last = pendingWorkerApprovals();
  private readonly active = new Set<{ owner?: AbortSignal; cancel(): Promise<void> }>();
  private readonly revoking = new Map<AbortSignal, number>();
  constructor(private readonly path: string, private readonly key: string) {}

  async status(): Promise<WorkerApprovalsStatus> {
    try { this.last = WorkerApprovalsStatus.parse(await this.call('/status', 'GET', undefined, deviceSignal())); return this.last; }
    // A cached choice may predate a committed write whose response was lost.
    catch { return { ...this.last, choiceConfirmed: false, config: 'pending', application: 'pending', reload: 'pending', message: 'The Safety helper is unavailable; its saved policy has not been confirmed.' }; }
  }

  async setEnabled(enabled: boolean, signal?: AbortSignal): Promise<WorkerApprovalsStatus> {
    try { this.last = WorkerApprovalsStatus.parse(await this.write('/setting', { enabled }, actionSignal(signal))); return this.last; }
    catch { throw new UserFacingError('The Safety helper could not save the setting. Check its status and retry.', 424); }
  }

  async setCloudAgentEnabled(id: CloudAgentId, enabled: boolean, signal?: AbortSignal): Promise<void> {
    this.last = { ...this.last, config: 'pending', reload: 'pending', application: 'pending' };
    try { z.object({}).strict().parse(await this.write('/cloud-agent', { id, enabled }, actionSignal(signal))); }
    catch { throw new UserFacingError('The Safety helper could not verify the cloud agent switch. Check its status and retry.', 424); }
  }

  async cancelPending(signal: AbortSignal): Promise<() => void> {
    this.revoking.set(signal, (this.revoking.get(signal) ?? 0) + 1);
    const release = () => {
      const remaining = (this.revoking.get(signal) ?? 1) - 1;
      if (remaining) this.revoking.set(signal, remaining);
      else this.revoking.delete(signal);
    };
    try {
      await Promise.all([...this.active].filter(write => write.owner === signal).map(write => write.cancel()));
      return release;
    } catch {
      release();
      throw new UserFacingError('The Safety helper could not confirm cancellation. Retry device revocation.', 424);
    }
  }

  private async write(route: string, body: object, signal?: AbortSignal): Promise<unknown> {
    const owner = deviceSignal() ?? signal;
    checkDeviceSignal(signal);
    if (owner && this.revoking.has(owner)) throw new Error('Device revocation is pending.');
    let cancelled = false;
    let cancellation: Promise<void> | undefined;
    const begun = this.call('/begin', 'POST', {});
    const id = begun.then(value => WriteId.parse(value).id);
    const pending = {
      owner,
      cancel: () => {
        cancelled = true;
        return cancellation ??= id.then(async id => { await this.call('/cancel', 'POST', { id }); }, () => {})
          .then(() => { this.active.delete(pending); })
          .catch(error => { cancellation = undefined; throw error; });
      },
    };
    this.active.add(pending);
    const abort = () => { void pending.cancel().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const writeId = await id;
      if (cancelled || signal?.aborted) { await pending.cancel(); throw new Error('Safety write cancelled.'); }
      const result = await this.call(route, 'PUT', body, undefined, writeId, () => {
        if (cancelled || signal?.aborted) return pending.cancel();
        checkDeviceSignal(signal);
        return this.call('/authorize', 'POST', { id: writeId }, signal).then(() => {});
      });
      if (cancelled || signal?.aborted) { await pending.cancel(); throw new Error('Safety write cancelled.'); }
      this.active.delete(pending);
      return result;
    } catch (error) {
      await pending.cancel();
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  private call(route = '/status', method = 'GET', input?: object, signal?: AbortSignal, writeId?: string, ready?: () => Promise<void>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const body = input ? JSON.stringify(input) : undefined;
      const req = request({
        signal,
        socketPath: this.path, path: route, method,
        headers: { authorization: `Bearer ${this.key}`, ...(writeId ? { 'x-wayroost-write': writeId } : {}), ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}) },
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
      req.on('information', info => {
        if (info.statusCode === 102 && ready) void ready().catch(error => req.destroy(error as Error));
      });
      const timeout = setTimeout(() => req.destroy(new Error('Safety helper timed out.')), TIMEOUT_MS);
      req.once('close', () => clearTimeout(timeout));
      req.on('error', reject);
      req.end(body);
    });
  }
}
