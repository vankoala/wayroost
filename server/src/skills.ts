import { checkDeviceSignal, actionSignal } from './security/device-signal.js';
import type {
  MarketInstall,
  MarketPreview,
  MarketSearch,
  MarketSkill,
  SkillList,
  SkillScan,
} from '../../shared/skills.js';
import type { Dashboard } from './connectors/service.js';
import { UserFacingError } from './sources.js';
import { shadowBackground, type BackgroundGate } from './background.js';

// Settings → Skills: every agent's skills, kept the same everywhere. The helper (running
// as the Hermes user) reads the skill folders, spreads the shared folder (~/.agents/skills)
// to the apps that don't read it, and reports changes. The marketplace is Hermes' skills
// hub (skills.sh, GitHub, ClawHub, LobeHub, the official catalog…), through the dashboard's
// own /api/skills/hub routes: a hub install lands in Hermes, then is shared with every app.

const POLL_MS = 5_000;
const HUB_TIMEOUT_MS = 45_000;
const INSTALL_POLL_MS = 2_000;
const INSTALL_LIMIT_MS = 5 * 60_000;
const INSTALL_KEEP_MS = 30 * 60_000;

/** The helper's skills routes (see helper/signalbox-helper.py). */
export interface SkillsHelperApi {
  skills(): Promise<Omit<SkillList, 'installs'>>;
  skillsVersion(): Promise<number>;
  skillContent(place: string, name: string): Promise<{ name: string; place: string; text: string; truncated: boolean }>;
  skillScan(place: string, name: string): Promise<SkillScan>;
  skillShare(place: string, name: string, confirmCaution: boolean): Promise<{ shared: boolean; scan: SkillScan }>;
  skillTakeShared(place: string, name: string): Promise<void>;
  skillExcluded(name: string, place: string, excluded: boolean): Promise<void>;
  skillRemove(name: string): Promise<void>;
  skillsRefresh(): Promise<void>;
}

export interface SkillsDeps {
  background?: BackgroundGate;
  helper: SkillsHelperApi;
  /** Hermes' dashboard, for the marketplace (undefined before you sign in to Hermes). */
  dashboard: () => Dashboard | undefined;
  /** Tell open pages the skills changed. */
  changed: () => void;
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

async function hermesError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { detail?: unknown; error?: unknown };
  const detail = str(body.detail) ?? str(body.error);
  return detail ? detail.split('\n')[0]!.slice(0, 300) : fallback;
}

