import { BackgroundGate } from '../server/src/background.js';
// Demo data for Settings → Connectors: an in-memory stand-in for the Hermes
// dashboard routes Connectors calls, and for the helper. A sign-in "completes"
// a moment after the page starts waiting for it.

import type { PhoneStatus, WhatsAppRouting } from '../shared/protocol.js';
import type { AssistApi, AssistMessage } from '../server/src/assist.js';
import type { HelperApi, HelperStatus } from '../server/src/connectors/helper.js';
import type { PaseoRun, PaseoSchedule, PaseoSchedulesApi } from '../server/src/schedules.js';
import { Connectors, GATE_SCRIPT, type Dashboard } from '../server/src/connectors/service.js';

class DemoDashboard implements Dashboard {
  private servers: Record<string, { enabled: boolean; trust?: string }> = {
    notion: { enabled: true, trust: 'untrusted' },
    todoist: { enabled: true, trust: 'full' },
    fireflies: { enabled: true, trust: 'untrusted' },
  };
  private flows: Record<string, { server: string; polls: number }> = {};
  private cron: Record<string, unknown>[] = [
    {
      id: '5c4b3a291827',
      created_at: new Date(Date.now() - 40 * 86400_000).toISOString(),
      name: 'Signalbox: Book club mail',
      prompt: 'A Wayroost mail trigger found new mail…\nWhat to do:\nSummarize it in two lines and tell me if it needs a reply today.',
      script: GATE_SCRIPT,
      workdir: '/home/demo/.hermes/signalbox-triggers/5c4b3a2918273645',
      enabled_toolsets: ['todo', 'no_mcp'],
      schedule: { expr: '*/15 * * * *' },
      enabled: true,
      state: 'scheduled',
      deliver: 'whatsapp',
      last_run_at: new Date(Date.now() - 6 * 60_000).toISOString(),
      last_status: 'ok',
      next_run_at: new Date(Date.now() + 9 * 60_000).toISOString(),
      repeat: { completed: 212 },
    },
    {
      id: 'a1b2c3d4e5f6',
      created_at: new Date(Date.now() - 40 * 86400_000).toISOString(),
      name: 'Morning briefing',
      prompt: 'Check my calendar, the weather and my unread mail, and send me a short summary of the day.',
      schedule: { kind: 'cron', expr: '0 7 * * *', display: 'every day at 7:00' },
      enabled: true,
      state: 'scheduled',
      deliver: 'whatsapp',
      skills: ['google-workspace'],
      enabled_toolsets: ['hermes-cron'],
      last_run_at: new Date(Date.now() - 9 * 3600_000).toISOString(),
      last_status: 'ok',
      next_run_at: new Date(Date.now() + 15 * 3600_000).toISOString(),
      repeat: { completed: 41 },
    },
    {
      id: '0f9e8d7c6b5a',
      created_at: new Date(Date.now() - 40 * 86400_000).toISOString(),
      name: 'Price watch: flights to Lisbon',
      prompt: 'Search nonstop flights to Lisbon for the spring. Message me only if the cheapest fare drops below $350.',
      schedule: { kind: 'interval', minutes: 1440, display: 'every 1440m' },
      schedule_display: 'every day',
      enabled: true,
      state: 'error',
      deliver: 'local',
      skills: ['flight-search'],
      enabled_toolsets: ['web', 'todo', 'kiwi', 'mapbox'],
      last_run_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
      last_status: 'error',
      last_error: 'Model provider unreachable (connection refused)',
      failure_streak: 2,
      next_run_at: new Date(Date.now() + 22 * 3600_000).toISOString(),
      repeat: { completed: 6 },
    },
    {
      id: '123abc456def',
      created_at: new Date(Date.now() - 40 * 86400_000).toISOString(),
      name: 'Weekly digest',
      prompt: 'Summarize this week in AI agents news with links.',
      schedule: { kind: 'cron', expr: '0 9 * * 1', display: 'every Monday at 9:00' },
      enabled: false,
      state: 'paused',
      deliver: 'local',
      skills: ['daily-digest'],
      last_run_at: new Date(Date.now() - 9 * 86400_000).toISOString(),
      last_status: 'ok',
      repeat: { completed: 3 },
    },
  ];
  private seq = 1;

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const ok = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    const name = decodeURIComponent(path.split('/')[4] ?? '');
    if (path === '/api/mcp/servers' && method === 'GET') {
      return ok({ servers: Object.entries(this.servers).map(([n, s]) => ({ name: n, enabled: s.enabled })) });
    }
    if (path.startsWith('/api/config') && method === 'GET') {
      return ok({ mcp_servers: Object.fromEntries(Object.entries(this.servers).map(([n, s]) => [n, { trust: s.trust }])) });
    }
    if (path === '/api/config' && method === 'PUT') {
      const patch = (body.config as { mcp_servers: Record<string, { trust?: string }> }).mcp_servers;
      for (const [n, cfg] of Object.entries(patch)) if (this.servers[n] && cfg.trust) this.servers[n]!.trust = cfg.trust;
      return ok({ ok: true });
    }
    if (path === '/api/messaging/platforms') return ok({ platforms: [{ id: 'whatsapp', state: 'connected' }] });
    if (path.endsWith('/test')) return ok(name === 'fireflies' ? { ok: false, error: 'OAuth authentication required' } : { ok: true });
    if (path === '/api/mcp/catalog/install') {
      this.servers[String(body.name)] = { enabled: true };
      return ok({ ok: true });
    }
    if (path.endsWith('/enabled')) return ok({ ok: true });
    if (path.endsWith('/auth')) {
      const flowId = `demo-flow-${this.seq++}`;
      this.flows[flowId] = { server: name, polls: 0 };
      return ok({ flow_id: flowId, status: 'authorization_required', authorization_url: `https://example.com/sign-in/${name}` });
    }
    if (path.startsWith('/api/mcp/oauth/flows/')) {
      const flow = this.flows[path.split('/').pop()!];
      if (!flow) return ok({ detail: 'expired' }, 404);
      if (method === 'DELETE') return ok({ ok: true });
      flow.polls += 1;
      return ok({ status: flow.polls >= 2 ? 'approved' : 'authorization_required', server_name: flow.server });
    }
    if (path.startsWith('/api/mcp/servers/') && method === 'DELETE') {
      delete this.servers[name];
      return ok({ ok: true });
    }
    if (path === '/api/skills' && method === 'GET') {
      return ok([
        { name: 'directions', description: 'Travel times and routes with live traffic', enabled: true },
        { name: 'watchers', description: 'Poll pages and feeds and report changes', enabled: true },
        { name: 'google-workspace', description: 'Gmail, Calendar and Drive', enabled: true },
        { name: 'flight-search', description: 'Find and compare flights', enabled: true },
      ]);
    }
    if (path === '/api/cron/jobs' && method === 'GET') return ok(this.cron);
    if (path === '/api/cron/delivery-targets') {
      return ok({ targets: [{ id: 'local', home_target_set: true }, { id: 'whatsapp', name: 'WhatsApp', home_target_set: true }] });
    }
    if (path === '/api/cron/jobs' && method === 'POST') {
      const id = (0xabc000000000 + ++this.seq).toString(16);
      this.cron.push({ id, ...body, created_at: new Date().toISOString(), schedule: { expr: body.schedule, display: String(body.schedule) }, enabled: true, state: 'scheduled',
        next_run_at: new Date(Date.now() + 3600_000).toISOString(), repeat: { completed: 0 } });
      return ok({ id });
    }
    const pause = /\/api\/cron\/jobs\/([^/]+)\/(pause|resume)$/.exec(path);
    if (pause) {
      const job = this.cron.find((j) => j.id === pause[1]);
      if (job) {
        job.enabled = pause[2] === 'resume';
        job.state = job.enabled ? 'scheduled' : 'paused';
      }
      return ok({ ok: true });
    }
    const runs = /^\/api\/cron\/jobs\/([^/]+)\/runs/.exec(path);
    if (runs) {
      const job = this.cron.find((j) => j.id === runs[1]);
      if (!job) return ok({ detail: 'not found' }, 404);
      const n = Math.min(Number((job.repeat as { completed?: number } | undefined)?.completed ?? 0), 5);
      return ok({
        runs: Array.from({ length: n }, (_, i) => ({
          id: `cron_${job.id}_2026093${i}_070000`,
          source: 'cron',
          started_at: Date.now() / 1000 - (i + 1) * 86400,
          ended_at: Date.now() / 1000 - (i + 1) * 86400 + 42,
          title: `${job.name as string} run`,
          preview: i === 0 ? 'Busy day: 3 meetings, rain after 4pm, 2 emails need replies today.' : 'All quiet.',
          message_count: 4,
          is_active: false,
        })),
      });
    }
    const trigger = /^\/api\/cron\/jobs\/([^/]+)\/trigger$/.exec(path);
    if (trigger) {
      const job = this.cron.find((j) => j.id === trigger[1]);
      if (job) {
        job.last_run_at = new Date().toISOString();
        job.last_status = 'ok';
        delete job.last_error;
        job.failure_streak = 0;
        if (job.state === 'error') job.state = 'scheduled';
      }
      return ok(job ?? {});
    }
    const put = /^\/api\/cron\/jobs\/([^/]+)$/.exec(path);
    if (put && method === 'PUT') {
      const job = this.cron.find((j) => j.id === put[1]);
      if (!job) return ok({ detail: 'not found' }, 404);
      const u = body.updates as Record<string, unknown>;
      Object.assign(job, u);
      if (typeof u.schedule === 'string') {
        job.schedule = { expr: u.schedule, display: u.schedule };
        delete job.schedule_display;
      }
      return ok(job);
    }
    if (path.startsWith('/api/cron/jobs/') && method === 'DELETE') {
      this.cron = this.cron.filter((j) => j.id !== path.split('/').pop());
      return ok({ ok: true });
    }
    return ok({ detail: 'not in the demo' }, 404);
  }
}

