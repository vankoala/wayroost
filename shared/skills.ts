// Settings → Skills: every agent's skills on this PC, and the shared folder that keeps
// them the same. The helper (helper/signalbox_skills.py) reads and syncs the folders;
// the marketplace is Hermes' skills hub, through its dashboard.

/** One folder of skills. `source` is the shared folder; `mirror` gets every shared skill;
 *  `twins` only refreshes the shared skills it already has a copy of; `readonly` is listed only. */
export interface SkillPlace {
  id: string;
  label: string;
  mode: 'source' | 'mirror' | 'twins' | 'readonly';
  windows: boolean;
  exists: boolean;
}

export interface SkillApp {
  id: string;
  label: string;
  /** Place ids it reads, first wins on a name clash. */
  reads: string[];
  note: string;
}

/** How one app sees a skill. */
export type SkillAppState =
  | 'yes'             // it has the shared version (or its own skill)
  | 'updating'        // its copy is being brought up to date
  | 'edited'          // its copy was changed in that app: use it everywhere, or put the shared one back
  | 'missing'
  | 'off'             // switched off for that app
  | 'other-platform'; // the skill is for another OS

/** A copy's state in one folder. */
export type SkillCopyState = 'source' | 'same' | 'behind' | 'edited' | 'linked' | 'own';

export type SkillOrigin = 'shared' | 'hermes-hub' | 'hermes-bundled' | 'hermes-made' | 'claude-account' | 'app';

export interface SkillInfo {
  name: string;
  description: string;
  platforms: string[];
  origin: SkillOrigin;
  places: Record<string, { state: SkillCopyState; updatedAt: number }>;
  apps: Record<string, SkillAppState>;
  /** Mirror places this skill is switched off for. */
  excluded: string[];
  updatedAt: number;
  /** Hub identifier, for skills Hermes installed from its hub. */
  hub?: string;
}

export interface SkillEvent {
  at: number;
  kind: 'added' | 'changed' | 'removed' | 'synced' | 'shared' | 'reverted' | 'failed';
  name: string;
  place?: string;
  detail?: string;
}

export interface MarketInstall {
  identifier: string;
  name: string;
  state: 'installing' | 'sharing' | 'done' | 'failed';
  error?: string;
  at: number;
}

export interface SkillList {
  version: number;
  checkedAt: number;
  skills: SkillInfo[];
  places: SkillPlace[];
  apps: SkillApp[];
  events: SkillEvent[];
  installs: MarketInstall[];
}

export interface SkillScanFinding {
  severity: string;
  category: string;
  file: string;
  line: number | null;
  description: string;
}

export interface SkillScan {
  verdict: 'safe' | 'caution' | 'dangerous' | string;
  findings: SkillScanFinding[];
  /** Hub installs only: Hermes' install policy for this skill. */
  policy?: 'allow' | 'ask' | 'block';
  summary?: string;
}

export interface MarketSkill {
  identifier: string;
  name: string;
  description: string;
  source: string;
  trust: string;
  repo?: string;
  installed: boolean;
}

export interface MarketSearch {
  results: MarketSkill[];
  timedOut: string[];
}

export interface MarketPreview {
  identifier: string;
  name: string;
  description: string;
  source: string;
  trust: string;
  repo?: string;
  skillMd: string;
  files: string[];
}

export const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const SKILL_PLACE = /^[a-z][a-z-]{0,23}$/;
