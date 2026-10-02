import { beforeAll, describe, expect, it } from 'vitest';
import type { SkillInfo, SkillList, SkillScan } from '../../shared/skills.js';
import type { Dashboard } from '../src/connectors/service.js';
import { Skills, type SkillsHelperApi } from '../src/skills.js';
import { apiHeaders, makeApp, makeKeys, makeToken, postHeaders, type Keys } from './helpers.js';

// Settings → Skills: the helper's skill folders, and Hermes' skills hub as the marketplace.

const quietLog = { info() {}, warn() {} };

const skill = (name: string, places: SkillInfo['places'], extra: Partial<SkillInfo> = {}): SkillInfo => ({
  name,
  description: `Use when ${name}.`,
  platforms: [],
  origin: places.shared ? 'shared' : 'hermes-made',
  places,
  apps: {},
  excluded: [],
  updatedAt: 1,
  ...extra,
});

class FakeHelper implements SkillsHelperApi {
  calls: string[] = [];
  version = 1;
  shareVerdict: SkillScan['verdict'] = 'safe';
  list: SkillInfo[] = [skill('review-agent', { shared: { state: 'source', updatedAt: 1 }, claude: { state: 'same', updatedAt: 1 } })];
  async skills(): Promise<Omit<SkillList, 'installs'>> {
    return { version: this.version, checkedAt: 1, skills: this.list, places: [], apps: [], events: [] };
  }
  async skillsVersion() {
    return this.version;
  }
  async skillContent(place: string, name: string) {
    return { name, place, text: '---\nname: x\n---', truncated: false };
  }
  async skillScan(): Promise<SkillScan> {
    return { verdict: 'safe', findings: [] };
  }
  async skillShare(place: string, name: string, confirmCaution: boolean) {
    this.calls.push(`share ${place} ${name} ${confirmCaution}`);
    const ok = this.shareVerdict === 'safe' || confirmCaution;
    if (ok) {
      const s = this.list.find((x) => x.name === name);
      if (s) s.places.shared = { state: 'source', updatedAt: 2 };
    }
    return { shared: ok, scan: { verdict: this.shareVerdict, findings: [] } };
  }
  async skillTakeShared(place: string, name: string) {
    this.calls.push(`take ${place} ${name}`);
  }
  async skillExcluded(name: string, place: string, excluded: boolean) {
    this.calls.push(`excluded ${name} ${place} ${excluded}`);
  }
  async skillRemove(name: string) {
    this.calls.push(`remove ${name}`);
  }
  async skillsRefresh() {
    this.calls.push('refresh');
  }
}

class FakeHub implements Dashboard {
  calls: string[] = [];
  verdict = 'safe';
  policy = 'allow';
  runningPolls = 1;
  exitCode = 0;
  constructor(private readonly helper: FakeHelper) {}
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const method = init.method ?? 'GET';
    this.calls.push(`${method} ${path}`);
    const ok = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status });
    if (path.startsWith('/api/skills/hub/search')) {
      return ok({
        results: [
          { name: 'pdf-tools', description: 'PDFs.', source: 'skills-sh', identifier: 'skills-sh/acme/pdf-tools', trust_level: 'community' },
          { name: 'bad', description: 'no id' },
        ],
        timed_out: ['lobehub'],
        installed: { 'skills-sh/acme/pdf-tools': { name: 'pdf-tools' } },
      });
    }
    if (path.startsWith('/api/skills/hub/preview')) return ok({ name: 'pdf-tools', skill_md: '# PDF', files: ['SKILL.md'], trust_level: 'community' });
    if (path.startsWith('/api/skills/hub/scan')) {
      return ok({ verdict: this.verdict, policy: this.policy, findings: [{ severity: 'medium', category: 'network', file: 'SKILL.md', line: 3, description: 'curl' }] });
    }
    if (method === 'POST' && path === '/api/skills/hub/install') {
      return ok({ ok: true, pid: 1, name: 'skills-install-pdf-tools-1234abcd' });
    }
    if (path.startsWith('/api/actions/skills-install-pdf-tools-1234abcd/status')) {
      if (this.runningPolls-- > 0) return ok({ running: true, lines: [] });
      if (this.exitCode === 0) {
        this.helper.list.push(skill('pdf-tools', { hermes: { state: 'own', updatedAt: 3 } }, { origin: 'hermes-hub', hub: 'skills-sh/acme/pdf-tools' }));
      }
      return ok({ running: false, exit_code: this.exitCode, lines: ['=== started ===', 'Blocked by policy'] });
    }
    return ok({ detail: 'nope' }, 404);
  }
}

function make() {
  const helper = new FakeHelper();
  const hub = new FakeHub(helper);
  let changes = 0;
  const skills = new Skills({ helper, dashboard: () => hub, changed: () => changes++, log: quietLog, sleep: async () => {} });
  return { helper, hub, skills, changes: () => changes };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
async function until(check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i++) await settle();
}

