import { BackgroundGate } from '../server/src/background.js';
// Demo data for Settings → Skills (scripts/ui-check.ts, npm run demo): a helper with a
// few skills in several apps, one changed inside Claude Code, and a stand-in skills hub.
import type { SkillApp, SkillInfo, SkillList, SkillPlace, SkillScan } from '../shared/skills.js';
import type { Dashboard } from '../server/src/connectors/service.js';
import { Skills, type SkillsHelperApi } from '../server/src/skills.js';

const now = Date.now();
const ago = (min: number) => now - min * 60_000;

const PLACES: SkillPlace[] = [
  { id: 'shared', label: 'Shared folder', mode: 'source', windows: false, exists: true },
  { id: 'claude', label: 'Claude Code', mode: 'mirror', windows: false, exists: true },
  { id: 'claude-account', label: 'Claude account', mode: 'readonly', windows: false, exists: true },
  { id: 'hermes', label: 'Hermes', mode: 'twins', windows: false, exists: true },
  { id: 'codex', label: 'Codex', mode: 'twins', windows: false, exists: true },
  { id: 'win-agents', label: 'Windows .agents', mode: 'mirror', windows: true, exists: true },
  { id: 'win-claude', label: 'Windows Claude Code', mode: 'mirror', windows: true, exists: true },
  { id: 'win-codex', label: 'Windows Codex', mode: 'twins', windows: true, exists: true },
  { id: 'win-hermes', label: 'Windows Hermes app', mode: 'twins', windows: true, exists: true },
];

const APPS: SkillApp[] = [
  { id: 'hermes', label: 'Hermes', reads: ['hermes', 'shared'], note: '' },
  { id: 'pi', label: 'pi', reads: ['shared'], note: '' },
  { id: 'claude', label: 'Claude Code', reads: ['claude', 'claude-account'], note: '' },
  { id: 'codex', label: 'Codex', reads: ['codex', 'shared'], note: '' },
  { id: 'opencode', label: 'OpenCode', reads: ['shared'], note: '' },
  { id: 'win-hermes', label: 'Hermes (Windows app)', reads: ['win-hermes', 'shared'], note: '' },
  { id: 'win-claude', label: 'Claude Code (Windows)', reads: ['win-claude'], note: '' },
  { id: 'win-codex', label: 'Codex (Windows)', reads: ['win-codex', 'win-agents'], note: '' },
];

const everywhere = { hermes: 'yes', pi: 'yes', claude: 'yes', codex: 'yes', opencode: 'yes', 'win-hermes': 'yes', 'win-claude': 'yes', 'win-codex': 'yes' } as const;

function demoList(): SkillInfo[] {
  return [
    {
      name: 'notes-to-report',
      description: 'Turn a question and a folder of notes into a short sourced report. Markdown by default; other formats on request.',
      platforms: [],
      origin: 'shared',
      places: {
        shared: { state: 'source', updatedAt: ago(90) },
        claude: { state: 'edited', updatedAt: ago(12) },
        'win-agents': { state: 'same', updatedAt: ago(90) },
        'win-claude': { state: 'same', updatedAt: ago(90) },
      },
      apps: { ...everywhere, claude: 'edited' },
      excluded: [],
      updatedAt: ago(12),
    },
    {
      name: 'trip-planner',
      description: 'Use when planning a trip: dates, routes and a short comparison of the options.',
      platforms: ['linux'],
      origin: 'shared',
      places: { shared: { state: 'source', updatedAt: ago(60 * 26) }, claude: { state: 'same', updatedAt: ago(60 * 26) } },
      apps: { ...everywhere, 'win-claude': 'other-platform', 'win-codex': 'other-platform' },
      excluded: [],
      updatedAt: ago(60 * 26),
    },
    {
      name: 'project-helper',
      description: 'Reference for organising projects, their workspaces and scripts.',
      platforms: [],
      origin: 'shared',
      places: {
        shared: { state: 'source', updatedAt: ago(60 * 80) },
        claude: { state: 'same', updatedAt: ago(60 * 80) },
        codex: { state: 'same', updatedAt: ago(60 * 80) },
        'win-agents': { state: 'behind', updatedAt: ago(1) },
        'win-claude': { state: 'same', updatedAt: ago(60 * 80) },
        'win-codex': { state: 'same', updatedAt: ago(60 * 80) },
      },
      apps: { ...everywhere, 'win-codex': 'updating' },
      excluded: ['win-claude'],
      updatedAt: ago(60 * 80),
    },
    {
      name: 'demo-meal-skill',
      description: 'Plans the meals for the week from what is already in the pantry.',
      platforms: [],
      origin: 'hermes-made',
      places: { hermes: { state: 'own', updatedAt: ago(200) } },
      apps: { hermes: 'yes', pi: 'missing', claude: 'missing', codex: 'missing', opencode: 'missing', 'win-hermes': 'missing', 'win-claude': 'missing', 'win-codex': 'missing' },
      excluded: [],
      updatedAt: ago(200),
    },
    {
      name: 'docx',
      description: 'Create, edit and review Word documents with tracked changes and comments.',
      platforms: [],
      origin: 'claude-account',
      places: { 'claude-account': { state: 'own', updatedAt: ago(60 * 48) } },
      apps: { hermes: 'missing', pi: 'missing', claude: 'yes', codex: 'missing', opencode: 'missing', 'win-hermes': 'missing', 'win-claude': 'missing', 'win-codex': 'missing' },
      excluded: [],
      updatedAt: ago(60 * 48),
    },
  ];
}

