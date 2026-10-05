import { checkDeviceSignal, deviceSignal } from './security/device-signal.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import type { ClientRequest } from 'node:http';
import { z } from 'zod';
import { SUPERVISOR_ROUTES, SUPERVISOR_VERBS } from '../../shared/supervisor.js';
import type {
  ActionDetail,
  ActionRequest,
  ActionSummary,
  BusyError,
  ComponentState,
  SupervisorEvent,
  SupervisorStatus,
  SupervisorVerb,
} from '../../shared/supervisor.js';
import { UserFacingError } from './sources.js';
import { parseSupervisorKey } from './supervisor-key.js';
import type { Logger } from './hermes/adapter.js';
import {
  CONFIG_ROUTES, configRequestStatusRequestSchema, configRequestStatusResultSchema, type ConfigRequestStatusResult, configReadRequestSchema, configReadResultSchema, configApplyRequestSchema, configUndoRequestSchema,
  configWriteResultSchema, credentialWriteRequestSchema, credentialWriteResultSchema, credentialTestRequestSchema,
  credentialTestResultSchema, drainRestartRequestSchema, drainRestartResultSchema, usageSummaryRequestSchema,
  usageSummaryResultSchema, configVerbsStatusSchema,
  type ConfigReadRequest, type ConfigReadResult, type ConfigApplyRequest, type ConfigUndoRequest, type ConfigWriteResult,
  type CredentialWriteRequest, type CredentialTestRequest, type DrainRestartRequest, type UsageSummaryRequest,
} from '../../shared/supervisor-config.js';
import { projectScanRequestSchema, projectScanResultSchema, checksObserveResultSchema, type ProjectScanRequest, type ProjectScanResult, type ChecksObserveResult } from '../../shared/supervisor-observations.js';

// The supervisor, from this server's side. It runs as root
// and listens on a Unix socket that only this server may open; the key comes
// from a file (a systemd credential in production) and is read once, here, and
// never logged. Everything else in the server talks to the small
// SupervisorApi below, so tests can hand in a fake.

const STATUS_TIMEOUT_MS = 3_000;
const ACT_TIMEOUT_MS = 10_000;
/** No bytes on an open event stream for this long: treat it as dead and redial. */
const STREAM_IDLE_MS = 45_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
/**
 * The supervisor's own bounds on an action's output (its output.ts): it keeps the
 * last 200 progress lines, each cut to 4096 characters, and action events carry
 * the summary only. A line or a history longer than that is cut here the same
 * way rather than throwing the whole record away.
 */
const OUTPUT_LINES = 200;
const LINE_LENGTH = 4_096;
/**
 * A reply or a buffered frame bigger than this isn't the supervisor behaving
 * normally: room for a full action record (every line full, every character
 * escaped as \uXXXX in JSON) with 64 KiB to spare, about 4.8 MiB.
 */
const MAX_REPLY_BYTES = OUTPUT_LINES * LINE_LENGTH * 6 + 64 * 1024;
const MAX_FRAME_BYTES = MAX_REPLY_BYTES;