export class Skills {
  private readonly installs = new Map<string, MarketInstall>();
  private version = -1;
  private timer: NodeJS.Timeout | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly deps: SkillsDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? Date.now;
  }

  /** Watch the helper's change counter so open pages refresh by themselves. */
  start(): void {
    if ((this.deps.background ?? shadowBackground).role !== 'primary') return;
    const tick = async () => {
      try {
        const version = await this.deps.helper.skillsVersion();
        if (this.version !== -1 && version !== this.version) this.deps.changed();
        this.version = version;
      } catch {
        // The helper is down or restarting: the page shows that when it asks.
      }
      this.timer = setTimeout(tick, POLL_MS);
      this.timer.unref?.();
    };
    void tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  async list(): Promise<SkillList> {
    const listing = await this.deps.helper.skills();
    const cutoff = this.now() - INSTALL_KEEP_MS;
    for (const [id, job] of this.installs) if (job.state !== 'installing' && job.state !== 'sharing' && job.at < cutoff) this.installs.delete(id);
    return { ...listing, installs: [...this.installs.values()] };
  }

  content(place: string, name: string) {
    return this.deps.helper.skillContent(place, name);
  }

  scan(place: string, name: string): Promise<SkillScan> {
    return this.deps.helper.skillScan(place, name);
  }

  async share(place: string, name: string, confirmCaution: boolean): Promise<{ shared: boolean; scan: SkillScan }> {
    const result = await this.deps.helper.skillShare(place, name, confirmCaution);
    if (result.shared) this.deps.log.info({ name, place }, 'skill shared with every app');
    return result;
  }

  async takeShared(place: string, name: string): Promise<void> {
    await this.deps.helper.skillTakeShared(place, name);
    this.deps.log.info({ name, place }, 'shared skill put back');
  }

  async setExcluded(name: string, place: string, excluded: boolean): Promise<void> {
    await this.deps.helper.skillExcluded(name, place, excluded);
  }

  async remove(name: string): Promise<void> {
    await this.deps.helper.skillRemove(name);
    this.deps.log.info({ name }, 'skill removed from the shared folder');
  }

  async refresh(): Promise<void> {
    await this.deps.helper.skillsRefresh();
  }

  // ---- marketplace (Hermes' skills hub) ----------------------------------------

  private async hub<T>(method: string, path: string, body?: unknown, timeoutMs = HUB_TIMEOUT_MS): Promise<T> {
    const dashboard = this.deps.dashboard();
    if (!dashboard) throw new UserFacingError('Sign in to Hermes in Settings first: the marketplace is its skills hub.', 409);
    let res: Response;
    try {
      checkDeviceSignal();
      res = await dashboard.fetch(path, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
        signal: actionSignal(AbortSignal.timeout(timeoutMs)),
      });
    } catch {
      throw new UserFacingError("The skills hub didn't answer in time. Try again.", 504);
    }
    if (res.status === 404) throw new UserFacingError("The hub doesn't have that skill (any more).", 404);
    if (!res.ok) throw new UserFacingError(await hermesError(res, 'The skills hub refused that.'), res.status >= 500 ? 502 : 400);
    return (await res.json()) as T;
  }

  async search(query: string): Promise<MarketSearch> {
    const data = await this.hub<{ results?: Record<string, unknown>[]; timed_out?: unknown; installed?: Record<string, unknown> }>(
      'GET',
      `/api/skills/hub/search?q=${encodeURIComponent(query)}&limit=30`,
    );
    const installed = new Set(Object.keys(data.installed ?? {}));
    const results: MarketSkill[] = (data.results ?? []).flatMap((r) => {
      const identifier = str(r.identifier);
      if (!identifier) return [];
      return [
        {
          identifier,
          name: str(r.name) ?? identifier,
          description: (str(r.description) ?? '').slice(0, 600),
          source: str(r.source) ?? '',
          trust: str(r.trust_level) ?? 'community',
          ...(str(r.repo) ? { repo: r.repo as string } : {}),
          installed: installed.has(identifier),
        },
      ];
    });
    const timedOut = Array.isArray(data.timed_out) ? data.timed_out.filter((s): s is string => typeof s === 'string') : [];
    return { results, timedOut };
  }

  async preview(identifier: string): Promise<MarketPreview> {
    const p = await this.hub<Record<string, unknown>>('GET', `/api/skills/hub/preview?identifier=${encodeURIComponent(identifier)}`);
    return {
      identifier: str(p.identifier) ?? identifier,
      name: str(p.name) ?? identifier,
      description: str(p.description) ?? '',
      source: str(p.source) ?? '',
      trust: str(p.trust_level) ?? 'community',
      ...(str(p.repo) ? { repo: p.repo as string } : {}),
      skillMd: (str(p.skill_md) ?? '').slice(0, 200_000),
      files: Array.isArray(p.files) ? p.files.filter((f): f is string => typeof f === 'string').slice(0, 200) : [],
    };
  }

  async hubScan(identifier: string): Promise<SkillScan> {
    const s = await this.hub<Record<string, unknown>>('GET', `/api/skills/hub/scan?identifier=${encodeURIComponent(identifier)}`, undefined, 120_000);
    const policy = s.policy === 'allow' || s.policy === 'ask' || s.policy === 'block' ? s.policy : 'ask';
    return {
      verdict: str(s.verdict) ?? 'caution',
      policy,
      ...(str(s.summary) ? { summary: (s.summary as string).slice(0, 1000) } : {}),
      findings: (Array.isArray(s.findings) ? s.findings : []).slice(0, 30).map((f: Record<string, unknown>) => ({
        severity: str(f.severity) ?? 'low',
        category: str(f.category) ?? '',
        file: str(f.file) ?? '',
        line: typeof f.line === 'number' ? f.line : null,
        description: (str(f.description) ?? '').slice(0, 300),
      })),
    };
  }

  /**
   * Install a hub skill for every app: scan it, have Hermes install it (its installer
   * scans again and applies its own policy), then share Hermes' copy. Returns the scan
   * when it needs a second confirmation instead of installing.
   */
  async install(identifier: string, confirmCaution: boolean): Promise<{ started: boolean; scan: SkillScan }> {
    const running = this.installs.get(identifier);
    if (running && (running.state === 'installing' || running.state === 'sharing')) {
      throw new UserFacingError('That skill is already being installed.', 409);
    }
    const name = identifier.split('/').pop() ?? identifier;
    const current = await this.deps.helper.skills();
    if (current.skills.some((s) => s.name === name && s.places.shared)) {
      throw new UserFacingError(`You already have a shared skill called ${name}.`, 409);
    }
    const scan = await this.hubScan(identifier);
    if (scan.verdict === 'dangerous' || scan.policy === 'block') {
      throw new UserFacingError("The security scan blocked this skill, so it wasn't installed.", 422);
    }
    if ((scan.verdict !== 'safe' || scan.policy !== 'allow') && !confirmCaution) return { started: false, scan };
    const started = await this.hub<{ name?: unknown }>('POST', '/api/skills/hub/install', { identifier });
    const action = str(started.name);
    const job: MarketInstall = { identifier, name, state: 'installing', at: this.now() };
    this.installs.set(identifier, job);
    this.deps.log.info({ identifier }, 'installing a skill from the hub');
    this.deps.changed();
    void this.finishInstall(job, action, confirmCaution || scan.verdict !== 'safe');
    return { started: true, scan };
  }

  private async finishInstall(job: MarketInstall, action: string | undefined, confirmCaution: boolean): Promise<void> {
    const fail = (error: string) => {
      Object.assign(job, { state: 'failed', error, at: this.now() });
      this.deps.log.warn({ identifier: job.identifier, error }, 'hub skill install failed');
      this.deps.changed();
    };
    try {
      if (action) {
        const deadline = this.now() + INSTALL_LIMIT_MS;
        for (;;) {
          await this.sleep(INSTALL_POLL_MS);
          const status = await this.hub<{ running?: unknown; exit_code?: unknown; lines?: unknown }>(
            'GET',
            `/api/actions/${encodeURIComponent(action)}/status?lines=20`,
          );
          if (status.running !== true) {
            if (status.exit_code !== 0) {
              const lines = Array.isArray(status.lines) ? status.lines.filter((l): l is string => typeof l === 'string') : [];
              const last = lines.map((l) => l.trim()).filter((l) => l && !l.startsWith('===')).pop();
              return fail(last ? `Hermes couldn't install it: ${last.slice(0, 200)}` : "Hermes couldn't install it.");
            }
            break;
          }
          if (this.now() > deadline) return fail('The install took too long.');
        }
      }
      await this.deps.helper.skillsRefresh();
      const listing = await this.deps.helper.skills();
      const skill = listing.skills.find((s) => s.hub === job.identifier);
      if (!skill) return fail("Hermes finished, but the skill didn't show up in its folder.");
      Object.assign(job, { name: skill.name, state: 'sharing', at: this.now() });
      this.deps.changed();
      if (!skill.places.shared) {
        const shared = await this.deps.helper.skillShare('hermes', skill.name, confirmCaution);
        if (!shared.shared) return fail('Installed in Hermes, but the second scan asked for a check: share it from the list.');
      }
      Object.assign(job, { state: 'done', at: this.now() });
      this.deps.log.info({ identifier: job.identifier, name: job.name }, 'hub skill installed for every app');
      this.deps.changed();
    } catch (err) {
      fail(err instanceof UserFacingError ? err.message : 'Something went wrong while installing.');
    }
  }
}