describe('Skills', () => {
  it('maps hub search results and drops ones without an id', async () => {
    const { skills } = make();
    const found = await skills.search('pdf');
    expect(found.timedOut).toEqual(['lobehub']);
    expect(found.results).toEqual([
      { identifier: 'skills-sh/acme/pdf-tools', name: 'pdf-tools', description: 'PDFs.', source: 'skills-sh', trust: 'community', installed: true },
    ]);
  });

  it('asks again before installing a skill the scan is unsure about, then installs and shares it', async () => {
    const { skills, hub, helper, changes } = make();
    hub.verdict = 'caution';
    hub.policy = 'ask';
    const first = await skills.install('skills-sh/acme/pdf-tools', false);
    expect(first.started).toBe(false);
    expect(first.scan.findings[0]!.category).toBe('network');
    expect(hub.calls.some((c) => c.startsWith('POST /api/skills/hub/install'))).toBe(false);

    const second = await skills.install('skills-sh/acme/pdf-tools', true);
    expect(second.started).toBe(true);
    await until(() => (skills as unknown as { installs: Map<string, { state: string }> }).installs.get('skills-sh/acme/pdf-tools')?.state === 'done');
    const listing = await skills.list();
    expect(listing.installs).toMatchObject([{ identifier: 'skills-sh/acme/pdf-tools', name: 'pdf-tools', state: 'done' }]);
    expect(helper.calls).toContain('share hermes pdf-tools true');
    expect(changes()).toBeGreaterThanOrEqual(2);
  });

  it('refuses blocked skills and names already shared', async () => {
    const { skills, hub, helper } = make();
    hub.verdict = 'dangerous';
    await expect(skills.install('skills-sh/acme/pdf-tools', true)).rejects.toThrow(/blocked/);
    await expect(skills.install('official/x/review-agent', true)).rejects.toThrow(/already have a shared skill/);
    hub.verdict = 'safe';
    hub.policy = 'block';
    await expect(skills.install('skills-sh/acme/pdf-tools', true)).rejects.toThrow(/blocked/);
    expect(helper.calls).toEqual([]);
  });

  it('reports a failed Hermes install with its last log line', async () => {
    const { skills, hub } = make();
    hub.exitCode = 1;
    await skills.install('skills-sh/acme/pdf-tools', false);
    const installs = (skills as unknown as { installs: Map<string, { state: string; error?: string }> }).installs;
    await until(() => installs.get('skills-sh/acme/pdf-tools')?.state === 'failed');
    expect(installs.get('skills-sh/acme/pdf-tools')?.error).toBe("Hermes couldn't install it: Blocked by policy");
  });

  it('needs Hermes for the marketplace', async () => {
    const helper = new FakeHelper();
    const skills = new Skills({ helper, dashboard: () => undefined, changed: () => {}, log: quietLog });
    await expect(skills.search('x')).rejects.toThrow(/Sign in to Hermes/);
    expect((await skills.list()).skills).toHaveLength(1);
  });
});

describe('app: /api/skills', () => {
  let keys: Keys;
  let token: string;
  beforeAll(async () => {
    keys = await makeKeys();
    token = await makeToken(keys);
  });

  it('lists, shares, switches off, puts back, removes and searches', async () => {
    const { skills, helper } = make();
    const { app } = await makeApp(keys, { skills });
    const post = (url: string, body: unknown, method: 'POST' | 'PUT' = 'POST') =>
      app.inject({ method, url, headers: postHeaders(token), payload: JSON.stringify(body) });

    const list = await app.inject({ url: '/api/skills', headers: apiHeaders(token) });
    expect(list.statusCode).toBe(200);
    expect(list.json().skills[0].name).toBe('review-agent');

    expect((await post('/api/skills/share', { place: 'hermes', name: 'review-agent' })).json().shared).toBe(true);
    expect((await post('/api/skills/excluded', { name: 'review-agent', place: 'win-claude', excluded: true }, 'PUT')).statusCode).toBe(200);
    expect((await post('/api/skills/take-shared', { place: 'claude', name: 'review-agent' })).statusCode).toBe(200);
    expect((await post('/api/skills/remove', { name: 'review-agent' })).statusCode).toBe(200);
    expect(helper.calls).toEqual([
      'share hermes review-agent false',
      'excluded review-agent win-claude true',
      'take claude review-agent',
      'remove review-agent',
    ]);

    const content = await app.inject({ url: '/api/skills/content?place=shared&name=review-agent', headers: apiHeaders(token) });
    expect(content.json().text).toContain('name: x');
    const search = await app.inject({ url: '/api/skills/market?q=pdf', headers: apiHeaders(token) });
    expect(search.json().results).toHaveLength(1);
  });

  it('rejects bad names, folders and ids', async () => {
    const { skills, helper } = make();
    const { app } = await makeApp(keys, { skills });
    const post = (url: string, body: unknown) => app.inject({ method: 'POST', url, headers: postHeaders(token), payload: JSON.stringify(body) });
    expect((await post('/api/skills/share', { place: 'hermes', name: '../etc' })).statusCode).toBe(400);
    expect((await post('/api/skills/share', { place: '/root', name: 'x' })).statusCode).toBe(400);
    expect((await post('/api/skills/market/install', { identifier: '../../x y' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/skills/content?place=shared&name=.hidden', headers: apiHeaders(token) })).statusCode).toBe(400);
    expect(helper.calls).toEqual([]);
  });

  it('is off without the helper', async () => {
    const { app } = await makeApp(keys);
    expect((await app.inject({ url: '/api/skills', headers: apiHeaders(token) })).statusCode).toBe(404);
  });
});