// What the supervisor says back, checked before any of it reaches a page. The
// contract shapes live in shared/supervisor.ts; these accept them loosely (a
// field we don't know about is dropped, not an error) so an older or newer
// supervisor still works.
const COMPONENT_STATES = ['up', 'starting', 'down', 'held', 'failing'] as const satisfies readonly ComponentState[];
const State = z.enum(COMPONENT_STATES);
const Verb = z.enum(SUPERVISOR_VERBS as unknown as [SupervisorVerb, ...SupervisorVerb[]]);
const ModelProfile = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  loadSeconds: z.number().nonnegative().optional(),
  gpus: z.array(z.number().int().nonnegative()).default([]),
});
const ComponentStatus = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  state: State,
  sentence: z.string().max(500),
  since: z.number().optional(),
  busy: z.boolean().optional(),
  actions: z.array(Verb).default([]),
  model: z.object({ live: z.string().nullable(), profiles: z.array(ModelProfile) }).optional(),
  details: z.record(z.string(), z.string()).optional(),
});
const ActionSummarySchema = z.object({
  id: z.string().min(1).max(200),
  verb: Verb,
  target: z.string().min(1).max(200),
  profile: z.string().max(200).optional(),
  state: z.enum(['queued', 'waiting-for-idle', 'running', 'done', 'failed', 'cancelled']),
  caller: z.string().max(200).default(''),
  startedAt: z.number().default(0),
  endedAt: z.number().optional(),
});
/** One progress line, cut to the supervisor's length rather than refused. */
const Line = z.string().transform((line) => line.slice(0, LINE_LENGTH));
const ActionDetailSchema = ActionSummarySchema.extend({
  // The newest lines, as many as the supervisor keeps.
  lines: z
    .array(Line)
    .default([])
    .transform((lines) => lines.slice(-OUTPUT_LINES)),
  // Plain text, or diagnostics as one JSON object; bounded by the reply size.
  result: z.string().optional(),
});
const NotSetUp = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  sentence: z.string().max(500),
});
const StatusSchema = z.object({
  overall: z.enum(['ok', 'attention', 'down']),
  sentence: z.string().max(500),
  components: z.array(ComponentStatus),
  // Components this PC hasn't configured yet, each with the reason a page shows.
  notSetUp: z.array(NotSetUp).optional(),
  // The whole PC, from the counts this server pushes: what "when idle" waits on.
  busy: z.enum(['idle', 'busy', 'unknown']).optional(),
  running: ActionSummarySchema.optional(),
  at: z.number().default(0),
  configVerbs: configVerbsStatusSchema.optional(),
});
const BusySchema = z.object({
  error: z.literal('busy'),
  message: z.string().max(500),
  running: ActionSummarySchema,
});
const AcceptedSchema = z.union([
  z.object({ actionId: z.string().min(1).max(200) }).strict(),
  z.object({ accepted: z.literal(true), action: ActionSummarySchema }).strict(),
]);
const StreamEventSchema = z.union([
  z.object({ type: z.literal('status'), status: StatusSchema }).strict(),
  z.object({ type: z.literal('usage_changed') }).strict(),
  z.object({ type: z.literal('action'), action: ActionSummarySchema }).strict(),
  z.object({ type: z.literal('line'), actionId: z.string().min(1).max(200), line: Line }).strict(),
]);

export interface SupervisorStreamHandlers {
  /** Every event the supervisor sends: status snapshots, action state, progress lines. */
  event(event: SupervisorEvent): void;
  /** The stream dropped and won't say more until it reconnects. */
  lost(): void;
}

/**
 * What POST /v1/busy takes: how many Paseo turns and Hermes turns are running and
 * how many calls are up. Counts only, never titles or content.
 */
export interface BusyCounts {
  paseoRunning: number;
  hermesRunning: number;
  calls: number;
}

/** What the server needs from the supervisor; a fake of this drives the tests. */
export interface SupervisorApi {
  /** The full snapshot now, or null when the supervisor isn't answering. */
  status(): Promise<SupervisorStatus | null>;
  /** Watch the event stream, reconnecting with back-off, until the result is called. */
  events(handlers: SupervisorStreamHandlers): () => void;
  /** Queue a lifecycle action; a BusyError comes back instead of throwing. */
  act(request: ActionRequest): Promise<ActionSummary | BusyError>;
  /**
   * One action with its progress lines, or null when the supervisor doesn't know
   * the id. Throws a UserFacingError when it can't say (not answering, or an
   * answer that isn't an action record), so that isn't mistaken for "no such action".
   */
  action(id: string): Promise<ActionDetail | null>;
  /** Tell it what is running, so "when idle" knows when to go; false when it didn't take them. */
  reportBusy(counts: BusyCounts): Promise<boolean>;
  configRequestStatus?(request: { requestId: string }): Promise<ConfigRequestStatusResult>;
  configRead?(request: ConfigReadRequest): Promise<ConfigReadResult>;
  configApply?(request: ConfigApplyRequest): Promise<ConfigWriteResult>;
  configUndo?(request: ConfigUndoRequest): Promise<ConfigWriteResult>;
  credentialWrite?(request: CredentialWriteRequest): Promise<z.infer<typeof credentialWriteResultSchema>>;
  credentialTest?(request: CredentialTestRequest): Promise<z.infer<typeof credentialTestResultSchema>>;
  drainRestart?(request: DrainRestartRequest): Promise<z.infer<typeof drainRestartResultSchema>>;
  drainRestartRun?(id: string): Promise<z.infer<typeof drainRestartResultSchema>>;
  projectScan?(request: ProjectScanRequest): Promise<ProjectScanResult>;
  checksObserve?(): Promise<ChecksObserveResult>;
  usageSummary?(request: UsageSummaryRequest): Promise<z.infer<typeof usageSummaryResultSchema>>;
}