class DemoHelper implements HelperApi {
  private googleState: HelperStatus = { state: 'connected', detail: 'Signed in as you@example.com' };
  private folders: Record<string, string> = { '5c4b3a2918273645': 'from:bookclub.example.org' };
  async health() {
    return true;
  }
  async google() {
    return this.googleState;
  }
  async googleStart() {
    return { url: 'https://example.com/google-sign-in' };
  }
  async googleFinish() {
    this.googleState = { state: 'connected', detail: 'Signed in as you@example.com' };
    return this.googleState;
  }
  async googleDisconnect() {
    this.googleState = { state: 'not-connected' };
    return this.googleState;
  }
  async shops() {
    return { state: 'connected' as const, detail: 'The shopping Chrome is running' };
  }
  async triggerQueries() {
    return { ...this.folders };
  }
  async triggerRoles() {
    return Object.fromEntries(Object.keys(await this.triggerQueries()).map((id) => [id, 'primary' as const]));
  }

  async putTrigger(id: string, query: string) {
    this.folders[id] = query;
    return { role: 'primary' as const, workdir: `/home/demo/.hermes/signalbox-triggers/${id}`, script: GATE_SCRIPT };
  }
  async deleteTrigger(id: string) {
    delete this.folders[id];
  }
  wa: WhatsAppRouting = { installed: true, active: true, replyRouting: true, returnMinutes: 30, freshAfterHours: 4 };
  async whatsappRouting() {
    return { ...this.wa };
  }
  async setWhatsappRouting(settings: Omit<WhatsAppRouting, 'installed' | 'active'>) {
    this.wa = { ...this.wa, ...settings };
    return { ...this.wa };
  }