class DemoSkillsHelper implements SkillsHelperApi {
  version = 3;
  list = demoList();
  async skills(): Promise<Omit<SkillList, 'installs'>> {
    return {
      version: this.version,
      checkedAt: now,
      skills: this.list,
      places: PLACES,
      apps: APPS,
      events: [
        { at: ago(1), kind: 'synced', name: 'project-helper', place: 'win-agents' },
        { at: ago(12), kind: 'changed', name: 'notes-to-report', place: 'claude' },
        { at: ago(90), kind: 'changed', name: 'notes-to-report', place: 'shared' },
        { at: ago(200), kind: 'added', name: 'demo-meal-skill', place: 'hermes' },
        { at: ago(60 * 26), kind: 'added', name: 'trip-planner', place: 'shared' },
      ],
    };
  }
  async skillsVersion() {
    return this.version;
  }
  async skillContent(place: string, name: string) {
    return { name, place, text: `---\nname: ${name}\ndescription: Demo.\n---\n\n# ${name}\n\nSteps…\n`, truncated: false };
  }
  async skillScan(): Promise<SkillScan> {
    return { verdict: 'safe', findings: [] };
  }
  async skillShare(_place: string, name: string, confirmCaution: boolean) {
    if (name === 'demo-meal-skill' && !confirmCaution) {
      return {
        shared: false,
        scan: {
          verdict: 'caution',
          findings: [{ severity: 'medium', category: 'network', file: 'SKILL.md', line: 14, description: 'Fetches a URL with curl' }],
        },
      };
    }
    const s = this.list.find((x) => x.name === name);
    if (s) {
      s.origin = 'shared';
      s.places.shared = { state: 'source', updatedAt: Date.now() };
      s.apps = { ...everywhere };
    }
    this.version++;
    return { shared: true, scan: { verdict: 'safe', findings: [] } };
  }
  async skillTakeShared(_place: string, name: string) {
    const s = this.list.find((x) => x.name === name);
    if (s) {
      s.apps = { ...everywhere };
      for (const c of Object.values(s.places)) if (c.state === 'edited') c.state = 'same';
    }
    this.version++;
  }
  async skillExcluded(name: string, place: string, excluded: boolean) {
    const s = this.list.find((x) => x.name === name);
    if (s) s.excluded = excluded ? [...s.excluded, place] : s.excluded.filter((p) => p !== place);
    this.version++;
  }
  async skillRemove(name: string) {
    this.list = this.list.filter((s) => s.name !== name);
    this.version++;
  }
  async skillsRefresh() {}
}

const demoHub: Dashboard = {
  async fetch(path: string): Promise<Response> {
    const ok = (d: unknown) => new Response(JSON.stringify(d), { status: 200 });
    if (path.startsWith('/api/skills/hub/search')) {
      return ok({
        results: [
          { name: 'pdf-tools', description: 'Fill, merge, split and OCR PDF files.', source: 'skills-sh', identifier: 'skills-sh/acme/pdf-tools', trust_level: 'community', repo: 'acme/skills' },
          { name: 'pdf', description: 'Read and create PDF documents.', source: 'github', identifier: 'anthropics/skills/pdf', trust_level: 'trusted', repo: 'anthropics/skills' },
          { name: 'arxiv', description: 'Search and summarise arXiv papers.', source: 'official', identifier: 'official/research/arxiv', trust_level: 'builtin' },
        ],
        timed_out: [],
        installed: {},
      });
    }
    if (path.startsWith('/api/skills/hub/preview')) {
      return ok({
        name: 'pdf-tools', source: 'skills-sh', trust_level: 'community', repo: 'acme/skills',
        skill_md: '---\nname: pdf-tools\ndescription: Fill, merge, split and OCR PDF files.\n---\n\n# PDF tools\n\n1. Check qpdf is installed.\n2. …\n',
        files: ['SKILL.md', 'scripts/merge.py', 'scripts/ocr.sh'],
      });
    }
    if (path.startsWith('/api/skills/hub/scan')) {
      return ok({
        verdict: 'caution', policy: 'ask', summary: 'Runs shell scripts and downloads a binary on first use.',
        findings: [
          { severity: 'high', category: 'execution', file: 'scripts/ocr.sh', line: 8, description: 'Downloads and runs a binary' },
          { severity: 'medium', category: 'network', file: 'SKILL.md', line: 22, description: 'Calls an external API' },
        ],
      });
    }
    return new Response('{"detail":"not found"}', { status: 404 });
  },
};

export const demoSkills = new Skills({ background: new BackgroundGate('primary'),
  helper: new DemoSkillsHelper(),
  dashboard: () => demoHub,
  changed: () => {},
  log: { info() {}, warn() {} },
});
