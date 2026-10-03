import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

// A small stand-in for the Hermes dashboard that speaks the same protocol as
// the real one (see hermes-agent tui_gateway/ and hermes_cli/dashboard_auth/).

export const FAKE_USER = { username: 'owner', password: 'correct horse' };
export const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const STORED = '20260101_120000_abc123';
const RUNTIME = 'a1b2c3d4';

/** Trimmed-down `commands.catalog` answer in the gateway's shape. */
const CATALOG = {
  pairs: [
    ['/new', 'Start a new session (fresh session ID + history) (usage: /new [name])'],
    ['/status', 'Show session, model, token, and context info'],
    ['/yolo', 'Toggle YOLO mode (skip all dangerous command approvals)'],
    ['/clear', 'Clear screen and start a new session'],
    ['/reasoning', 'Manage reasoning effort and display (usage: /reasoning [level|show|hide] [--global])'],
    ['/plan', 'Write an implementation plan'],
    ['/research', 'Deep-dive a topic'],
  ],
  sub: { '/reasoning': ['low', 'medium', 'high', '--global'] },
  canon: { '/new': '/new', '/reset': '/new', '/status': '/status', '/yolo': '/yolo', '/clear': '/clear', '/reasoning': '/reasoning' },
  commands: {
    '/new': { argument_mode: 'text', desktop: null },
    '/reset': { argument_mode: 'text', desktop: null },
    '/status': { argument_mode: null, desktop: null },
    '/yolo': { argument_mode: null, desktop: null },
    '/clear': { argument_mode: null, desktop: 'terminal' },
    '/reasoning': { argument_mode: 'options', desktop: null },
  },
  categories: [
    {
      name: 'Session',
      pairs: [
        ['/new', 'Start a new session (fresh session ID + history) (usage: /new [name])'],
        ['/status', 'Show session, model, token, and context info'],
        ['/clear', 'Clear screen and start a new session'],
      ],
    },
    {
      name: 'Configuration',
      pairs: [
        ['/yolo', 'Toggle YOLO mode (skip all dangerous command approvals)'],
        ['/reasoning', 'Manage reasoning effort and display (usage: /reasoning [level|show|hide] [--global])'],
      ],
    },
  ],
  skills: { '/plan': { usage: 2, origin: 'bundled' }, '/research': { usage: 9, origin: 'user' } },
  skill_count: 2,
  warning: '',
};