interface Reply {
  status: number;
  body: Buffer;
}

const NOT_RUNNING = 'The supervisor is not answering.';

/** The socket isn't there, the supervisor isn't answering, or it answered late. */
class SupervisorUnreachable extends Error {}
/** It answered, but with more than any reply of the contract's can hold. */
class SupervisorOversized extends Error {}

/** The request may have committed; callers must observe settings without resending it. */
export class SupervisorConfigUncertain extends Error {
  constructor(readonly code: 'unavailable' | 'failed') { super(code); }
}

export interface SupervisorClientOptions {
  /** Reconnect back-off for the event stream; tests shorten it. */
  backoffMs?: { min: number; max: number };
  /** An open stream that says nothing for this long counts as dead. */
  idleMs?: number;
}

/**
 * The supervisor over its Unix socket. One request per call (the socket is
 * cheap and the supervisor closes idle connections), and one long-lived
 * request for the event stream.
 */
export class SupervisorClient implements SupervisorApi {
  private readonly key: string | undefined;
  private keyWarned = false;

  constructor(
    private readonly socketPath: string,
    private readonly keyFile: string,
    private readonly log: Logger,
    private readonly options: SupervisorClientOptions = {},
  ) {
    this.key = readKey(keyFile, log);
  }

  private auth(): Record<string, string> {
    const key = this.key ?? '';
    return key ? { authorization: `Bearer ${key}` } : {};
  }