  phoneState: PhoneStatus = { running: true, ok: true, pinSet: false, ownerNumber: '+15550100000', activeCalls: 0, totalCalls: 3 };
  pin: string | null = null;
  async phone() {
    return { ...this.phoneState, pinSet: this.pin !== null };
  }
  async phonePin() {
    return { pin: this.pin };
  }
  async setPhonePin(pin: string) {
    this.pin = pin;
    return this.phone();
  }

  async setPhoneVoice(voice: string) {
    return { voice };
  }
}

/** The demo helper, shared by Connectors and Settings → WhatsApp. */
export const demoHelper = new DemoHelper();

/** The demo Hermes dashboard, shared by Connectors and Scheduled jobs. */
export const demoDashboard = new DemoDashboard();

export function demoConnectors(publicOrigin: string): Connectors {
  const dashboard = demoDashboard;
  return new Connectors({ background: new BackgroundGate('primary'),
    dashboard: () => dashboard,
    dashboardUrl: 'http://127.0.0.1:9',
    publicOrigin,
    helper: demoHelper,
    log: { info() {}, warn() {} },
  });
}

/** Demo Paseo schedules for Settings → Scheduled jobs. */
class DemoPaseoSchedules implements PaseoSchedulesApi {
  private schedules: PaseoSchedule[] = [
    {
      id: 'sch_nightly_tests',
      name: 'Nightly tests',
      prompt: 'Run the test suite in ~/code/webapp and fix anything that fails. Open a draft PR with the fixes.',
      cadence: { type: 'cron', expression: '0 2 * * *', timezone: 'America/New_York' },
      target: { type: 'new-agent', config: { provider: 'claude', cwd: '/home/demo/code/webapp' } },
      status: 'active',
      createdAt: '2026-09-20T12:00:00Z',
      nextRunAt: new Date(Date.now() + 8 * 3600_000).toISOString(),
      lastRunAt: new Date(Date.now() - 16 * 3600_000).toISOString(),
    },
  ];
  async schedulesList() {
    return this.schedules;
  }
  async scheduleRuns(id: string): Promise<PaseoRun[]> {
    if (id !== 'sch_nightly_tests') return [];
    return [1, 2, 3].map((d) => ({
      id: `run${d}`,
      startedAt: new Date(Date.now() - d * 86400_000).toISOString(),
      endedAt: new Date(Date.now() - d * 86400_000 + 6 * 60_000).toISOString(),
      status: d === 2 ? ('failed' as const) : ('succeeded' as const),
      agentId: 'c2b4e6f8-0000-4000-8000-00000000000' + d,
      output: d === 2 ? null : 'All 214 tests pass.',
      error: d === 2 ? 'Agent stopped: provider unavailable' : null,
    }));
  }
  async schedulePaused(id: string, paused: boolean) {
    const s = this.schedules.find((x) => x.id === id);
    if (s) s.status = paused ? 'paused' : 'active';
  }
  async scheduleRunOnce() {}
  async scheduleUpdate(id: string, changes: { name?: string; prompt?: string; cron?: string }) {
    const s = this.schedules.find((x) => x.id === id);
    if (!s) return;
    if (changes.name !== undefined) s.name = changes.name;
    if (changes.prompt !== undefined) s.prompt = changes.prompt;
    if (changes.cron !== undefined) s.cadence = { type: 'cron', expression: changes.cron };
  }
  async scheduleDelete(id: string) {
    this.schedules = this.schedules.filter((x) => x.id !== id);
  }
  agentTitle() {
    return undefined;
  }
}