export class FakeHermes {
  server!: Server;
  wss!: WebSocketServer;
  url = '';
  socket: WebSocket | undefined;
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  responses: Array<{ id: string; result: unknown }> = [];
  /** Per-test answers for RPCs; return `{ error: { code, message } }` to fail one. */
  handlers: Record<string, (params: Record<string, unknown>) => unknown> = {};
  /** Query strings of /api/fs/download requests. */
  downloads: Array<Record<string, string>> = [];
  /**
   * Requests still waiting on a client: Hermes' in-memory registry (server_requests.py `_open`).
   * `serverRequest` adds to it; a response frame, `request.answer`, `request.cancel` or an
   * interrupt settles one; `session.resume` of the live session returns them as `open_requests`.
   */
  openRequests: Array<{
    id: string;
    method: string;
    params: Record<string, unknown>;
    /** Owned by a compute-host child: mirrored into snapshots, but not counted as "waiting". */
    hostOwned?: boolean;
  }> = [];
  /** A turn is running in the session (Hermes' `session["running"]`). */
  running = false;
  /** The session is live in this Hermes process; false after `restart()` until something resumes it. */
  live = true;
  /** The session's stored id, which moves when Hermes continues it under a new one. */
  sessionKey = STORED;
  /** Resumes of the session while it wasn't live (only these can re-run a lost turn). */
  coldResumes = 0;
  /** Turns Hermes re-ran on its own after a crash (auto-continue). */
  reruns = 0;
  /** The crash marker a turn leaves when Hermes dies mid-turn (tui_gateway/turn_marker.py). */
  private crashMarker = false;
  /** A user's prompt started after the last cold resume: auto-continue then stands down. */
  private promptedSinceResume = false;
  /** `session["_turn_cancel_requested"]`: set by an interrupt, cleared by the next prompt. */
  private cancelRequested = false;
  /** Top-level chats, as `GET /api/sessions` lists them. */
  topLevel: Array<Record<string, unknown>> = [
    {
      id: STORED,
      source: 'desktop',
      title: 'Fix the build',
      preview: 'Can you fix the failing build?',
      model: 'anthropic/claude-sonnet-5',
      started_at: 1790489729,
      last_active: 1790490112,
      message_count: 4,
    },
  ];
  /** delegate_task runs, listed only by a query that excludes `subagent` while show_subagents is on. */
  subagentRuns: Array<Record<string, unknown>> = [];
  /** `sessions.show_subagents` in the user's config. */
  showSubagents = true;
  /** This Hermes knows `sessions.show_subagents` (it's in `/api/config/defaults`). */
  supportsSubagents = true;
  /** Hermes-in-Paseo sessions (`source=acp`). */
  acpSessions: Array<Record<string, unknown>> = [];
  /** Scheduled-job runs (`source=cron`), as the cron section of the desktop app lists them. */
  cronRuns: Array<Record<string, unknown>> = [];
  /** Live cron job states and claims (`GET /api/cron/jobs`); null answers 500. */
  cronJobs: unknown = [];
  /** Override a cron history page to test incomplete or malformed replies. */
  cronPage?: (query: Record<string, string>) => unknown;
  /**
   * The gateway part of `GET /api/status` (hermes_cli/web_routers/status.py): whether the
   * messaging gateway runs and its in-flight work count. null answers 500.
   */
  apiStatus: Record<string, unknown> | null = {
    gateway_running: true, gateway_state: 'running', active_agents: 0,
    gateway_updated_at: new Date().toISOString(), gateway_heartbeat_stale_s: null, gateway_shared_with: null,
  };
  /** Raw runtime evidence, when supplied: /api/status exposes only its normalized count. */
  apiRuntime?: Record<string, unknown> | null;
  profileRuntime: Record<string, Record<string, unknown> | null> = {};
  /** Profile roster and scoped replies, including failures hidden by aggregate endpoints. */
  apiProfiles: unknown = { profiles: [{ name: 'default' }] };
  profileStatus: Record<string, Record<string, unknown> | null> = {};
  profileCronJobs: Record<string, unknown> = {};
  profileCronRuns: Record<string, Array<Record<string, unknown>>> = {};
  profileQueries: Array<{ path: string; profile: string | null }> = [];
  /** Detail rows (`GET /api/sessions/<id>`), by id. */
  details: Record<string, Record<string, unknown>> = {};
  /** Query strings of every `GET /api/sessions`. */
  listQueries: Array<Record<string, string>> = [];
  /** Archived chats (`PATCH /api/sessions/<id>` with `archived`); lists leave them out unless asked. */
  archived = new Set<string>();
  /** Every `PATCH /api/sessions/<id>`, in order. */
  patches: Array<{ id: string; body: Record<string, unknown> }> = [];
  /** Every `DELETE /api/sessions/<id>`, in order. */
  deletes: string[] = [];
  /** `GET /api/config/defaults` requests (the sub-agent version check). */
  defaultsRequests = 0;
  /** What `GET /api/chat/workspaces` says a chat with no folder runs in; null: an older Hermes without it. */
  defaultCwd: string | null = '/home/me';
  workspaceRequests = 0;
  logins = 0;
  private seq = 0;
  private tokens = new Set<string>();
  private tickets = new Set<string>();