  private call(method: string, path: string, body: unknown, timeoutMs: number, signal = deviceSignal()): Promise<Reply> {
    const key = this.key;
    if (!key) {
      if (!this.keyWarned) {
        this.keyWarned = true;
        this.log.warn({ keyFile: this.keyFile }, 'there is no supervisor key to call with');
      }
      return Promise.reject(new SupervisorUnreachable(NOT_RUNNING));
    }
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
      checkDeviceSignal(signal);
      const req = request(
        {
          socketPath: this.socketPath,
          signal,
          method,
          path,
          // A fresh connection each time: the supervisor closes idle ones.
          agent: false,
          headers: {
            host: 'localhost',
            ...this.auth(),
            ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_REPLY_BYTES) {
              res.destroy();
              reject(new SupervisorOversized('The supervisor sent too much back.'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
          res.on('error', () => reject(new SupervisorUnreachable(NOT_RUNNING)));
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', () => reject(new SupervisorUnreachable(NOT_RUNNING)));
      req.end(payload);
    });
  }

  private static json(reply: Reply): unknown {
    try {
      return JSON.parse(reply.body.toString('utf8'));
    } catch {
      return undefined;
    }
  }

  private async configCall<T>(path: string, body: unknown, schema: z.ZodType<T>, write = false, method = 'POST'): Promise<T> {
    let reply: Reply;
    try { reply = await this.call(method, path, body, 35_000); }
    catch {
      if (write) throw new SupervisorConfigUncertain('unavailable');
      return schema.parse({ ok: false, code: 'unavailable' });
    }
    if (reply.status === 401 || reply.status === 403) return schema.parse({ ok: false, code: 'not_permitted' });
    if (reply.status === 404) return schema.parse({ ok: false, code: 'config_writes_off' });
    const result = schema.safeParse(SupervisorClient.json(reply));
    if (result.success && (reply.status >= 200 && reply.status < 300 || (result.data as { ok: boolean }).ok === false
      || reply.status === 409 && path.startsWith(CONFIG_ROUTES.drainRestart) && drainRestartResultSchema.safeParse(result.data).success)) return result.data;
    if (write) throw new SupervisorConfigUncertain('failed');
    return schema.parse({ ok: false, code: 'failed' });
  }

  configRequestStatus(body: { requestId: string }): Promise<ConfigRequestStatusResult> {
    return this.configCall(CONFIG_ROUTES.requestStatus, configRequestStatusRequestSchema.parse(body), configRequestStatusResultSchema);
  }

  configRead(body: ConfigReadRequest): Promise<ConfigReadResult> {
    return this.configCall(CONFIG_ROUTES.read, configReadRequestSchema.parse(body), configReadResultSchema);
  }


  configApply(body: ConfigApplyRequest): Promise<ConfigWriteResult> {
    return this.configCall(CONFIG_ROUTES.apply, configApplyRequestSchema.parse(body), configWriteResultSchema, true);
  }

  configUndo(body: ConfigUndoRequest): Promise<ConfigWriteResult> {
    return this.configCall(CONFIG_ROUTES.undo, configUndoRequestSchema.parse(body), configWriteResultSchema, true);
  }

  credentialWrite(body: CredentialWriteRequest) {
    return this.configCall(CONFIG_ROUTES.credential, credentialWriteRequestSchema.parse(body), credentialWriteResultSchema, true);
  }

  credentialTest(body: CredentialTestRequest) {
    return this.configCall(CONFIG_ROUTES.credentialTest, credentialTestRequestSchema.parse(body), credentialTestResultSchema);
  }

  drainRestart(body: DrainRestartRequest) {
    return this.configCall(CONFIG_ROUTES.drainRestart, drainRestartRequestSchema.parse(body), drainRestartResultSchema, true);
  }
  drainRestartRun(id: string) {
    if (!z.uuid({ version: 'v4' }).safeParse(id).success) return Promise.resolve(drainRestartResultSchema.parse({ ok: false, code: 'invalid_parameters' }));
    return this.configCall(CONFIG_ROUTES.drainRestartRun(id), undefined, drainRestartResultSchema, false, 'GET');
  }
  projectScan(body: ProjectScanRequest) {
    return this.configCall(CONFIG_ROUTES.projectScan, projectScanRequestSchema.parse(body), projectScanResultSchema);
  }
  checksObserve() { return this.configCall(CONFIG_ROUTES.checksObserve, {}, checksObserveResultSchema); }

  usageSummary(body: UsageSummaryRequest) {
    return this.configCall(CONFIG_ROUTES.usage, usageSummaryRequestSchema.parse(body), usageSummaryResultSchema);
  }

  /** The supervisor's own plain sentence when it has one; ours otherwise. */
  private static message(reply: Reply, fallback: string): string {
    const data = SupervisorClient.json(reply) as { message?: unknown } | undefined;
    const message = data?.message;
    return typeof message === 'string' && message.length > 0 && message.length < 200 ? message : fallback;
  }

  async status(): Promise<SupervisorStatus | null> {
    let reply: Reply;
    try {
      reply = await this.call('GET', SUPERVISOR_ROUTES.status, undefined, STATUS_TIMEOUT_MS);
    } catch {
      return null;
    }
    if (reply.status === 401 || reply.status === 403) {
      this.log.warn({ status: reply.status }, 'the supervisor refused our key');
      return null;
    }
    const parsed = StatusSchema.safeParse(SupervisorClient.json(reply));
    return reply.status === 200 && parsed.success ? parsed.data : null;
  }

  async act(request: ActionRequest): Promise<ActionSummary | BusyError> {
    checkDeviceSignal();
    const reply = await this.call('POST', SUPERVISOR_ROUTES.actions, request, ACT_TIMEOUT_MS).catch((err: Error) => {
      checkDeviceSignal();
      if (err instanceof SupervisorOversized) throw new UserFacingError('The supervisor answered in a way we did not expect.', 502);
      throw new UserFacingError(err instanceof SupervisorUnreachable ? NOT_RUNNING : "The supervisor didn't answer.", 503);
    });
    if (reply.status === 409) {
      const busy = BusySchema.safeParse(SupervisorClient.json(reply));
      if (busy.success) return busy.data;
      throw new UserFacingError(SupervisorClient.message(reply, 'Another action is running.'), 409);
    }
    if (reply.status === 400) throw new UserFacingError(SupervisorClient.message(reply, 'The supervisor did not take that action.'), 400);
    if (reply.status === 401 || reply.status === 403) {
      this.log.warn({ status: reply.status }, 'the supervisor refused our key');
      throw new UserFacingError(NOT_RUNNING, 503);
    }
    if (reply.status !== 202 && reply.status !== 200) {
      this.log.warn({ status: reply.status }, 'the supervisor would not take that action');
      throw new UserFacingError(SupervisorClient.message(reply, NOT_RUNNING), 503);
    }
    const accepted = AcceptedSchema.safeParse(SupervisorClient.json(reply));
    if (!accepted.success) throw new UserFacingError('The supervisor answered in a way we did not expect.', 503);
    const data = accepted.data;
    if ('action' in data) return data.action;
    // The supervisor accepted it and will report progress on the event stream;
    // fetch the record once so the caller can show what's running right away.
    return await this.summary(data.actionId, request);
  }

  /**
   * The record the supervisor keeps for an action it just took. If it can't be
   * read, the answer is built from the request, with startedAt 0: we don't know
   * when the supervisor started it, and a time from this server's clock could look
   * newer than a snapshot that already shows the action finished. 0 is also what a
   * record without a start time parses to, and Power never lets a record with no
   * start time outrank what it has heard (power.ts noteAction).
   */
  private async summary(id: string, request: ActionRequest): Promise<ActionSummary> {
    const detail = await this.action(id).catch(() => null);
    if (detail) return stripLines(detail);
    return {
      id,
      verb: request.verb,
      target: request.target,
      ...(request.profile ? { profile: request.profile } : {}),
      state: 'queued',
      caller: 'this app',
      startedAt: 0,
    };
  }

  async action(id: string): Promise<ActionDetail | null> {
    let reply: Reply;
    try {
      reply = await this.call('GET', SUPERVISOR_ROUTES.action(id), undefined, STATUS_TIMEOUT_MS);
    } catch (err) {
      if (!(err instanceof SupervisorOversized)) throw new UserFacingError(NOT_RUNNING, 503);
      this.log.warn({ limit: MAX_REPLY_BYTES }, 'the supervisor sent an action record bigger than any it keeps');
      throw new UserFacingError('That action record is too big to show.', 502);
    }
    if (reply.status === 404) return null;
    if (reply.status === 401 || reply.status === 403) {
      this.log.warn({ status: reply.status }, 'the supervisor refused our key');
      throw new UserFacingError(NOT_RUNNING, 503);
    }
    const parsed = ActionDetailSchema.safeParse(SupervisorClient.json(reply));
    if (reply.status !== 200 || !parsed.success) {
      this.log.warn({ status: reply.status }, 'the supervisor sent something other than an action record');
      throw new UserFacingError('The supervisor answered in a way we did not expect.', 502);
    }
    return parsed.data;
  }

  async reportBusy(counts: BusyCounts): Promise<boolean> {
    let reply: Reply;
    try {
      reply = await this.call('POST', SUPERVISOR_ROUTES.busy, counts, STATUS_TIMEOUT_MS);
    } catch {
      return false;
    }
    // 204 and no body. A refused key is already said by status(); the reporter says
    // once that the counts aren't being taken, not every 10 s.
    return reply.status === 204 || reply.status === 200;
  }

  events(handlers: SupervisorStreamHandlers): () => void {
    const stream = new SupervisorStream(this.socketPath, this.auth(), handlers, this.log, this.options);
    stream.start();
    return () => stream.stop();
  }
}

function stripLines(detail: ActionDetail): ActionSummary {
  const { lines: _lines, result: _result, ...summary } = detail;
  return summary;
}

/** The key file holds one token; only its fingerprint may ever be logged. */
function readKey(path: string, log: Logger): string | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    log.warn({ keyFile: path }, 'the supervisor key file could not be read');
    return undefined;
  }
  const key = text.trim();
  if (!parseSupervisorKey(text)) {
    log.warn({ keyFile: path, length: key.length, sha256: fingerprint(key) }, 'the supervisor key file is not a key');
    return undefined;
  }
  return key;
}

function fingerprint(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/**
 * GET /v1/events kept open: server-sent events, redialled with back-off until
 * someone calls stop(). The supervisor sends a snapshot as soon as a stream
 * opens, so a redial needs nothing else to catch up.
 */
class SupervisorStream {
  private stopped = false;
  private request: ClientRequest | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private readonly backoff: { min: number; max: number };
  private readonly idleMs: number;
  /** Say something the first time a stream fails, and when it returns; not every redial. */
  private complained = false;

  constructor(
    private readonly socketPath: string,
    private readonly auth: Record<string, string>,
    private readonly handlers: SupervisorStreamHandlers,
    private readonly log: Logger,
    options: SupervisorClientOptions = {},
  ) {
    this.backoff = options.backoffMs ?? { min: MIN_BACKOFF_MS, max: MAX_BACKOFF_MS };
    this.idleMs = options.idleMs ?? STREAM_IDLE_MS;
  }

  start(): void {
    this.open();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.closeRequest();
  }

  private closeRequest(): void {
    clearTimeout(this.idle);
    this.idle = undefined;
    const req = this.request;
    this.request = undefined;
    if (req) req.destroy();
  }

  private open(): void {
    if (this.stopped) return;
    let buffer = '';
    let failed = false;
    let afterCr = false;
    /**
     * A frame ends at a blank line, which server-sent events may write as \n\n,
     * \r\n\r\n or \r\r, and a chunk may stop between the \r and the \n of one. So
     * each chunk is added to the buffer with its line endings normalised to \n. A
     * \r ends its line at once (a frame that ends \r\r is whole without waiting
     * for more), and a \n at the start of the next chunk, its other half, is skipped.
     */
    const absorb = (text: string): string => {
      const fresh = afterCr && text.startsWith('\n') ? text.slice(1) : text;
      afterCr = fresh.endsWith('\r');
      return buffer + fresh.replace(/\r\n?/g, '\n');
    };
    const req = request(
      {
        socketPath: this.socketPath,
        method: 'GET',
        path: SUPERVISOR_ROUTES.events,
        agent: false,
        headers: { host: 'localhost', accept: 'text/event-stream', ...this.auth },
      },
      (res) => {
        if (res.statusCode !== 200) {
          failed = true;
          this.complain('the supervisor event stream refused us', { status: res.statusCode });
          res.resume();
          this.retry();
          return;
        }
        if (this.complained) this.log.info({}, 'the supervisor event stream is back');
        this.complained = false;
        this.attempts = 0;
        res.setEncoding('utf8');
        res.on('data', (text: string) => {
          this.touch();
          buffer = absorb(text);
          if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
            this.complain('the supervisor event stream sent more than a frame');
            this.closeRequest();
            this.retry();
            return;
          }
          let split = buffer.indexOf('\n\n');
          while (split >= 0) {
            this.frame(buffer.slice(0, split));
            buffer = buffer.slice(split + 2);
            split = buffer.indexOf('\n\n');
          }
        });
        res.on('end', () => this.retry());
        res.on('error', () => this.retry());
      },
    );
    this.request = req;
    this.touch();
    req.on('error', () => {
      if (!failed) {
        failed = true;
        this.complain('the supervisor socket is not answering');
        this.retry();
      }
    });
    req.on('close', () => {
      if (!this.stopped && this.request === req) this.retry();
    });
    req.end();
  }

  /**
   * Nothing at all for this long means the stream died quietly (the socket is
   * still there, the supervisor behind it isn't).
   */
  private touch(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.complain('the supervisor event stream went quiet');
      this.closeRequest();
      this.retry();
    }, this.idleMs);
    this.idle.unref?.();
  }

  /** One server-sent event; anything we don't recognise is dropped, not fatal. */
  private frame(text: string): void {
    let data = '';
    for (const line of text.split('\n')) {
      if (line.startsWith(':')) continue; // a keep-alive comment
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const field = line.slice(0, colon);
      const value = line.slice(colon + 1).replace(/^ /, '');
      if (field === 'data') data += value;
    }
    if (!data) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const event = StreamEventSchema.safeParse(parsed);
    if (event.success) this.handlers.event(event.data);
  }

  private complain(msg: string, extra: object = {}): void {
    if (this.complained) return;
    this.complained = true;
    this.log.warn(extra, msg);
  }

  private retry(): void {
    if (this.stopped || this.timer) return;
    this.closeRequest();
    this.handlers.lost();
    const cap = Math.min(this.backoff.max, this.backoff.min * 2 ** this.attempts);
    this.attempts += 1;
    const delay = Math.max(this.backoff.min, Math.random() * cap);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.open();
    }, delay);
    this.timer.unref?.();
  }
}