export const demoPaseoSchedules = new DemoPaseoSchedules();

/** The demo's stand-in for the local model: canned ideas and builder drafts. */
export const demoAssist: AssistApi = {
  async complete(messages: AssistMessage[]) {
    if (messages[0]!.content.includes('JSON only')) {
      return JSON.stringify({
        name: 'Train delay alert',
        prompt:
          'Check my train line. If there are delays, send me a two-line alert with the ' +
          'cause and how long; otherwise reply [SILENT].',
        schedule: '0 7 * * 1-5',
        deliver: 'whatsapp',
        idea: 'Warns you about train delays before work, and stays quiet when trains run normally.',
        skills: [
          { name: 'watchers', why: 'reads the transit alerts feed' },
          { name: 'directions', why: 'live travel time to work if the trains are down' },
        ],
        tools: 'web',
        toolsWhy: 'it reads the transit alerts page',
        notes: 'Weekdays only; holidays will still run.',
      });
    }
    const name = messages[1]!.content.split('\n')[0]!.replace('Job name: ', '');
    return {
      'Morning briefing': 'Sends a short WhatsApp summary of your calendar, weather and urgent mail every morning.',
      'Price watch: flights to Lisbon': 'Checks fares to Lisbon daily and tells you only when a nonstop drops under $350.',
      'Weekly digest': 'Collects the week\'s AI-agent news with links every Monday.',
    }[name] ?? `Runs ${name} on its schedule and reports back.`;
  },
};