  static readonly stored = STORED;
  static readonly runtime = RUNTIME;

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.http(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      const ticket = new URL(req.url!, 'http://x').searchParams.get('ticket');
      if (!ticket || !this.tickets.delete(ticket)) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onSocket(ws));
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    await new Promise((resolve) => this.server.close(resolve));
  }

  /** The socket drops (a network blip); Hermes keeps running with everything it had open. */
  disconnect(): void {
    for (const client of this.wss.clients) client.terminate();
  }

  /**
   * Hermes is killed and started again (`systemctl stop` then start): its registries were
   * only in memory, nothing sent `request.cancel`, and no session is live until resumed.
   */
  restart(): void {
    // A turn killed mid-run never clears its marker; the next cold resume auto-continues it.
    this.crashMarker = this.running;
    this.openRequests = [];
    this.running = false;
    this.live = false;
    this.disconnect();
  }

  /** Like `_session_live_status`: waiting on a request, else working while a turn runs, else idle. */
  status(): 'waiting' | 'working' | 'idle' {
    return this.openRequests.some((r) => !r.hostOwned) ? 'waiting' : this.running ? 'working' : 'idle';
  }

  /** Remove one open request; false when it wasn't open (already settled, or never was). */
  private settle(id: unknown): boolean {
    const before = this.openRequests.length;
    this.openRequests = this.openRequests.filter((r) => r.id !== id);
    return this.openRequests.length < before;
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  }

  private authed(req: IncomingMessage): boolean {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    return this.tokens.has(token);
  }

  private async http(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(req.url!, 'http://x');
    const json = (status: number, body: unknown, headers: Record<string, string | string[]> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'POST' && url.pathname === '/auth/password-login') {
      const body = await this.body(req);
      this.logins += 1;
      if (body.provider !== 'basic' || body.username !== FAKE_USER.username || body.password !== FAKE_USER.password) {
        return json(401, { detail: 'Invalid credentials' });
      }
      const at = `AT${this.logins}==`;
      this.tokens.add(at);
      return json(200, { ok: true, next: '/' }, {
        'set-cookie': [
          `hermes_session_at="${at}"; HttpOnly; Max-Age=43200; Path=/; SameSite=lax`,
          `hermes_session_rt="RT${this.logins}=="; HttpOnly; Max-Age=2592000; Path=/; SameSite=lax`,
          'hermes_session_provider=basic; HttpOnly; Path=/; SameSite=lax',
        ],
      });
    }
    if (url.pathname === '/api/auth/me') {
      if (!this.authed(req)) return json(401, { error: 'unauthenticated' });
      return json(200, { user_id: 'owner', provider: 'basic', expires_at: Math.floor(Date.now() / 1000) + 43200 });
    }
    if (!this.authed(req)) return json(401, { error: 'session_expired' });

    if (req.method === 'POST' && url.pathname === '/api/auth/ws-ticket') {
      const ticket = `ticket-${++this.seq}`;
      this.tickets.add(ticket);
      return json(200, { ticket, ttl_seconds: 30 });
    }
    if (url.pathname === '/api/fs/download') {
      this.downloads.push(Object.fromEntries(url.searchParams));
      const path = url.searchParams.get('path') ?? '';
      if (path.includes('secret')) return json(403, { detail: 'Access to sensitive files is not allowed' });
      if (path.endsWith('huge.png')) {
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(50 * 1024 * 1024) });
        res.end();
        return;
      }
      if (!path.endsWith('garden.png')) return json(404, { detail: 'File not found' });
      res.writeHead(200, { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="garden.png"' });
      res.end(FAKE_PNG);
      return;
    }
    if (url.pathname === '/api/profiles') {
      if (this.apiProfiles === null) return json(500, { detail: 'Internal Server Error' });
      return json(200, this.apiProfiles);
    }
    const profile = url.searchParams.get('profile');
    if (url.pathname === '/api/status') {
      this.profileQueries.push({ path: url.pathname, profile });
      const status = profile && Object.hasOwn(this.profileStatus, profile) ? this.profileStatus[profile] : this.apiStatus;
      if (!status) return json(500, { detail: 'Internal Server Error' });
      const runtime = profile && Object.hasOwn(this.profileRuntime, profile) ? this.profileRuntime[profile] : this.apiRuntime;
      const raw = runtime?.active_agents;
      // gateway.status.parse_active_agents: missing/invalid values become zero, fractions truncate.
      const count = typeof raw === 'number' || typeof raw === 'boolean' ? Number(raw)
        : typeof raw === 'string' && /^[+-]?\d+$/.test(raw.trim()) ? Number(raw) : 0;
      const normalized = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
      return json(200, {
        version: '0.0.0-demo', ...status,
        ...(runtime !== undefined ? { active_agents: normalized } : {}),
      });
    }
    if (url.pathname === '/api/cron/jobs') {
      this.profileQueries.push({ path: url.pathname, profile });
      const jobs = profile && Object.hasOwn(this.profileCronJobs, profile) ? this.profileCronJobs[profile] : this.cronJobs;
      if (jobs === null) return json(500, { detail: 'Internal Server Error' });
      return json(200, jobs);
    }
    if (url.pathname === '/api/chat/workspaces') {
      // hermes_cli/web_routers/chat_workspaces.py
      this.workspaceRequests += 1;
      if (this.defaultCwd === null) return json(404, { detail: 'Not Found' });
      return json(200, { projects: [], repos: [], default_cwd: this.defaultCwd, home: '/home/me', scan_enabled: false });
    }
    if (url.pathname === '/api/config/defaults') {
      this.defaultsRequests += 1;
      return json(200, { sessions: { retention_days: 90, ...(this.supportsSubagents ? { show_subagents: false } : {}) } });
    }
    if (url.pathname === '/api/sessions') {
      const query = Object.fromEntries(url.searchParams);
      this.listQueries.push(query);
      if (query.source === 'acp') return json(200, { sessions: this.acpSessions, total: this.acpSessions.length });
      if (query.source === 'cron') {
        if (this.cronPage) return json(200, this.cronPage(query));
        const offset = Number(query.offset ?? 0);
        const runs = profile && Object.hasOwn(this.profileCronRuns, profile) ? this.profileCronRuns[profile]! : this.cronRuns;
        return json(200, { sessions: runs.slice(offset, offset + Number(query.limit ?? 20)), total: runs.length });
      }
      // hermes_cli/session_listing.py: excluding `subagent` asks for the runs, given show_subagents.
      const wantsRuns = (query.exclude_sources ?? '').split(',').includes('subagent') && this.showSubagents;
      const archived = query.archived ?? 'exclude';
      const offset = Number(query.offset ?? 0);
      const sessions = [...this.topLevel, ...(wantsRuns ? this.subagentRuns : [])]
        .filter((row) => {
          const isArchived = this.archived.has(String(row.id));
          return archived === 'include' || (archived === 'only' ? isArchived : !isArchived);
        })
        .filter((row) => !query.cwd_prefix || String(row.cwd ?? '').startsWith(query.cwd_prefix))
        .slice(offset, offset + Number(query.limit ?? 20));
      return json(200, { sessions, total: sessions.length });
    }
    const one = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
    const oneId = one ? decodeURIComponent(one[1]!) : '';
    if (one && req.method === 'PATCH') {
      const body = await this.body(req);
      this.patches.push({ id: oneId, body });
      if (typeof body.archived === 'boolean') {
        if (body.archived) this.archived.add(oneId);
        else this.archived.delete(oneId);
      }
      return json(200, { ok: true });
    }
    if (one && req.method === 'DELETE') {
      this.deletes.push(oneId);
      this.topLevel = this.topLevel.filter((row) => row.id !== oneId);
      this.archived.delete(oneId);
      return json(200, { ok: true });
    }
    const detail = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
    if (detail && this.details[decodeURIComponent(detail[1]!)]) return json(200, this.details[decodeURIComponent(detail[1]!)]);
    const runMessages = /^\/api\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
    const runId = runMessages ? decodeURIComponent(runMessages[1]!) : '';
    if (runId && runId !== STORED && (this.subagentRuns.some((r) => r.id === runId) || this.details[runId])) {
      return json(200, { session_id: runId, messages: [{ id: 901, role: 'assistant', content: 'Found the flaky test.' }] });
    }
    if (url.pathname === `/api/sessions/${STORED}/messages`) {
      return json(200, {
        session_id: STORED,
        messages: [
          { id: 101, role: 'user', content: 'List files\n@image:/tmp/x.png', timestamp: 1790489730.2 },
          {
            id: 102,
            role: 'assistant',
            content: '',
            reasoning: "I'll run ls",
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'terminal', arguments: '{"command":"ls"}' } }],
          },
          { id: 103, role: 'tool', content: '{"output":"a.txt","exit_code":0}', tool_call_id: 'call_1', tool_name: 'terminal' },
          { id: 104, role: 'assistant', content: 'There is one file: `a.txt`.' },
          { id: 105, role: 'system', content: 'hidden', display_kind: 'hidden' },
        ],
      });
    }
    return json(404, { detail: 'not found' });
  }

  private send(frame: object): void {
    this.socket?.send(JSON.stringify(frame));
  }

  /** Send an event, keeping the session's own state (running, open requests, stored id) in step. */
  event(type: string, payload?: object, sessionId = RUNTIME): void {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (sessionId === RUNTIME) {
      if (type === 'message.start') this.running = true;
      if (type === 'message.complete') this.running = false;
      if (type === 'session.info' && typeof p.running === 'boolean') this.running = p.running;
      if (type === 'session.info' && typeof p.stored_session_id === 'string') this.sessionKey = p.stored_session_id;
    }
    if (type === 'request.cancel') this.settle(p.id);
    this.send({ jsonrpc: '2.0', method: 'event', params: { type, session_id: sessionId, payload, seq: ++this.seq } });
  }

  /** Ask the client something (registered as open until it's settled). */
  serverRequest(id: string, method: string, params: Record<string, unknown>, options: { hostOwned?: boolean } = {}): void {
    if (!this.openRequests.some((r) => r.id === id)) this.openRequests.push({ id, method, params, ...options });
    this.send({ jsonrpc: '2.0', id, method, params: { session_id: RUNTIME, ...params } });
  }

  /** Hermes drops an open request without telling anyone (the process died, or the event was lost). */
  forgetRequest(id: string): void {
    this.settle(id);
  }

  private onSocket(ws: WebSocket): void {
    this.socket = ws;
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: { type: 'gateway.ready', payload: { replay_epoch: 'epoch-1', heartbeat: true } },
      }),
    );
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as { id: string; method?: string; params?: Record<string, unknown>; result?: unknown };
      if (!frame.method) {
        // A client's answer. Like resolve_response, one for a request no longer open is dropped.
        this.responses.push({ id: frame.id, result: frame.result });
        this.settle(frame.id);
        return;
      }
      this.calls.push({ method: frame.method, params: frame.params ?? {} });
      const reply = (result: unknown) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }));
      const handler = this.handlers[frame.method];
      if (handler) {
        void Promise.resolve(handler(frame.params ?? {})).then((answer) => {
          const error = (answer as { error?: unknown } | undefined)?.error;
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, ...(error ? { error } : { result: answer }) }));
        });
        return;
      }
      switch (frame.method) {
        case 'client.capabilities':
          return reply({ server_requests: ['approval', 'clarify'] });
        case 'gateway.ping':
          return reply({ ok: true });
        case 'session.active_list':
          // Live sessions in this process only (methods_session.py `session.active_list`).
          return reply({ sessions: this.live ? [{ id: RUNTIME, session_key: this.sessionKey, status: this.status() }] : [] });
        case 'session.resume': {
          if (!this.live) {
            // A cold resume (not live in this process) carries no open requests (_resume_response).
            this.live = true;
            this.coldResumes += 1;
            this.promptedSinceResume = false;
            const marker = this.crashMarker;
            this.crashMarker = false;
            reply({
              session_id: RUNTIME,
              running: false,
              status: 'idle',
              inflight: null,
              ...(marker ? { auto_continue: { attempt: 1, interrupted_at: Date.now() / 1000 - 60 } } : {}),
            });
            // Auto-continue (session_auto_continue.py): once the agent is built, re-run the
            // lost turn, unless a user's prompt started first.
            if (marker) {
              setTimeout(() => {
                if (this.promptedSinceResume || this.running || this.cancelRequested) return;
                this.reruns += 1;
                this.event('status.update', { kind: 'process', text: 'Resuming interrupted turn…' });
                this.event('message.start');
              }, 50);
            }
            return;
          }
          // The live session (_live_session_payload): open requests as sent, session_id included.
          const open = this.openRequests.map((r) => ({ id: r.id, method: r.method, params: { session_id: RUNTIME, ...r.params } }));
          return reply({
            session_id: RUNTIME,
            running: this.running,
            status: this.status(),
            ...(open.length ? { open_requests: open } : {}),
          });
        }
        case 'session.create':
          return reply({ session_id: 'feedbeef', stored_session_id: '20260927_070000_aaaaaa', messages: [] });
        case 'prompt.submit':
          this.promptedSinceResume = true;
          this.cancelRequested = false;
          return reply({ status: 'streaming', user_row_id: 200 });
        case 'session.interrupt':
          // Like _clear_pending: every open request of the session is withdrawn with request.cancel.
          for (const r of [...this.openRequests]) this.event('request.cancel', { id: r.id, method: r.method, reason: 'interrupted' });
          this.running = false;
          this.cancelRequested = true;
          return reply({ status: 'interrupted' });
        case 'request.answer':
          // Resolves an open request; one that already ended is "expired" and nothing changes.
          return reply({ status: this.settle(frame.params?.id) ? 'ok' : 'expired' });
        case 'image.attach_bytes':
          return reply({ attached: true, path: `/hermes/images/upload_${this.seq++}.png`, count: 1 });
        case 'file.attach': {
          const name = String(frame.params?.name ?? 'file');
          return reply({ attached: true, name, path: `/hermes/attachments/${name}`, ref_text: `@file:/hermes/attachments/${name}` });
        }
        case 'image.detach':
          return reply({ detached: true, count: 0 });
        case 'commands.catalog':
          return reply(CATALOG);
        case 'slash.exec': {
          const command = String(frame.params?.command ?? '');
          if (command.startsWith('plan')) {
            return ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: 4018, message: 'skill command: use command.dispatch for /plan' } }));
          }
          if (command.startsWith('undo')) return reply({ type: 'prefill', message: 'Run the tests', notice: '↶ Undid 1 turn (2 message(s)).' });
          return reply({ output: `\u001b[1mran ${command}\u001b[0m` });
        }
        case 'command.dispatch':
          return reply({
            type: 'skill',
            name: 'plan',
            message: '[IMPORTANT: The user has invoked the "plan" skill… (long body)]',
            display: `/plan ${String(frame.params?.arg ?? '')}`.trim(),
          });
        default:
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'unknown method' } }));
      }
    });
  }
}
